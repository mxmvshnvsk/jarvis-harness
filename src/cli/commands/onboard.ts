import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRuntime } from "../../app/runtime.ts";
import type { GraphEdge, GraphNode } from "../../core/capabilities/contracts.ts";
import { missingChecks } from "../../core/config/requiredChecks.ts";
import { layoutOf, rootRelative } from "../../core/paths.ts";
import { codeContractsOf } from "../../design/codeContracts.ts";
import { mapEntriesOf, snapshotMapsIn } from "../../design/contracts.ts";
import {
  CONTRACTS_FILE,
  serviceContractsOf,
  springConfigOf,
  withMapEndpoints,
} from "../../knowledge/catalog.ts";
import { checkKnowledge, type DocCheck } from "../../knowledge/docCheck.ts";
import { changedSinceCode, codeAtOf } from "../../knowledge/freshness.ts";
import { parseFrontMatter } from "../../knowledge/frontmatter.ts";
import { repoIdOf, updateGraph } from "../../knowledge/graph/update.ts";
import { knowledgeRootsOf } from "../../knowledge/sources.ts";
import { mapModule, NOTE_MAX, taskFor } from "../../onboarding/deep.ts";
import { declaredPublishes, librariesOf, libraryOf, usesOf } from "../../onboarding/library.ts";
import {
  applyCommands,
  ONBOARD_MARKER,
  renderArchitecture,
  renderContracts,
  renderConventions,
} from "../../onboarding/render.ts";
import { type ScanReport, scanProject, scopeFacts, trackedFiles } from "../../onboarding/scan.ts";
import { type FilledEntry, fillServiceEntry, kindOf } from "../../onboarding/serviceEntry.ts";
import { TOO_BIG } from "../../onboarding/tree.ts";
import { git } from "../../tools/local/exec.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT } from "../output.ts";
import { followRun } from "../progress.ts";
import { nameOf } from "./candidates.ts";
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
  /** With `module`: what matters to the person who asked, added to the agent's task. */
  readonly note?: string;
  /** In a knowledge repository: only this service of the map (ADR-0025). */
  readonly service?: string;
  /** With `module`: map it in one pass even when it is bigger than one pass covers well. */
  readonly whole?: boolean;
  /** Map again the generated module documents the code moved on from (`jarvis knowledge check`). */
  readonly stale?: boolean;
}

type FileAction =
  | "created"
  | "refreshed"
  | "kept (edited by a human)"
  | "kept (--refresh regenerates it)"
  | "would create"
  | "would refresh";

export async function runOnboard(ctx: CliContext, options: OnboardOptions): Promise<void> {
  const loaded = await loadForCli(ctx);
  // the knowledge repository itself: its services, each in its repository (ADR-0025 §1)
  if (loaded.meta && !loaded.meta.service) return runOnboardServices(ctx, loaded.meta, options);
  if (options.service && loaded.meta?.service && options.service !== loaded.meta.service) {
    ctx.out.error(
      `this repository is the service ${loaded.meta.service}, not ${options.service}: run it in the knowledge repository, or in ${options.service}'s`,
    );
    throw new CliExit(EXIT.error);
  }
  const root = loaded.project?.root ?? ctx.cwd;
  const inRepo = await git(["rev-parse", "--is-inside-work-tree"], root);
  if (inRepo.code !== 0) {
    ctx.out.error("jarvis onboard needs a git repository (the scan reads tracked files and history)");
    throw new CliExit(EXIT.error);
  }

  let graph: { edges: GraphEdge[]; nodes: number; all: GraphNode[] } | undefined;
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
        graph = {
          edges: [...result.snapshot.edges],
          nodes: result.snapshot.nodes.length,
          all: [...result.snapshot.nodes],
        };
      }
    } catch (error) {
      graphReason = error instanceof Error ? error.message : String(error);
    } finally {
      await runtime.close();
    }
  } else graphReason = "skipped (--no-graph)";

  const report = await scanProject({ root, graph, ...(graphReason ? { graphReason } : {}) });

  if (options.module !== undefined) {
    await runModuleMap(ctx, loaded, root, report, options, graph);
    return;
  }
  if (options.stale) {
    await runStaleMaps(ctx, loaded, root, report, options, graph);
    return;
  }

  // a service of a knowledge repository: its folder there (ADR-0025 §1)
  const knowledgeDir = layoutOf(root).knowledgeDir;
  const files: Array<{ path: string; action: FileAction }> = [];
  const write = (name: string, content: string) => {
    const path = join(knowledgeDir, name);
    let action: FileAction;
    if (!existsSync(path)) action = options.dryRun ? "would create" : "created";
    else if (!readFileSync(path, "utf8").includes(ONBOARD_MARKER)) action = "kept (edited by a human)";
    // still jarvis's (the marker is there): regenerated only when asked
    else if (options.refresh) action = options.dryRun ? "would refresh" : "refreshed";
    else action = "kept (--refresh regenerates it)";
    if (!options.dryRun && (action === "created" || action === "refreshed")) {
      mkdirSync(knowledgeDir, { recursive: true });
      writeFileSync(path, content, "utf8");
    }
    files.push({ path: rootRelative(root, path), action });
  };
  const contracts = graph ? codeContractsOf(graph.all) : undefined;
  write("architecture.md", renderArchitecture(report, contracts));
  write("conventions.md", renderConventions(report));
  const contractsDoc = contracts ? renderContracts(contracts) : undefined;
  if (contractsDoc) write("contracts.md", contractsDoc);
  // a service of a knowledge repository: the machine part the catalog links services by (ADR-0025 §4) —
  // always the code's, a person does not edit it
  const service = loaded.meta?.service;
  if (contracts && service) {
    const tracked = await trackedFiles(root);
    const head = (await git(["rev-parse", "HEAD"], root)).stdout.trim();
    // and what its maps say (a BFF's routes and backends live in a map, not in code)
    const maps = loaded.config.contracts.length > 0 ? loaded.config.contracts : snapshotMapsIn(tracked);
    const fromMaps = mapEntriesOf(root, maps);
    const doc = withMapEndpoints(
      serviceContractsOf(service, contracts, springConfigOf(root, tracked), head || undefined),
      fromMaps.entries,
    );
    if (fromMaps.files.length > 0 && !ctx.out.json)
      ctx.out.line(`contract maps read: ${fromMaps.files.join(", ")}`);
    const path = join(knowledgeDir, CONTRACTS_FILE);
    const action: FileAction = existsSync(path)
      ? options.dryRun
        ? "would refresh"
        : "refreshed"
      : options.dryRun
        ? "would create"
        : "created";
    if (!options.dryRun) {
      mkdirSync(knowledgeDir, { recursive: true });
      writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    }
    files.push({ path: rootRelative(root, path), action });
  }

  let configApplied = false;
  const configPath = loaded.project?.configFile;
  if (options.applyConfig && configPath && existsSync(configPath) && !service) {
    const current = readFileSync(configPath, "utf8");
    const next = applyCommands(current, report.commands);
    configApplied = next.applied;
    if (next.applied && !options.dryRun) writeFileSync(configPath, next.text, "utf8");
  }
  // a service: its kind and commands into its entry of the map, where nothing is set (ADR-0025 §2)
  let entry: FilledEntry | undefined;
  if (service && configPath && existsSync(configPath)) {
    // a library: it changes first in a task across services, and is published for the others' builds;
    // the services that depend on it — by the names the map's libraries publish
    const library = libraryOf(root);
    const others = Object.fromEntries(
      Object.entries(loaded.meta?.repos ?? {}).filter(([name]) => name !== service),
    );
    const uses = usesOf(root, librariesOf(others, declaredPublishes(readFileSync(configPath, "utf8"))));
    const kind = library ? "library" : kindOf(report.stacks);
    entry = fillServiceEntry(readFileSync(configPath, "utf8"), service, {
      ...(kind ? { kind } : {}),
      commands: [
        ...report.commands,
        ...(library ? [{ name: "publish-local", command: library.publishLocal }] : []),
      ],
      ...(library ? { publishes: library.publishes } : {}),
      ...(uses.length > 0 ? { uses } : {}),
    });
    if (entry.added.length > 0 && !options.dryRun) writeFileSync(configPath, entry.text, "utf8");
  }

  // the checks the service must have (tools.required) that neither its configuration nor the scan has
  const unmet = missingChecks(loaded.config.tools.required, [
    ...Object.keys(loaded.config.tools.local),
    ...report.commands.map((c) => c.name),
  ]);
  ctx.out.result(
    {
      ...report,
      files,
      configApplied,
      ...(entry ? { map: { added: entry.added, kept: entry.kept } } : {}),
      ...(unmet.length > 0 ? { unmet } : {}),
    },
    () => {
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
      if (service && entry) {
        const where = `services.${service} in ${rootRelative(ctx.cwd, configPath as string)}`;
        if (entry.added.length > 0)
          ctx.out.line(`${options.dryRun ? "would add to" : "added to"} ${where}: ${entry.added.join(", ")}`);
        else ctx.out.line(`${where}: nothing new`);
        for (const c of report.commands)
          ctx.out.line(`  ${c.name}: ${JSON.stringify(c.command)}   # ${c.source}`);
        if (entry.kept.length > 0) ctx.out.line(`  kept as set: ${entry.kept.join(", ")}`);
        if (unmet.length > 0)
          ctx.out.line(
            `  required with no command: ${unmet.join(", ")} — set services.${service}.tools.local by hand, or drop it from tools.required`,
          );
      } else if (report.commands.length > 0) {
        ctx.out.line(
          configApplied
            ? "tools.local written to .jarvis/project.yaml:"
            : "suggested tools.local for .jarvis/project.yaml (--apply-config fills an empty one):",
        );
        for (const c of report.commands)
          ctx.out.line(`  ${c.name}: ${JSON.stringify(c.command)}   # ${c.source}`);
      } else
        ctx.out.line(
          `no project commands detected: set tools.local by hand (${loaded.config.tools.required.join(", ")})`,
        );
      if (report.sensitivePaths.length > 0) {
        ctx.out.line();
        ctx.out.line("sensitive-looking paths — consider security.deniedPaths:");
        ctx.out.line(`  deniedPaths: [${report.sensitivePaths.map((p) => JSON.stringify(p)).join(", ")}]`);
      }
      ctx.out.line();
      for (const f of files) ctx.out.line(`${f.action.padEnd(24)} ${f.path}`);
      ctx.out.line();
      ctx.out.line(
        service
          ? `next: describe in ${rootRelative(root, join(knowledgeDir, "architecture.md"))} what each module is for; commit in the knowledge repository`
          : "next: describe in architecture.md what each module is for, add glossary.md and standards (see .jarvis/*/README.md)",
      );
    },
  );
}

/**
 * `jarvis onboard` in a knowledge repository: the quick scan in each service's repository of the map
 * (or `--service`), as if run there; the knowledge repository's own files are not scanned. A
 * repository missing on this machine, or with a `.jarvis/` of its own, is skipped and said.
 */
async function runOnboardServices(
  ctx: CliContext,
  meta: {
    readonly root: string;
    readonly configFile: string;
    readonly repos: Readonly<Record<string, string>>;
  },
  options: OnboardOptions,
): Promise<void> {
  if (options.module !== undefined) {
    ctx.out.error("--module maps a module of a service: run it in the service's repository");
    throw new CliExit(EXIT.error);
  }
  const names = Object.keys(meta.repos).sort();
  if (options.service && !meta.repos[options.service]) {
    ctx.out.error(
      `${options.service} is not a service of the map (${names.join(", ") || "none"}) — add it under services in ${meta.configFile}`,
    );
    throw new CliExit(EXIT.error);
  }
  if (names.length === 0) {
    ctx.out.error(
      `no services in ${meta.configFile}: add them under services (jarvis init --knowledge drafts the map)`,
    );
    throw new CliExit(EXIT.error);
  }
  const done: string[] = [];
  const skipped: string[] = [];
  for (const name of options.service ? [options.service] : names) {
    const path = meta.repos[name] as string;
    const at = rootRelative(meta.root, path);
    if (!existsSync(path)) {
      skipped.push(
        `${name}: no repository at ${at} — repos.${name} in the personal config when it lies elsewhere`,
      );
      continue;
    }
    if (existsSync(join(path, ".jarvis", "project.yaml"))) {
      skipped.push(`${name}: ${at} has a .jarvis/ of its own — it works on its own until that is removed`);
      continue;
    }
    if (!ctx.out.json) {
      ctx.out.line(`== ${name} (${at})`);
    }
    try {
      await runOnboard({ ...ctx, cwd: path }, { ...options, service: name });
      done.push(name);
    } catch (error) {
      skipped.push(
        `${name}: ${error instanceof CliExit ? "failed (see above)" : error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!ctx.out.json) ctx.out.line();
  }
  if (ctx.out.json) return;
  ctx.out.line(
    `onboarded ${done.length} of ${options.service ? 1 : names.length}: ${done.join(", ") || "none"}`,
  );
  for (const s of skipped) ctx.out.line(`  skipped ${s}`);
  if (done.length > 0)
    ctx.out.line("next: jarvis knowledge links shows how they are linked; commit knowledge/ here");
  if (done.length === 0) throw new CliExit(EXIT.error);
}

/** Why a generated map is mapped again, for the person and as the mapper's note. */
export function staleReasons(d: DocCheck): string[] {
  return [
    ...(d.staleCommits ? [`${d.staleCommits} commit(s) under its paths since it was mapped`] : []),
    ...(d.lost.length > 0 ? [`${d.lost.length} quoted line(s) gone from the code`] : []),
    ...(d.missingPaths.length > 0 ? [`${d.missingPaths.length} path(s) it names are gone`] : []),
    ...(d.language ? [`written in ${d.language.found}, the team's language is ${d.language.expected}`] : []),
  ];
}

/**
 * The mapper's note for a module mapped again: what the old document said it was for, what changed
 * in the code since, what of it is gone — so it describes the module as it is now, not from scratch
 * blind to what moved (pilot: a form rewritten in one merge, its map describing folders that were gone).
 */
export function remapNote(input: {
  readonly doc: string;
  readonly text: string;
  readonly reasons: readonly string[];
  readonly changed: readonly string[];
  readonly lost: DocCheck["lost"];
}): string {
  const purpose = input.text
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !l.startsWith(">"));
  const at = codeAtOf(input.text);
  return [
    `Map it again: ${input.doc}${at ? ` was made at ${at.commit.slice(0, 12)}${at.branch ? ` (${at.branch})` : ""}` : ""} and ${input.reasons.join("; ")}.`,
    ...(purpose ? [`What it said the module is for: ${purpose.slice(0, 400)}`] : []),
    ...(input.changed.length > 0 ? [`Files changed since: ${input.changed.join(", ")}.`] : []),
    ...(input.lost.length > 0
      ? [
          `Quoted lines no longer in the code: ${input.lost
            .slice(0, 8)
            .map((l) => `${l.ref} \`${l.text.slice(0, 80)}\``)
            .join("; ")}.`,
        ]
      : []),
    "Describe the module as the code is now.",
  ]
    .join("\n")
    .slice(0, NOTE_MAX);
}

/** `jarvis onboard --stale`: maps again, one by one, the generated module documents the code moved on from. */
async function runStaleMaps(
  ctx: CliContext,
  loaded: Awaited<ReturnType<typeof loadForCli>>,
  root: string,
  report: ScanReport,
  options: OnboardOptions,
  graph?: { edges: readonly GraphEdge[] },
): Promise<void> {
  const check = await checkKnowledge(knowledgeRootsOf(loaded, root), {
    language: loaded.config.language,
    tree: false,
  });
  const todo: Array<{ module: string; doc: string; reasons: string[]; note: string }> = [];
  for (const d of check.docs) {
    if (!d.generated) continue;
    const reasons = staleReasons(d);
    if (reasons.length === 0) continue;
    const text = readFileSync(join(root, d.doc), "utf8");
    const paths = parseFrontMatter(text).data.paths;
    const module =
      Array.isArray(paths) && paths.length === 1 && typeof paths[0] === "string"
        ? (paths[0] as string).replace(/\/\*\*$/, "")
        : undefined;
    if (!module || module.includes("*")) continue;
    const at = codeAtOf(text);
    const changed = at ? await changedSinceCode(root, at.commit, [`${module}/**`], 30) : [];
    todo.push({
      module,
      doc: d.doc,
      reasons,
      note: remapNote({ doc: d.doc, text, reasons, changed, lost: d.lost }),
    });
  }
  if (todo.length === 0) {
    ctx.out.result({ stale: [] }, () =>
      ctx.out.line("every generated module document is as fresh as its code"),
    );
    return;
  }
  if (options.dryRun) {
    ctx.out.result({ stale: todo }, () => {
      ctx.out.line(`would map again ${todo.length} module(s):`);
      for (const t of todo) ctx.out.line(`  ${t.module} ${ctx.out.style.muted(`— ${t.reasons.join("; ")}`)}`);
    });
    return;
  }
  let failed = 0;
  for (const t of todo) {
    if (!ctx.out.json) ctx.out.line(`== ${t.module} (${t.reasons.join("; ")})`);
    try {
      await runModuleMap(
        ctx,
        loaded,
        root,
        report,
        { ...options, module: t.module, note: t.note, whole: true },
        graph,
      );
    } catch (error) {
      failed += 1;
      if (!(error instanceof CliExit)) ctx.out.error(error instanceof Error ? error.message : String(error));
    }
  }
  if (!ctx.out.json)
    ctx.out.line(
      `mapped again ${todo.length - failed} of ${todo.length}; accept each with jarvis candidates promote — it replaces the old document`,
    );
  if (failed > 0) throw new CliExit(EXIT.error);
}

/** A folder's parts for mapping one at a time: its subfolders (and its own files), biggest first. */
export function partsOf(tracked: readonly string[], module: string): Array<{ path: string; files: number }> {
  const counts = new Map<string, number>();
  const prefix = `${module}/`;
  for (const f of tracked) {
    if (!f.startsWith(prefix)) continue;
    const rest = f.slice(prefix.length);
    const slash = rest.indexOf("/");
    const part = slash < 0 ? module : `${module}/${rest.slice(0, slash)}`;
    counts.set(part, (counts.get(part) ?? 0) + 1);
  }
  return [...counts]
    .filter(([path]) => path !== module)
    .map(([path, files]) => ({ path, files }))
    .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path));
}

/** `jarvis onboard --module <path>`: the agent maps one module; the result waits as a knowledge candidate. */
async function runModuleMap(
  ctx: CliContext,
  loaded: Awaited<ReturnType<typeof loadForCli>>,
  root: string,
  report: ScanReport,
  options: OnboardOptions,
  graph?: { edges: readonly GraphEdge[] },
): Promise<void> {
  const module = (options.module ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  // a module, or a directory inside one (a package of a monorepo is too big for one pass)
  const facts =
    report.modules.find((m) => m.path === module) ??
    (module !== "" && report.modules.some((m) => m.role === "source" && module.startsWith(`${m.path}/`))
      ? await scopeFacts(root, module, graph)
      : undefined);
  if (!facts) {
    const known = report.modules
      .filter((m) => m.role === "source")
      .slice(0, 12)
      .map((m) => m.path);
    ctx.out.error(
      `"${module}" is not a module of this repository or a directory inside one${known.length > 0 ? `; modules: ${known.join(", ")}` : ""}`,
    );
    throw new CliExit(EXIT.error);
  }
  // bigger than one pass covers well: offer its parts, as the Modules page does (pilot: a 307-file
  // folder of components asked for in one go; the person split it by hand)
  if (!options.whole && (facts.files > TOO_BIG.files || facts.lines > TOO_BIG.lines)) {
    const parts = partsOf(await trackedFiles(root), module);
    ctx.out.result(
      { module, tooBig: true, files: facts.files, lines: facts.lines, limit: TOO_BIG, parts },
      () => {
        const st = ctx.out.style;
        ctx.out.line(
          `${st.warn(module)} is ${facts.files} files, ~${facts.lines} lines — more than one pass maps well (${TOO_BIG.files} files or ${TOO_BIG.lines} lines); map it in parts:`,
        );
        for (const p of parts.slice(0, 12))
          ctx.out.line(`  ${st.cmd(`jarvis onboard --module ${p.path}`)} ${st.muted(`· ${p.files} files`)}`);
        if (parts.length > 12) ctx.out.line(st.muted(`  … and ${parts.length - 12} smaller`));
        ctx.out.line(st.muted("  or the whole of it anyway: --whole"));
      },
    );
    throw new CliExit(EXIT.error);
  }
  if (options.dryRun) {
    ctx.out.result(
      { module, task: taskFor(module, facts, options.note), facts, wouldRun: "onboard-module" },
      () => {
        ctx.out.line(`would run the onboard-mapper agent on ${module}:`);
        ctx.out.line(taskFor(module, facts, options.note));
      },
    );
    return;
  }
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const progress = followRun(ctx, runtime);
    const result = await mapModule(runtime, {
      root,
      module,
      facts,
      note: options.note,
      env: ctx.env,
    }).finally(() => progress.stop());
    ctx.out.result(result, () => {
      const st = ctx.out.style;
      ctx.out.line(`${st.muted("run")} ${result.runId || "-"}${st.muted(":")} ${st.state(result.state)}`);
      const { kept, proposed } = result.claims;
      const tone = kept === proposed ? st.ok : kept === 0 ? st.bad : st.warn;
      ctx.out.line(`claims confirmed against the code: ${tone(`${kept} of ${proposed}`)}`);
      // the excerpt check proves that a quote exists, not that it supports a generalisation
      if (result.sweeping && result.sweeping.length > 0) {
        ctx.out.line(
          `${st.heading("check before promoting")} ${st.muted(`— generalisations the excerpts cannot prove (${result.sweeping.length}):`)}`,
        );
        for (const s of result.sweeping) ctx.out.line(`  ${st.warn("?")} ${s}`);
      }
      for (const d of result.dropped)
        ctx.out.line(`  ${st.del("dropped")} ${d.section} "${d.what}": ${st.muted(d.why)}`);
      if (result.problem) ctx.out.line(st.warn(result.problem));
      if (result.candidateId) {
        ctx.out.line();
        const name = nameOf({ kind: "knowledge", title: `module ${module}`, module });
        ctx.out.line(
          `candidate ${st.name(name)} ${st.muted(`(knowledge, paths: ${module}/**, ${result.candidateId})`)}`,
        );
        ctx.out.line(
          `${st.muted("read:")} ${st.cmd(`jarvis candidates show ${name}`)}   ${st.muted("·")}   ${st.muted("accept:")} ${st.cmd(`jarvis candidates promote ${name}`)}`,
        );
      }
    });
    if (result.problem && !result.candidateId) throw new CliExit(EXIT.error);
  } finally {
    await runtime.close();
  }
}
