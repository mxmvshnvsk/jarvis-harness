import { awaitedArtifact, recordDecision } from "../app/decide.ts";
import type { Runtime } from "../app/runtime.ts";
import type { Actor } from "../core/domain/actor.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import type { Run } from "../core/domain/run.ts";
import { clarifyLoop } from "./commands/human.ts";
import type { CliContext } from "./context.ts";
import type { Prompt } from "./prompt.ts";
import { documentToMarkdown, renderMarkdown } from "./render.ts";
import { incompleteOf } from "./style.ts";

/**
 * A run stopped for a person, handled where the person is (ADR-0019 §4 live mode): the gated
 * document in brief, then a choice — read it whole, accept, send it back with answers to its open
 * questions, or leave it for later (`jarvis continue`). Pilot: the way on was
 * `jarvis approve 1a2b3c4d --request-changes --resume --comment "…"`.
 */
export type GateResult = "decided" | "detached";

function parseDoc(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];

const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

function cut(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return [...one].length > max ? `${[...one].slice(0, max - 1).join("")}…` : one;
}

/** Title, the gist and what the document holds — enough to decide whether to read it whole. */
function brief(
  ctx: CliContext,
  type: string,
  a: ArtifactVersion,
  text: string,
): Record<string, unknown> | undefined {
  const st = ctx.out.style;
  const doc = a.name.endsWith(".json") ? parseDoc(text) : undefined;
  ctx.out.line();
  if (doc) {
    const title = typeof doc.title === "string" ? doc.title : `${type}/${a.name}`;
    ctx.out.line(`  ${st.heading(title)}`);
    if (typeof doc.summary === "string") ctx.out.line(`  ${cut(doc.summary, 320)}`);
    const n = (v: unknown, one: string) => {
      const k = count(v);
      return k > 0 ? `${k} ${one}${k === 1 ? "" : "s"}` : "";
    };
    const questions = n(doc.openQuestions, "open question");
    const parts = [
      n(doc.requirements, "requirement"),
      n(doc.goals, "goal"),
      n(doc.risks, "risk"),
      questions ? st.warn(questions) : "",
    ].filter(Boolean);
    if (parts.length > 0) ctx.out.line(`  ${parts.join(st.muted(" · "))}`);
  } else {
    for (const line of text.split("\n").slice(0, 8)) ctx.out.line(`  ${line}`);
  }
  const partial = incompleteOf(a);
  if (partial)
    ctx.out.line(`  ${st.warn(`⚠ incomplete: agent ${partial.agentId} hit its ${partial.limit} limit`)}`);
  return doc;
}

function menu(ctx: CliContext): void {
  const st = ctx.out.style;
  const item = (key: string, what: string) => `${st.cmd(key)} ${st.muted(what)}`;
  ctx.out.line();
  ctx.out.line(
    `  ${[item("enter", "read it whole"), item("a", "accept"), item("c", "send back with changes"), item("q", "decide later")].join("    ")}`,
  );
}

/** Answers to the document's open questions, then anything else; empty when nothing was said. */
async function changes(
  ctx: CliContext,
  prompt: Prompt,
  doc: Record<string, unknown> | undefined,
): Promise<string | undefined> {
  const st = ctx.out.style;
  const questions = strings(doc?.openQuestions);
  const answers: string[] = [];
  if (questions.length > 0) {
    ctx.out.line(`  ${st.muted("answer the open questions (empty line skips one):")}`);
    for (const [i, q] of questions.entries()) {
      ctx.out.line(`  ${st.warn(`${i + 1}/${questions.length}`)} ${q}`);
      const a = await prompt.ask(`  ${st.cmd(">")} `);
      if (a === undefined) return undefined;
      if (a) answers.push(`${i + 1}) ${q}\n   → ${a}`);
    }
  }
  ctx.out.line(`  ${st.muted("what else to change? (empty line sends)")}`);
  const extra: string[] = [];
  for (;;) {
    const line = await prompt.ask(`  ${st.cmd(">")} `);
    if (line === undefined) return undefined;
    if (!line) break;
    extra.push(line);
  }
  const parts = [
    answers.length > 0 ? `Answers to the open questions:\n${answers.join("\n")}` : "",
    extra.join("\n"),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : "";
}

export async function humanGate(
  ctx: CliContext,
  runtime: Runtime,
  parked: Run,
  actor: Actor,
  prompt: Prompt,
): Promise<GateResult> {
  const st = ctx.out.style;
  const run = runtime.runs.get(parked.id) ?? parked;
  if (run.waitingFor?.kind === "clarification") {
    const thread = runtime.interactions.openFor(run.id, "clarification");
    if (!thread) return "detached";
    ctx.out.line();
    return (await clarifyLoop(ctx, runtime, run, thread, actor, prompt)) === "resolved"
      ? "decided"
      : "detached";
  }
  const awaited = awaitedArtifact(runtime, run);
  if (!awaited) return "detached";
  const { type, artifact } = awaited;
  const text = runtime.artifacts.text(artifact);
  const doc = brief(ctx, type, artifact, text);
  for (;;) {
    menu(ctx);
    const input = await prompt.ask(`${st.cmd(">")} `);
    if (input === undefined || input === "q") return "detached";
    if (input === "") {
      ctx.out.line(st.muted("─".repeat(60)));
      ctx.out.raw(renderMarkdown((doc ? documentToMarkdown(doc) : text).trimEnd(), st));
      ctx.out.line(st.muted("─".repeat(60)));
      continue;
    }
    if (input === "a") {
      recordDecision(runtime, run, { actor, artifact, type, decision: "approve" });
      ctx.out.line(`${st.ok("✓")} accepted ${type}/${artifact.name}@${artifact.version}`);
      return "decided";
    }
    if (input === "c") {
      const comment = await changes(ctx, prompt, doc);
      if (comment === undefined) return "detached";
      if (!comment) {
        ctx.out.line(st.muted("  nothing to send; choose again"));
        continue;
      }
      recordDecision(runtime, run, { actor, artifact, type, decision: "request_changes", comment });
      ctx.out.line(
        `${st.warn("↻")} sent back ${type}/${artifact.name}@${artifact.version} with your changes`,
      );
      return "decided";
    }
    ctx.out.line(st.muted("  enter, a, c or q"));
  }
}
