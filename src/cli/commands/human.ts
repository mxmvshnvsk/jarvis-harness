import { createInterface } from "node:readline";
import { createEngine } from "../../app/engine.ts";
import { createRuntime, type Runtime } from "../../app/runtime.ts";
import { runDetail } from "../../app/status.ts";
import { resolveActor } from "../../core/actor/resolve.ts";
import type { Actor } from "../../core/domain/actor.ts";
import type { Run } from "../../core/domain/run.ts";
import {
  clarifierTurn,
  latestProposal,
  rejectThread,
  resolveClarification,
} from "../../interaction/clarify.ts";
import { collectReview } from "../../interaction/review/collector.ts";
import type { Interaction, InteractionMessage } from "../../interaction/store.ts";
import { leaseOwner } from "../../orchestration/lease.ts";
import { LeaseHeldError } from "../../orchestration/types.ts";
import { LeaseLostError, shortRunId } from "../../storage/runStore.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT, padEnd } from "../output.ts";
import { loadForCli } from "./config.ts";
import { renderDetail } from "./status.ts";

async function actorFor(ctx: CliContext, runtime: Runtime): Promise<Actor> {
  const resolved = await resolveActor(runtime.loaded.config, ctx.env, runtime.loaded.project?.root);
  if (!resolved.actor) {
    ctx.out.error(
      "cannot determine the actor: set JARVIS_ACTOR, actor.id or git config user.email (ADR-0006)",
    );
    throw new CliExit(EXIT.error);
  }
  return resolved.actor;
}

/** A thread by id/prefix, or the open clarification thread of a run given by id/prefix. */
function findThread(ctx: CliContext, runtime: Runtime, ref: string): { run: Run; thread: Interaction } {
  const direct = runtime.interactions.resolveRef(ref);
  if (direct) return { run: runtime.runs.require(direct.runId), thread: direct };
  const run = runtime.runs.resolve(ref);
  if (!run) {
    ctx.out.error(`"${ref}" is neither a thread nor a run (see \`jarvis threads\`)`);
    throw new CliExit(EXIT.error);
  }
  const thread =
    runtime.interactions.openFor(run.id, "clarification") ?? runtime.interactions.openFor(run.id);
  if (!thread) {
    ctx.out.error(`run ${shortRunId(run.id)} has no open thread`);
    throw new CliExit(EXIT.error);
  }
  return { run, thread };
}

function renderThread(ctx: CliContext, thread: Interaction, messages: readonly InteractionMessage[]): void {
  const { out } = ctx;
  out.line(
    `thread ${thread.id}  ${thread.kind}  ${thread.state}  run ${shortRunId(thread.runId)}  step ${thread.stepId} #${thread.iteration}`,
  );
  if (thread.origin)
    out.line(`  origin ${thread.origin}${thread.contentRef ? `  about ${thread.contentRef}` : ""}`);
  for (const m of messages) {
    out.line("");
    out.line(`${m.role === "human" ? "You" : "Jarvis"} (${m.actor}):`);
    for (const line of m.text.split("\n")) out.line(`  ${line}`);
    if (m.proposal) out.line("  [proposal — accept with `a`, edit with `e <rule>`]");
  }
}

/** `jarvis threads [--all]` */
export async function runThreads(ctx: CliContext, options: { all?: boolean }): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const threads = options.all
      ? runtime.runs.list({ includeTerminal: true }).flatMap((r) => runtime.interactions.listForRun(r.id))
      : runtime.interactions.listOpen();
    const rows = threads.map((t) => ({
      ...t,
      run: shortRunId(t.runId),
      turns: runtime.interactions.humanTurns(t.id),
      last: runtime.interactions.messages(t.id).at(-1)?.text.split("\n")[0] ?? "",
    }));
    ctx.out.result({ threads: rows }, () => {
      if (rows.length === 0) {
        ctx.out.line(options.all ? "no threads" : "no open threads");
        return;
      }
      for (const t of rows) {
        ctx.out.line(
          `${t.id}  ${padEnd(t.kind, 13)}  ${padEnd(t.state, 16)}  run ${t.run}  ${t.stepId} #${t.iteration}  turns ${t.turns}`,
        );
        if (t.last) ctx.out.line(`${" ".repeat(t.id.length)}  ${t.last.slice(0, 120)}`);
      }
    });
  } finally {
    await runtime.close();
  }
}

export interface AnswerOptions {
  readonly accept?: boolean;
  readonly reject?: boolean;
  readonly rule?: string;
  readonly resume?: boolean;
}

interface TurnResult {
  readonly thread: Interaction;
  readonly reply?: InteractionMessage;
  readonly resolved?: string;
  readonly rejected?: boolean;
  readonly exhausted?: boolean;
}

/** One human move on a clarification thread: a message, an acceptance or a rejection. */
export async function humanMove(
  runtime: Runtime,
  run: Run,
  thread: Interaction,
  actor: Actor,
  move: { text?: string; accept?: boolean; reject?: boolean; rule?: string },
): Promise<TurnResult> {
  if (thread.kind !== "clarification" || thread.state === "resolved" || thread.state === "rejected") {
    throw new CliExit(
      EXIT.error,
      `thread ${thread.id} is a ${thread.kind} thread in state ${thread.state}; nothing to answer`,
    );
  }
  if (move.reject) {
    const closed = rejectThread(runtime, run, thread, actor.id);
    return { thread: closed, rejected: true };
  }
  if (move.accept) {
    const proposal = latestProposal(runtime, thread);
    const resolution = move.rule
      ? {
          rule: move.rule,
          requirementCorrections: proposal?.requirementCorrections ?? [],
          assumptions: proposal?.assumptions ?? [],
        }
      : proposal;
    if (!resolution)
      throw new CliExit(
        EXIT.error,
        "nothing to accept yet: Jarvis has not proposed a resolution; answer first or pass --rule",
      );
    if (move.text) runtime.interactions.say(thread.id, { role: "human", actor: actor.id, text: move.text });
    const result = resolveClarification(runtime, run, thread, resolution, actor.id);
    return { thread: result.thread, resolved: result.artifactRef };
  }
  if (!move.text) throw new CliExit(EXIT.error, "nothing to say: pass a message, --accept or --reject");
  runtime.interactions.say(thread.id, { role: "human", actor: actor.id, text: move.text });
  const config = runtime.loaded.config.human.clarification;
  if (
    runtime.interactions.humanTurns(thread.id) > config.maxTurns ||
    (!config.multiTurn && runtime.interactions.humanTurns(thread.id) > 1)
  ) {
    runtime.interactions.setState(thread.id, "ready_for_review");
    return { thread: runtime.interactions.require(thread.id), exhausted: true };
  }
  const reply = await clarifierTurn(runtime, run, thread);
  return { thread: runtime.interactions.require(thread.id), reply };
}

async function resumeRun(ctx: CliContext, runtime: Runtime, run: Run): Promise<never> {
  const engine = createEngine(runtime);
  const owner = leaseOwner(runtime.loaded.config.interactive ? "cli" : "ci");
  try {
    const result = await engine.execute(run.id, { owner, steal: false });
    const detail = runDetail(runtime, result.run);
    ctx.out.result({ ...detail, exitCode: result.exitCode }, () => renderDetail(ctx, detail, new Date(), 8));
    throw new CliExit(result.exitCode);
  } catch (error) {
    if (error instanceof LeaseHeldError) {
      ctx.out.error(error.message);
      throw new CliExit(EXIT.error);
    }
    if (error instanceof LeaseLostError) {
      ctx.out.error(error.message);
      throw new CliExit(EXIT.leaseLost);
    }
    throw error;
  }
}

/** `jarvis answer <thread|run> [text] [--accept] [--reject] [--rule <text>] [--resume]` */
export async function runAnswer(
  ctx: CliContext,
  ref: string,
  text: string | undefined,
  options: AnswerOptions,
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const { run, thread } = findThread(ctx, runtime, ref);
    const actor = await actorFor(ctx, runtime);
    const result = await humanMove(runtime, run, thread, actor, {
      ...(text !== undefined ? { text } : {}),
      ...(options.accept ? { accept: true } : {}),
      ...(options.reject ? { reject: true } : {}),
      ...(options.rule !== undefined ? { rule: options.rule } : {}),
    });
    if (result.resolved && options.resume) await resumeRun(ctx, runtime, run);
    ctx.out.result(
      {
        thread: result.thread,
        ...(result.reply ? { reply: result.reply } : {}),
        ...(result.resolved ? { resolved: result.resolved } : {}),
        ...(result.rejected ? { rejected: true } : {}),
        ...(result.exhausted ? { exhausted: true } : {}),
      },
      () => {
        if (result.resolved) {
          ctx.out.line(
            `thread ${thread.id} resolved → ${result.resolved}; continue with \`jarvis resume ${shortRunId(run.id)}\``,
          );
        } else if (result.rejected) {
          ctx.out.line(`thread ${thread.id} rejected; the run still waits for a human decision`);
        } else if (result.exhausted) {
          ctx.out.line(
            `turn budget of the thread is used up (human.clarification.maxTurns); decide with \`jarvis answer ${thread.id} --accept --rule "<rule>"\``,
          );
        } else if (result.reply) {
          ctx.out.line("Jarvis:");
          for (const line of result.reply.text.split("\n")) ctx.out.line(`  ${line}`);
          if (result.reply.proposal)
            ctx.out.line(`[accept with \`jarvis answer ${thread.id} --accept\`, or answer again]`);
        }
      },
    );
  } finally {
    await runtime.close();
  }
}

/**
 * `jarvis attach <run>` — the live mode (ADR-0019 §4): shows the open thread and runs the
 * mini-chat in the terminal; `a` accepts the proposal, `e <rule>` accepts an edited rule, `r`
 * rejects, `q` detaches. After a resolution the run resumes in the foreground.
 */
export async function runAttach(
  ctx: CliContext,
  ref: string,
  stdin: NodeJS.ReadableStream,
  options: { noResume?: boolean },
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const run = runtime.runs.resolve(ref);
    if (!run) {
      ctx.out.error(`run "${ref}" not found`);
      throw new CliExit(EXIT.error);
    }
    let thread = runtime.interactions.openFor(run.id, "clarification");
    if (!thread) {
      const detail = runDetail(runtime, run);
      ctx.out.result(detail, () => renderDetail(ctx, detail, new Date(), 8));
      ctx.out.error(
        `run ${shortRunId(run.id)} has no open clarification thread${run.waitingFor ? ` (waiting for ${run.waitingFor.kind})` : ""}`,
      );
      return;
    }
    const actor = await actorFor(ctx, runtime);
    renderThread(ctx, thread, runtime.interactions.messages(thread.id));
    const rl = createInterface({ input: stdin, terminal: false });
    const lines = rl[Symbol.asyncIterator]();
    let resolvedRef: string | undefined;
    for (;;) {
      ctx.out.line("");
      ctx.out.line("> (answer | a = accept | e <rule> | r = reject | q = detach)");
      const next = await lines.next();
      if (next.done) break;
      const input = String(next.value).trim();
      if (input === "q" || input.length === 0) break;
      const move =
        input === "a"
          ? { accept: true }
          : input === "r"
            ? { reject: true }
            : input.startsWith("e ")
              ? { accept: true, rule: input.slice(2).trim() }
              : { text: input };
      const result = await humanMove(runtime, run, thread, actor, move);
      thread = result.thread;
      if (result.resolved) {
        resolvedRef = result.resolved;
        ctx.out.line(`resolved → ${result.resolved}`);
        break;
      }
      if (result.rejected) {
        ctx.out.line("rejected; the run keeps waiting for a human decision");
        break;
      }
      if (result.exhausted) {
        ctx.out.line("turn budget used up; accept with `a` / `e <rule>` or reject with `r`");
        continue;
      }
      if (result.reply) {
        ctx.out.line("");
        ctx.out.line("Jarvis:");
        for (const line of result.reply.text.split("\n")) ctx.out.line(`  ${line}`);
      }
    }
    rl.close();
    if (resolvedRef && !options.noResume) await resumeRun(ctx, runtime, run);
  } finally {
    await runtime.close();
  }
}

/** Steps a correction class invalidates in the `sdd` graph (ADR-0019 §8). */
const INVALIDATION: Record<string, string[]> = {
  CODE: ["implementation", "verify", "review"],
  SPEC_CORRECTION: ["spec", "approve-spec", "impact", "plan", "implementation", "verify", "review"],
  REQUIREMENT_CORRECTION: [
    "requirements",
    "spec",
    "approve-spec",
    "impact",
    "plan",
    "implementation",
    "verify",
    "review",
  ],
  QUESTION: ["(opens a clarification thread first)"],
  KNOWLEDGE_CANDIDATE: ["(none — becomes a candidate)"],
  SUGGESTION: ["(none)"],
};

/**
 * `jarvis review submit [run] [--resume]` — Review Mode v1 (ADR-0019 §5): collects REVIEW markers
 * into a review package, records the decision on the implementation and routes the final gate
 * to review-analysis.
 */
export async function runReviewSubmit(
  ctx: CliContext,
  ref: string | undefined,
  options: { resume?: boolean },
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const run = ref ? runtime.runs.resolve(ref) : runtime.runs.list({ state: "WAITING_HUMAN" })[0];
    if (!run) {
      ctx.out.error(ref ? `run "${ref}" not found` : "no run is waiting for a human");
      throw new CliExit(EXIT.error);
    }
    if (run.state !== "WAITING_HUMAN" || run.waitingFor?.kind !== "approval") {
      ctx.out.error(
        `run ${shortRunId(run.id)} is ${run.state}${run.waitingFor ? ` (waiting for ${run.waitingFor.kind})` : ""}; review needs a run parked at the implementation gate`,
      );
      throw new CliExit(EXIT.error);
    }
    if (!loaded.config.human.review.sourceMarkers) {
      ctx.out.error("human.review.sourceMarkers is off for this project");
      throw new CliExit(EXIT.error);
    }
    const actor = await actorFor(ctx, runtime);
    const pkg = await collectReview(run.workspace.path, run.workspace.baseCommit);
    if (pkg.comments.length === 0) {
      ctx.out.error(
        `no REVIEW markers found in ${run.workspace.path}; write \`// REVIEW: …\` next to the code and submit again`,
      );
      throw new CliExit(EXIT.error);
    }
    const implementation = runtime.artifacts.listLatest(run.id, "implementation")[0];
    if (!implementation) {
      ctx.out.error("the run has no implementation artifact to review");
      throw new CliExit(EXIT.error);
    }
    const artifact = runtime.artifacts.put({
      runId: run.id,
      type: "review-package",
      name: "review-package.json",
      content: JSON.stringify({ ...pkg, submittedBy: actor.id }, null, 2),
      mediaType: "application/json",
      provenance: { kind: "human", actor },
      sourceRefs: pkg.comments.map((c) => `${c.file}:${c.line}`),
      stepId: "approve-impl",
      iteration: run.currentIteration,
    });
    const packageRef = `${artifact.artifactId}@${artifact.version}`;
    runtime.artifacts.approve({
      runId: run.id,
      stepId: run.currentStep ?? "approve-impl",
      artifactId: implementation.artifactId,
      version: implementation.version,
      actor,
      decision: "request_changes",
      outcome: "review_submitted",
      comment: `review package ${packageRef} with ${pkg.comments.length} comment(s)`,
    });
    const openApproval = runtime.interactions.openFor(run.id, "approval");
    if (openApproval) runtime.interactions.close(openApproval.id, "resolved", actor.id, packageRef);
    const session = runtime.interactions.open({
      runId: run.id,
      kind: "review",
      stepId: "approve-impl",
      iteration: run.currentIteration,
      contentRef: packageRef,
      origin: "review",
      openedBy: actor.id,
      meta: { comments: pkg.comments.map((c) => c.id) },
      message: {
        role: "human",
        actor: actor.id,
        text: pkg.comments.map((c) => `${c.id} ${c.file}:${c.line} — ${c.text}`).join("\n"),
      },
    });
    runtime.interactions.setState(session.id, "acknowledged");
    runtime.events.emit({
      kind: "review.submitted",
      runId: run.id,
      stepId: "approve-impl",
      actor: `${actor.kind}:${actor.id}`,
      payload: {
        package: packageRef,
        comments: pkg.comments.length,
        rewritten: pkg.rewritten,
        session: session.id,
      },
    });
    const summary = {
      run: run.id,
      package: packageRef,
      session: session.id,
      comments: pkg.comments.map((c) => ({ id: c.id, file: c.file, line: c.line, text: c.text })),
      rewritten: pkg.rewritten,
      invalidation: INVALIDATION,
    };
    if (options.resume) await resumeRun(ctx, runtime, run);
    ctx.out.result(summary, () => {
      ctx.out.line(`review package ${packageRef}: ${pkg.comments.length} comment(s)`);
      for (const c of pkg.comments) ctx.out.line(`  ${c.id}  ${c.file}:${c.line}  ${c.text}`);
      if (pkg.rewritten.length > 0) ctx.out.line(`ids written into: ${pkg.rewritten.join(", ")}`);
      ctx.out.line("");
      ctx.out.line("what each comment class will recompute after analysis (ADR-0019 §8):");
      for (const [cls, steps] of Object.entries(INVALIDATION))
        ctx.out.line(`  ${padEnd(cls, 23)} ${steps.join(" → ")}`);
      ctx.out.line("");
      ctx.out.line(`continue with \`jarvis resume ${shortRunId(run.id)}\` (or pass --resume)`);
    });
  } finally {
    await runtime.close();
  }
}
