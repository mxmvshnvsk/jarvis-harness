import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BundleImportError, exportRun, importRun, readBundle, writeBundle } from "../../app/bundle.ts";
import { createRuntime } from "../../app/runtime.ts";
import { type RunDetail, runDetail } from "../../app/status.ts";
import type { Run } from "../../core/domain/run.ts";
import { WorktreeError } from "../../orchestration/worktree.ts";
import { shortRunId } from "../../storage/runStore.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT } from "../output.ts";
import { loadForCli } from "./config.ts";
import { runWork } from "./run.ts";

/**
 * `jarvis ci <task>` (ADR-0009): the same workflow under the `ci` profile — non-interactive,
 * read-only workspace, narrowed tools. A run that parks at a human gate leaves an
 * `approval-request.json` and a markdown summary for the job (exit 10); `--bundle` exports it so a
 * developer can `jarvis import` and continue (§5).
 */
export interface CiOptions {
  readonly workflow?: string;
  readonly summary?: string;
  readonly bundle?: string;
  readonly profile?: string;
}

export function summaryMarkdown(d: RunDetail): string {
  const r = d.run;
  const lines = [
    `## Jarvis run ${shortRunId(r.id)} — ${r.task}`,
    "",
    `| | |`,
    `|---|---|`,
    `| workflow | ${r.workflow} |`,
    `| state | **${r.state}**${r.stateReason ? ` — ${r.stateReason}` : ""} |`,
    `| step | ${r.currentStep ?? "-"} #${r.currentIteration} |`,
    `| waiting for | ${r.waitingFor ? `${r.waitingFor.kind}${r.waitingFor.detail ? ` (${r.waitingFor.detail})` : ""}` : "-"} |`,
    `| tokens | ${d.tokens.calls} calls, ${d.tokens.promptTokens} prompt, ${d.tokens.outputTokens} output |`,
    "",
  ];
  if (d.pendingApprovals.length > 0) {
    lines.push("### Awaiting approval", "");
    for (const a of d.pendingApprovals)
      lines.push(
        `- \`${a.type}/${a.name}@${a.version}\` — \`jarvis import <bundle> && jarvis approve ${shortRunId(r.id)} --resume\``,
      );
    lines.push("");
  }
  if (d.steps.length > 0) {
    lines.push("### Steps", "");
    for (const s of d.steps)
      lines.push(
        `- ${s.stepId} #${s.iteration}: ${s.status ?? "running"}${s.outcome ? ` (${s.outcome})` : ""}`,
      );
    lines.push("");
  }
  const artifacts = d.artifacts.filter((a) => a.type !== "tool-output");
  if (artifacts.length > 0) {
    lines.push("### Artifacts", "");
    for (const a of artifacts)
      lines.push(`- ${a.type}/${a.name}@${a.version}${a.approved ? " ✓ approved" : ""}`);
    lines.push("");
  }
  return lines.join("\n");
}

export async function runCi(ctx: CliContext, task: string, options: CiOptions): Promise<void> {
  // `--profile` is the global flag; `ci` is the default when none is given.
  const ciCtx: CliContext = { ...ctx, profile: options.profile ?? ctx.profile ?? "ci" };
  let exitCode: number = EXIT.ok;
  try {
    await runWork(ciCtx, task, { ...(options.workflow ? { workflow: options.workflow } : {}) });
  } catch (error) {
    if (!(error instanceof CliExit)) throw error;
    exitCode = error.code;
  }
  // The run exists now (unless creation itself failed): write what the pipeline needs.
  const loaded = await loadForCli(ciCtx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const run = runtime.runs.list({ task, includeTerminal: true }).at(-1);
    if (!run) throw new CliExit(exitCode);
    const detail = runDetail(runtime, run);
    const summary = summaryMarkdown(detail);
    const summaryFile = options.summary ?? ctx.env.GITHUB_STEP_SUMMARY ?? ctx.env.JARVIS_CI_SUMMARY;
    if (summaryFile) {
      mkdirSync(dirname(summaryFile), { recursive: true });
      writeFileSync(summaryFile, `${summary}\n`, { flag: "a" });
    }
    if (run.state === "WAITING_HUMAN" || run.state === "WAITING_BUDGET") {
      // ADR-0009 §2: approval-request.json next to the run's state, for the job artifact.
      const requestDir = join(loaded.home.runsDir, run.id);
      mkdirSync(requestDir, { recursive: true });
      const request = {
        runId: run.id,
        task: run.task,
        workflow: run.workflow,
        state: run.state,
        waitingFor: run.waitingFor ?? null,
        pending: detail.pendingApprovals.map((a) => ({
          type: a.type,
          name: a.name,
          version: a.version,
          contentRef: a.contentRef,
        })),
        bundle: options.bundle ?? null,
        createdAt: new Date().toISOString(),
      };
      writeFileSync(join(requestDir, "approval-request.json"), `${JSON.stringify(request, null, 2)}\n`);
      writeFileSync(join(requestDir, "summary.md"), `${summary}\n`);
    }
    if (options.bundle) {
      writeBundle(await exportRun(runtime, run.id), options.bundle);
      ctx.out.note(`bundle written to ${options.bundle}`);
    }
  } finally {
    await runtime.close();
  }
  throw new CliExit(exitCode);
}

/** `jarvis export <run> [--out <file>]` */
export async function runExport(ctx: CliContext, ref: string, options: { out?: string }): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const run: Run | undefined = runtime.runs.resolve(ref);
    if (!run) {
      ctx.out.error(`run "${ref}" not found`);
      throw new CliExit(EXIT.error);
    }
    const file = options.out ?? join(ctx.cwd, `${shortRunId(run.id)}.jarvis.json.gz`);
    const bundle = await exportRun(runtime, run.id);
    writeBundle(bundle, file);
    const stats = {
      run: run.id,
      file,
      artifacts: bundle.tables.artifacts?.length ?? 0,
      blobs: Object.keys(bundle.blobs).length,
      patch: bundle.patch ? bundle.patch.length : 0,
    };
    ctx.out.result(stats, () =>
      ctx.out.line(
        `exported ${shortRunId(run.id)} → ${file} (${stats.artifacts} artifact version(s), ${stats.blobs} blob(s), patch ${stats.patch} bytes)`,
      ),
    );
  } finally {
    await runtime.close();
  }
}

/** `jarvis import <bundle>` */
export async function runImport(ctx: CliContext, file: string): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const bundle = readBundle(file);
    const repoRoot = loaded.project?.isGitRepo ? loaded.project.root : undefined;
    const result = await importRun(runtime, bundle, {
      ...(repoRoot ? { repoRoot } : {}),
      worktreesDir: loaded.home.worktreesDir,
      env: ctx.env,
    });
    const run = runtime.runs.require(result.runId);
    ctx.out.result({ ...result, state: run.state, workspacePath: run.workspace.path }, () => {
      ctx.out.line(
        `imported ${shortRunId(run.id)} (${run.state}) — workspace ${result.workspace}${result.patched ? ", patch applied" : ""}`,
      );
      if (result.workspace === "missing")
        ctx.out.line(
          "no git repository here: run `jarvis import` inside the project to rebuild the worktree",
        );
      if (run.state === "WAITING_HUMAN")
        ctx.out.line(
          `next: jarvis status ${shortRunId(run.id)} → jarvis approve ${shortRunId(run.id)} --resume`,
        );
    });
  } catch (error) {
    if (error instanceof BundleImportError || error instanceof WorktreeError) {
      ctx.out.error(error.message);
      throw new CliExit(EXIT.error);
    }
    throw error;
  } finally {
    await runtime.close();
  }
}
