import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  type CommitInfo,
  commitForLine,
  commitInfo,
  explainRun,
  jarvisCommitsForFile,
  type RunExplanation,
} from "../../app/explain.ts";
import { createRuntime } from "../../app/runtime.ts";
import { shortRunId } from "../../storage/runStore.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT } from "../output.ts";
import { loadForCli } from "./config.ts";

/**
 * `jarvis explain <file[:line] | commit | run>` — the recorded chain behind a change (ADR-0001 §14).
 * A line goes through `git blame` to its commit, the commit's `Jarvis-Run` trailer to the run, and the
 * run to its steps, artifacts, approvals and tool calls.
 */
interface Target {
  readonly kind: "run" | "line" | "file" | "commit";
  readonly commit?: CommitInfo;
  readonly runId?: string;
  readonly file?: string;
  readonly line?: number;
  readonly others?: CommitInfo[];
}

function parseFileTarget(raw: string): { path: string; line?: number } {
  const m = /^(.*):(\d+)$/.exec(raw);
  return m ? { path: m[1] as string, line: Number(m[2]) } : { path: raw };
}

function render(ctx: CliContext, target: Target, explanations: RunExplanation[], missing: string[]): void {
  if (target.commit) {
    const c = target.commit;
    ctx.out.line(`commit ${c.sha.slice(0, 10)}  ${c.subject}  (${c.author}, ${c.date.slice(0, 10)})`);
    if (!c.runId) ctx.out.line("  no Jarvis-Run trailer: this change was not made by a Jarvis run");
  }
  if (target.kind === "file" && target.file)
    ctx.out.line(`${target.file}: ${explanations.length + missing.length} Jarvis run(s) changed it`);
  for (const id of missing)
    ctx.out.line(`run ${shortRunId(id)}: no record on this machine (jarvis import <bundle> brings it in)`);
  for (const e of explanations) {
    ctx.out.line();
    ctx.out.line(`task      ${e.run.task}`);
    ctx.out.line(
      `run       ${shortRunId(e.run.id)}  ${e.run.workflow}  ${e.run.state}  by ${e.run.owner}  ${e.run.createdAt.slice(0, 16)}`,
    );
    if (e.run.baseCommit) ctx.out.line(`base      ${e.run.baseCommit.slice(0, 10)}`);
    ctx.out.line(
      `steps     ${e.steps.map((s) => `${s.step}${s.iteration > 1 ? `#${s.iteration}` : ""}${s.outcome && s.outcome !== "ok" ? `(${s.outcome})` : ""}`).join(" → ")}`,
    );
    ctx.out.line("artifacts");
    for (const a of e.artifacts) {
      ctx.out.line(`  ${a.label}  ${a.type}  by ${a.producedBy}${a.step ? ` in ${a.step}` : ""}`);
      for (const ap of a.approvals)
        ctx.out.line(
          `      ${ap.decision} by ${ap.actor} ${ap.at.slice(0, 16)}${ap.comment ? ` — ${ap.comment}` : ""}`,
        );
      if (a.sources.length > 0)
        ctx.out.line(
          `      sources: ${a.sources.slice(0, 6).join(", ")}${a.sources.length > 6 ? ` … +${a.sources.length - 6}` : ""}`,
        );
      for (const m of a.mentions) ctx.out.line(`      mentions: ${m}`);
    }
    for (const c of e.clarifications)
      ctx.out.line(
        `  ${c.kind} ${c.id.slice(0, 8)} at ${c.step}: ${c.state}${c.resolvedBy ? ` by ${c.resolvedBy}` : ""}`,
      );
    const tools = Object.entries(e.tools)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}×${v}`)
      .join(", ");
    ctx.out.line(`tools     ${tools || "none"}`);
    ctx.out.line(
      `model     ${e.models.calls} call(s), ${e.models.outputTokens} output tokens${e.humanEdits > 0 ? `; ${e.humanEdits} human edit(s)` : ""}`,
    );
  }
}

export async function runExplain(ctx: CliContext, raw: string): Promise<void> {
  const loaded = await loadForCli(ctx);
  const root = loaded.project?.root ?? ctx.cwd;
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    let target: Target | undefined;
    const fileTarget = parseFileTarget(raw);
    const abs = resolve(ctx.cwd, fileTarget.path);
    if (existsSync(abs) && !raw.startsWith("run_")) {
      const rel = relative(root, abs);
      if (fileTarget.line !== undefined) {
        const sha = await commitForLine(root, rel, fileTarget.line);
        const commit = sha ? await commitInfo(root, sha) : undefined;
        target = {
          kind: "line",
          file: `${rel}:${fileTarget.line}`,
          ...(commit ? { commit } : {}),
          ...(commit?.runId ? { runId: commit.runId } : {}),
        };
      } else {
        const commits = await jarvisCommitsForFile(root, rel);
        target = { kind: "file", file: rel, others: commits };
      }
    } else {
      const run = runtime.runs.resolve(raw);
      if (run) target = { kind: "run", runId: run.id };
      else {
        const commit = await commitInfo(root, raw);
        if (commit) target = { kind: "commit", commit, ...(commit.runId ? { runId: commit.runId } : {}) };
      }
    }
    if (!target) {
      ctx.out.error(`"${raw}" is not a file, a commit or a run`);
      throw new CliExit(EXIT.error);
    }
    const focus =
      target.kind === "line" || target.kind === "file" ? target.file?.replace(/:\d+$/, "") : undefined;
    const runIds = [
      ...new Set([
        ...(target.runId ? [target.runId] : []),
        ...(target.others ?? []).flatMap((c) => (c.runId ? [c.runId] : [])),
      ]),
    ];
    const explanations: RunExplanation[] = [];
    const missing: string[] = [];
    for (const id of runIds) {
      const run = runtime.runs.resolve(id);
      if (run) explanations.push(explainRun(runtime, run, focus));
      else missing.push(id);
    }
    ctx.out.result({ target, runs: explanations, missing }, () =>
      render(ctx, target as Target, explanations, missing),
    );
    if (explanations.length === 0 && missing.length === 0 && target.kind !== "run")
      ctx.out.error("no Jarvis provenance found for this target");
  } finally {
    await runtime.close();
  }
}
