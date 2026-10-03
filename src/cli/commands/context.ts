import {
  currentTranscript,
  inspectContext,
  type ReshapeKind,
  reshapeContext,
} from "../../agents/contextOps.ts";
import { createRuntime, type Runtime } from "../../app/runtime.ts";
import type { Run } from "../../core/domain/run.ts";
import { isTerminal } from "../../core/domain/run.ts";
import { shortRunId } from "../../storage/runStore.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT } from "../output.ts";
import { loadForCli } from "./config.ts";

function pick(ctx: CliContext, runtime: Runtime, ref: string | undefined): Run {
  const run = ref
    ? runtime.runs.resolve(ref)
    : (runtime.runs.list({}).find((r) => !isTerminal(r.state)) ??
      runtime.runs.list({ includeTerminal: true })[0]);
  if (!run) {
    ctx.out.error(ref ? `no run matches "${ref}"` : "no runs (give a run id)");
    throw new CliExit(EXIT.error);
  }
  return run;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** `jarvis context [run]` — what the agent's context looks like right now (ADR-0013). */
export async function runContext(ctx: CliContext, ref: string | undefined): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const run = pick(ctx, runtime, ref);
    const view = inspectContext(runtime, run);
    ctx.out.result({ run: run.id, context: view ?? null }, () => {
      ctx.out.line(`run ${shortRunId(run.id)}  ${run.task}  ${run.state}`);
      if (!view) {
        ctx.out.line("no checkpointed agent transcript: the current step has not run a tool round yet,");
        ctx.out.line("or the run is between steps (each agent starts from a clean window).");
        return;
      }
      const t = view.thresholds;
      ctx.out.line(`step ${view.stepId} #${view.iteration}  model ${view.modelId}`);
      ctx.out.line(`window   ${view.effective} tokens usable (after output reserve and safety margin)`);
      ctx.out.line(`base     ${view.baseTokens} tokens  (system, task, knowledge, tool definitions)`);
      ctx.out.line(
        `history  ${view.transcriptTokens} tokens  ${view.messages} messages in ${view.blocks} blocks` +
          `  (${view.handoffs} handoff, ${view.trimmedResults} trimmed result${view.trimmedResults === 1 ? "" : "s"})`,
      );
      ctx.out.line(`pressure ${pct(view.pressure)}  → ${view.level}`);
      ctx.out.line(
        `levels   watch ${pct(t.watch)}  compact ${pct(t.compact)}  aggressive ${pct(t.aggressive)}  reset ${pct(t.reset)}`,
      );
      ctx.out.line(
        `so far   peak ${pct(view.peakPressure)}  trims ${view.trims}  compactions ${view.compactions}  resets ${view.resets}`,
      );
    });
  } finally {
    await runtime.close();
  }
}

export interface ReshapeCliOptions {
  readonly aggressive?: boolean;
  readonly dryRun?: boolean;
}

/** `jarvis compact <run>` and `jarvis reset-context <run>`. */
export async function runReshape(
  ctx: CliContext,
  ref: string,
  options: ReshapeCliOptions,
  reset: boolean,
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  const owner = `cli:context:${process.pid}`;
  let held: { epoch: number } | undefined;
  const run = pick(ctx, runtime, ref);
  try {
    if (isTerminal(run.state)) {
      ctx.out.error(`run ${shortRunId(run.id)} is ${run.state}; there is no context to reshape`);
      throw new CliExit(EXIT.error);
    }
    if (!currentTranscript(runtime, run)) {
      ctx.out.error("the run has no checkpointed agent transcript yet; nothing to reshape");
      throw new CliExit(EXIT.error);
    }
    if (!options.dryRun) {
      // The run must not be executing: take its lease for the duration (ADR-0002 §5).
      const lease = runtime.runs.acquireLease(run.id, owner, 5 * 60_000);
      if (!lease.ok) {
        ctx.out.error(
          `run ${shortRunId(run.id)} is held by ${lease.heldBy} until ${lease.until} — it is executing; ` +
            "wait for it to park, or cancel it",
        );
        throw new CliExit(EXIT.error);
      }
      held = { epoch: lease.lease.epoch };
    }
    const kind: ReshapeKind = reset ? "reset" : options.aggressive ? "aggressive" : "compact";
    let report: Awaited<ReturnType<typeof reshapeContext>>;
    try {
      report = await reshapeContext(runtime, run, { kind, dryRun: options.dryRun === true });
    } catch (error) {
      ctx.out.error(error instanceof Error ? error.message : String(error));
      throw new CliExit(EXIT.error);
    }
    ctx.out.result({ run: run.id, ...report }, () => {
      const verb = reset ? "reset" : "compact";
      ctx.out.line(
        `${options.dryRun ? `dry run — ${verb} would` : verb}: ` +
          `${report.blocksCompacted} of ${report.blocksBefore} blocks → ${reset ? "handoff only" : "handoff + tail"}, ` +
          `${report.trimmed} result${report.trimmed === 1 ? "" : "s"} trimmed`,
      );
      ctx.out.line(
        `tokens ${report.tokensBefore}${report.tokensAfter === undefined ? "" : ` → ${report.tokensAfter}`}` +
          (report.originals.length > 0 && !options.dryRun
            ? `  originals ${report.originals.map((o) => `blob:${o.slice(0, 12)}…`).join(" ")}`
            : ""),
      );
      if (!options.dryRun) ctx.out.line(`continue with \`jarvis resume ${shortRunId(run.id)}\``);
    });
  } finally {
    if (held) runtime.runs.releaseLease(run.id, owner, held.epoch);
    await runtime.close();
  }
}
