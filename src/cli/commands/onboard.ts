import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRuntime } from "../../app/runtime.ts";
import type { GraphEdge } from "../../core/capabilities/contracts.ts";
import { repoIdOf, updateGraph } from "../../knowledge/graph/update.ts";
import { mapModule, taskFor } from "../../onboarding/deep.ts";
import {
  applyCommands,
  ONBOARD_MARKER,
  renderArchitecture,
  renderConventions,
} from "../../onboarding/render.ts";
import { type ScanReport, scanProject } from "../../onboarding/scan.ts";
import { git } from "../../tools/local/exec.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT } from "../output.ts";
import { loadForCli } from "./config.ts";

/**
 * `jarvis onboard` (quick mode): a scan of the repository — no model — that proposes `tools.local`
 * commands and writes short factual skeletons into `.jarvis/knowledge/`. Nothing a human wrote is
 * overwritten: a file is replaced only while it still carries the generated marker.
 */
export interface OnboardOptions {
  readonly dryRun?: boolean;
  readonly refresh?: boolean;
  readonly applyConfig?: boolean;
  readonly graph?: boolean;
  /** Agent mode (prototype): map this one module with the onboard-mapper agent. */
  readonly module?: string;
}

type FileAction = "created" | "refreshed" | "kept (edited by a human)" | "would create" | "would refresh";

export async function runOnboard(ctx: CliContext, options: OnboardOptions): Promise<void> {
  const loaded = await loadForCli(ctx);
  const root = loaded.project?.root ?? ctx.cwd;
  const inRepo = await git(["rev-parse", "--is-inside-work-tree"], root);
  if (inRepo.code !== 0) {
    ctx.out.error("jarvis onboard needs a git repository (the scan reads tracked files and history)");
    throw new CliExit(EXIT.error);
  }

  let graph: { edges: GraphEdge[]; nodes: number } | undefined;
  let graphReason: string | undefined;
  if (options.graph !== false) {
    const runtime = createRuntime(loaded, { env: ctx.env });
    try {
      const extractors = runtime.capabilities
        .list()
        .map((a) => a.graphExtractor?.())
        .filter((e) => e !== undefined);
      if (extractors.length === 0) graphReason = "no language adapter with a project graph for this stack";
      else {
        const result = await updateGraph({
          workspace: root,
          repoId: repoIdOf(root),
          cacheRoot: loaded.home.cacheDir,
          extractors,
          store: runtime.graph,
        });
        graph = { edges: [...result.snapshot.edges], nodes: result.snapshot.nodes.length };
      }
    } catch (error) {
      graphReason = error instanceof Error ? error.message : String(error);
    } finally {
      await runtime.close();
    }
  } else graphReason = "skipped (--no-graph)";

  const report = await scanProject({ root, graph, ...(graphReason ? { graphReason } : {}) });

  if (options.module !== undefined) {
    await runModuleMap(ctx, loaded, root, report, options);
    return;
  }

  const knowledgeDir = join(root, ".jarvis", "knowledge");
  const files: Array<{ path: string; action: FileAction }> = [];
  const write = (name: string, content: string) => {
    const path = join(knowledgeDir, name);
    let action: FileAction;
    if (!existsSync(path)) action = options.dryRun ? "would create" : "created";
    else if (options.refresh && readFileSync(path, "utf8").includes(ONBOARD_MARKER))
      action = options.dryRun ? "would refresh" : "refreshed";
    else action = "kept (edited by a human)";
    if (!options.dryRun && (action === "created" || action === "refreshed")) {
      mkdirSync(knowledgeDir, { recursive: true });
      writeFileSync(path, content, "utf8");
    }
    files.push({ path: `.jarvis/knowledge/${name}`, action });
  };
  write("architecture.md", renderArchitecture(report));
  write("conventions.md", renderConventions(report));

  let configApplied = false;
  const configPath = loaded.project?.configFile;
  if (options.applyConfig && configPath && existsSync(configPath)) {
    const current = readFileSync(configPath, "utf8");
    const next = applyCommands(current, report.commands);
    configApplied = next.applied;
    if (next.applied && !options.dryRun) writeFileSync(configPath, next.text, "utf8");
  }

  ctx.out.result({ ...report, files, configApplied }, () => {
    ctx.out.line(
      `${report.files} files, ~${report.lines} lines; stacks: ${report.stacks.join(", ") || "none detected"}${report.packageManager ? `; ${report.packageManager}` : ""}`,
    );
    const source = report.modules.filter((m) => m.role === "source");
    ctx.out.line(
      `modules: ${source
        .slice(0, 8)
        .map((m) => `${m.path} (${m.lines})`)
        .join(", ")}${source.length > 8 ? ` … +${source.length - 8}` : ""}`,
    );
    ctx.out.line(
      report.graph.available
        ? `graph: ${report.graph.nodes} nodes, ${report.graph.edges} edges`
        : `graph: unavailable — ${report.graph.reason ?? "no adapter"}`,
    );
    ctx.out.line(
      `tests: ${report.tests.files} files (${report.tests.layout}); frameworks: ${report.tooling.testFrameworks.join(", ") || "none detected"}`,
    );
    ctx.out.line(`docs found: ${report.docs.length}; CI: ${report.tooling.ci.join(", ") || "none"}`);
    ctx.out.line();
    if (report.commands.length > 0) {
      ctx.out.line(
        configApplied
          ? "tools.local written to .jarvis/project.yaml:"
          : "suggested tools.local for .jarvis/project.yaml (--apply-config fills an empty one):",
      );
      for (const c of report.commands)
        ctx.out.line(`  ${c.name}: ${JSON.stringify(c.command)}   # ${c.source}`);
    } else ctx.out.line("no project commands detected: set tools.local by hand (tests, typecheck, lint)");
    if (report.sensitivePaths.length > 0) {
      ctx.out.line();
      ctx.out.line("sensitive-looking paths — consider security.deniedPaths:");
      ctx.out.line(`  deniedPaths: [${report.sensitivePaths.map((p) => JSON.stringify(p)).join(", ")}]`);
    }
    ctx.out.line();
    for (const f of files) ctx.out.line(`${f.action.padEnd(24)} ${f.path}`);
    ctx.out.line();
    ctx.out.line(
      "next: describe in architecture.md what each module is for, add glossary.md and standards (see .jarvis/*/README.md)",
    );
  });
}

/** `jarvis onboard --module <path>`: the agent maps one module; the result waits as a knowledge candidate. */
async function runModuleMap(
  ctx: CliContext,
  loaded: Awaited<ReturnType<typeof loadForCli>>,
  root: string,
  report: ScanReport,
  options: OnboardOptions,
): Promise<void> {
  const module = (options.module ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const facts = report.modules.find((m) => m.path === module);
  if (!facts) {
    const known = report.modules
      .filter((m) => m.role === "source")
      .slice(0, 12)
      .map((m) => m.path);
    ctx.out.error(
      `"${module}" is not a module of this repository${known.length > 0 ? `; modules: ${known.join(", ")}` : ""}`,
    );
    throw new CliExit(EXIT.error);
  }
  if (options.dryRun) {
    ctx.out.result({ module, task: taskFor(module, facts), facts, wouldRun: "onboard-module" }, () => {
      ctx.out.line(`would run the onboard-mapper agent on ${module}:`);
      ctx.out.line(taskFor(module, facts));
    });
    return;
  }
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const result = await mapModule(runtime, { root, module, facts, env: ctx.env });
    ctx.out.result(result, () => {
      ctx.out.line(`run ${result.runId || "-"}: ${result.state}`);
      ctx.out.line(`claims confirmed against the code: ${result.claims.kept} of ${result.claims.proposed}`);
      for (const d of result.dropped) ctx.out.line(`  dropped ${d.section} "${d.what}": ${d.why}`);
      if (result.problem) ctx.out.line(result.problem);
      if (result.candidateId) {
        ctx.out.line();
        ctx.out.line(`candidate ${result.candidateId} (knowledge, paths: ${module}/**)`);
        ctx.out.line(
          `review: jarvis candidates list; accept: jarvis candidates promote ${result.candidateId} --id module-${module.replace(/[^\w-]+/g, "-")}`,
        );
      }
    });
    if (result.problem && !result.candidateId) throw new CliExit(EXIT.error);
  } finally {
    await runtime.close();
  }
}
