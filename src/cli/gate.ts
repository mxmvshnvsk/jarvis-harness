import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BudgetStop,
  budgetGranted,
  budgetStopOf,
  grantBudget,
  sourceOf,
  unitOf,
} from "../app/budgetStop.ts";
import {
  awaitedArtifact,
  DecisionTakenError,
  decisionOn,
  openCard,
  recordDecision,
  requestRerun,
  rerunRequested,
  whereFrom,
} from "../app/decide.ts";
import type { Runtime } from "../app/runtime.ts";
import type { Actor } from "../core/domain/actor.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import type { Run } from "../core/domain/run.ts";
import { shortRunId } from "../storage/runStore.ts";
import { git } from "../tools/local/exec.ts";
import {
  type Change,
  changesIn,
  checkoutLink,
  describeFiles,
  formatChanges,
  homePath,
  type OpenIn,
  reviewFiles,
  type ShellIn,
  systemOpener,
  systemShell,
  watchCheckout,
} from "./checkout.ts";
import { clarifyLoop } from "./commands/human.ts";
import type { CliContext } from "./context.ts";
import { passthrough, titleSequence } from "./notify.ts";
import type { Prompt } from "./prompt.ts";
import { documentToMarkdown, renderMarkdown } from "./render.ts";
import { cutStyled, incompleteOf } from "./style.ts";
import { artifactLink } from "./view.ts";

/**
 * A run stopped for a person, handled where the person is (ADR-0019 §4 live mode): the gated
 * document in brief, then a choice — read it whole, accept, send it back with answers to its open
 * questions, or leave it for later (`jarvis continue`). Pilot: the way on was
 * `jarvis approve 1a2b3c4d --request-changes --resume --comment "…"`.
 *
 * `elsewhere`: the run went on in another process (`jarvis resume`, `approve --resume` in another
 * tab) — the terminal follows it instead of taking its lease (ADR-0023 §4, ADR-0002 §5).
 */
export type GateResult = "decided" | "detached" | "elsewhere";

/** What the card learns from the journal while it waits for a key (ADR-0023 §4). */
interface Pickup {
  /** The line the card prints instead of the answer. */
  readonly line: string;
  /** The run is no longer waiting: another process drives it. */
  readonly moved: boolean;
}

/**
 * Watches the run while the card asks: a decision recorded elsewhere, a "run again" asked from the
 * page, or the run moving on. `signal` aborts the question that waits for a key.
 */
function watchRun(
  check: () => Pickup | undefined,
  everyMs: number,
): { readonly signal: AbortSignal; seen(): Pickup | undefined; stop(): void } {
  const abort = new AbortController();
  let seen: Pickup | undefined;
  let once = false;
  const timer = setInterval(() => {
    if (seen) return;
    let now: Pickup | undefined;
    try {
      now = check();
    } catch {
      return; // a busy database: look again on the next tick
    }
    // a decision on a run that still waits: one more tick, so an `approve --resume` elsewhere takes
    // the run first and this terminal follows it instead of racing it for the lease
    if (now && !now.moved && !once) {
      once = true;
      return;
    }
    seen = now;
    if (seen) abort.abort();
  }, everyMs);
  timer.unref?.();
  return {
    signal: abort.signal,
    seen: () => seen,
    stop: () => clearInterval(timer),
  };
}

/** How often the card looks at the journal (JARVIS_CARD_POLL_MS: tests). */
function pollMs(ctx: CliContext): number {
  const ms = Number(ctx.env?.JARVIS_CARD_POLL_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : 1000;
}

/** The card's line for a decision made elsewhere: `✓ accepted in the browser by dev@example.com`. */
function decisionLine(
  ctx: CliContext,
  runtime: Runtime,
  artifact: ArtifactVersion,
  label: string,
  before = false,
): string | undefined {
  const st = ctx.out.style;
  const d = decisionOn(runtime, artifact);
  if (!d) return undefined;
  const where = whereFrom(d.channel, before);
  const who = `by ${d.approval.actor.id}`;
  if (d.approval.decision === "approve") return `${st.ok("✓")} accepted ${where} ${who} ${st.muted(label)}`;
  if (d.approval.decision === "reject") return `${st.bad("✗")} rejected ${where} ${who} ${st.muted(label)}`;
  return `${st.warn("↻")} sent back ${where} ${who} ${st.muted(label)}`;
}

/** The run moved on without this card: who knows where, so say it and follow. */
function movedLine(ctx: CliContext, run: Run | undefined): string {
  const st = ctx.out.style;
  if (!run) return st.warn("  the run is gone");
  if (run.state === "RUNNING")
    return `${st.warn("↻")} the run went on elsewhere ${st.muted("— following it here")}`;
  return `${st.warn("↻")} the run is ${run.state} now ${st.muted("(changed elsewhere)")}`;
}

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

/** Files the run changed against its base, `+added −removed path`, most changed first. */
export async function changedFilesOf(
  run: Run,
): Promise<Array<{ path: string; added: number; removed: number }>> {
  const base = run.workspace.baseCommit ?? run.workspace.baseRef;
  const r = await git(["diff", "--numstat", base], run.workspace.path);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [added, removed, path] = l.split("\t");
      return { path: path ?? "", added: Number(added) || 0, removed: Number(removed) || 0 };
    })
    .sort((x, y) => y.added + y.removed - (x.added + x.removed));
}

/**
 * What a gated document holds, for its card here and on the page of `jarvis ui` (ADR-0023 §3):
 * title, the gist, counts (`3 requirements · 1 risk · 2 open questions`), risks, open questions.
 */
export interface DocFacts {
  readonly doc: Record<string, unknown>;
  readonly title?: string;
  readonly summary?: string;
  readonly counts: ReadonlyArray<{ readonly text: string; readonly warn: boolean }>;
  readonly risks: readonly string[];
  readonly openQuestions: readonly string[];
}

/** The facts of a JSON result document; undefined for anything else (markdown, text). */
export function docFacts(name: string, text: string): DocFacts | undefined {
  const doc = name.endsWith(".json") ? parseDoc(text) : undefined;
  if (!doc) return undefined;
  const n = (v: unknown, one: string, warn = false) => {
    const k = count(v);
    return k > 0 ? [{ text: `${k} ${one}${k === 1 ? "" : "s"}`, warn }] : [];
  };
  return {
    doc,
    ...(typeof doc.title === "string" ? { title: doc.title } : {}),
    ...(typeof doc.summary === "string" ? { summary: doc.summary } : {}),
    counts: [
      ...n(doc.requirements, "requirement"),
      ...n(doc.goals, "goal"),
      ...n(doc.risks, "risk"),
      ...n(doc.openQuestions, "open question", true),
      ...n(doc.contradictions, "contradiction", true),
    ],
    risks: strings(doc.risks),
    openQuestions: strings(doc.openQuestions),
  };
}

/**
 * The card before the decision, summary first (terraform's plan, a diff before an approval): title,
 * the gist, what the document holds, its first risks, the files an implementation changed, and a
 * link to the whole document — enough to decide whether to read it whole.
 */
async function brief(
  ctx: CliContext,
  runtime: Runtime,
  run: Run,
  type: string,
  a: ArtifactVersion,
  text: string,
): Promise<Record<string, unknown> | undefined> {
  const st = ctx.out.style;
  const facts = docFacts(a.name, text);
  const doc = facts?.doc;
  ctx.out.line();
  if (facts) {
    ctx.out.line(`  ${st.heading(facts.title ?? `${type}/${a.name}`)}`);
    if (facts.summary !== undefined) ctx.out.line(`  ${cut(facts.summary, 320)}`);
    const parts = facts.counts.map((c) => (c.warn ? st.warn(c.text) : c.text));
    if (parts.length > 0) ctx.out.line(`  ${parts.join(st.muted(" · "))}`);
    for (const risk of facts.risks.slice(0, 2)) ctx.out.line(`  ${st.warn("risk")} ${cut(risk, 160)}`);
  } else {
    for (const line of text.split("\n").slice(0, 8)) ctx.out.line(`  ${line}`);
  }
  const partial = incompleteOf(a);
  if (partial)
    ctx.out.line(`  ${st.warn(`⚠ incomplete: agent ${partial.agentId} hit its ${partial.limit} limit`)}`);
  if (type === "implementation") {
    const files = await changedFilesOf(run).catch(() => []);
    if (files.length > 0) {
      const sum = (k: "added" | "removed") => files.reduce((n, f) => n + f[k], 0);
      ctx.out.line(
        `  ${files.length} file${files.length === 1 ? "" : "s"} changed ${st.add(`+${sum("added")}`)} ${st.del(`−${sum("removed")}`)}`,
      );
      for (const f of files.slice(0, 8))
        ctx.out.line(
          `    ${st.add(`+${f.added}`.padStart(5))} ${st.del(`−${f.removed}`.padEnd(5))} ${f.path}`,
        );
      if (files.length > 8) ctx.out.line(`    ${st.muted(`… ${files.length - 8} more: jarvis diff`)}`);
    }
  }
  if (st.links)
    ctx.out.line(`  ${st.muted("whole:")} ${artifactLink(st, runtime, a, `${type}/${a.name}@${a.version}`)}`);
  return doc;
}

/** Prints what was picked up over the waiting question and says how the gate ends. */
function pickedUp(ctx: CliContext, runtime: Runtime, runId: string, p: Pickup): GateResult {
  ctx.out.interject(p.line, "");
  const now = runtime.runs.get(runId);
  if (p.moved || (now && now.state !== "WAITING_HUMAN")) {
    if (!p.moved) ctx.out.line(movedLine(ctx, now));
    return "elsewhere";
  }
  return "decided";
}

/** Keys of the gate; Enter never accepts. */
const KEYS: ReadonlyArray<[string, string, string]> = [
  ["enter", "read it whole", "the whole document, in $PAGER when there is one"],
  ["a", "accept", "approve this version; the run goes on"],
  ["c", "send back", "answer the open questions one by one here, then say what else to change"],
  ["e", "send back in $EDITOR", "the same, written in your editor from a template with the questions"],
  ["q", "decide later", "leave the run waiting; `jarvis continue` comes back here"],
  ["?", "help", "what each key does"],
];

/** `o` on a gate of a run with its own checkout (a worktree): the changes in the person's editor. */
const OPEN_KEY: [string, string, string] = [
  "o",
  "open in editor",
  "the run's checkout in your editor ($JARVIS_EDITOR, else code, webstorm, idea…); the card stays",
];

function keysFor(withOpen: boolean): ReadonlyArray<[string, string, string]> {
  return withOpen ? [...KEYS.slice(0, 4), OPEN_KEY, ...KEYS.slice(4)] : KEYS;
}

/** Accessible mode: numbers instead of keys, one per line. */
function numbered(keys: ReadonlyArray<[string, string, string]>, answer: string): string | undefined {
  const key = keys[Number(answer) - 1]?.[0];
  return key === undefined ? undefined : key === "enter" ? "" : key;
}

function menu(ctx: CliContext, withOpen: boolean): void {
  const st = ctx.out.style;
  if (ctx.out.accessible) {
    ctx.out.line();
    keysFor(withOpen).forEach(([, what], i) => {
      ctx.out.line(`  ${i + 1}. ${what}`);
    });
    return;
  }
  const item = (key: string, what: string) => `${st.cmd(key)} ${st.muted(what)}`;
  ctx.out.line();
  ctx.out.line(
    `  ${[item("enter", "read it whole"), item("a", "accept"), item("c", "send back with changes"), item("e", "…in $EDITOR"), ...(withOpen ? [item("o", "open in editor")] : []), item("q", "decide later"), item("?", "help")].join("    ")}`,
  );
}

function help(ctx: CliContext, withOpen: boolean): void {
  const st = ctx.out.style;
  const keys = keysFor(withOpen);
  const w = Math.max(...keys.map(([k]) => k.length));
  for (const [key, , what] of keys) ctx.out.line(`  ${st.cmd(key.padEnd(w))}  ${st.inline(what)}`);
}

export interface GateTools {
  /** Shows text in a pager; false when there is none (the text is printed instead). */
  readonly pager?: (text: string) => boolean;
  /** Opens a file in the person's editor and waits; false when it could not. */
  readonly editor?: (file: string) => boolean;
  /** Opens a shell in the run's checkout and waits (a used-up loop, `s`). */
  readonly shell?: ShellIn;
  /** Opens the run's checkout in the person's editor, without waiting (`o`). */
  readonly open?: OpenIn;
}

/** `$PAGER` (or `less`), with colours and quitting at once on a short text, as git does. */
export function systemPager(ctx: CliContext): (text: string) => boolean {
  return (text) => {
    const env = ctx.env ?? {};
    if (!ctx.out.live || env.JARVIS_PAGER === "off") return false;
    const pager = env.PAGER ?? "less";
    if (!pager || pager === "cat") return false;
    const r = spawnSync(pager, {
      input: text,
      stdio: ["pipe", "inherit", "inherit"],
      shell: true,
      env: { ...process.env, ...env, LESS: env.LESS ?? "FRX" },
    });
    return r.status === 0;
  };
}

/** `$VISUAL`, `$EDITOR`, then `vi`; may carry arguments (`code -w`). */
export function systemEditor(ctx: CliContext): (file: string) => boolean {
  return (file) => {
    const env = ctx.env ?? {};
    const editor = env.VISUAL || env.EDITOR || "vi";
    const r = spawnSync(`${editor} "${file.replace(/"/g, '\\"')}"`, {
      stdio: "inherit",
      shell: true,
      env: { ...process.env, ...env },
    });
    return r.status === 0;
  };
}

/** The template a comment is written in; lines starting with `#` are dropped. */
export function editorTemplate(label: string, questions: readonly string[]): string {
  return [
    `# Send ${label} back with changes. Lines starting with # are dropped; an empty file sends nothing.`,
    "#",
    ...(questions.length > 0
      ? [
          "# Open questions — answer under each:",
          ...questions.flatMap((q, i) => [`# ${i + 1}) ${q}`, "", ""]),
        ]
      : []),
    "# What else to change:",
    "",
    "",
  ].join("\n");
}

/** The comment from a filled template: answers keyed to their questions, then the rest. */
export function commentFromTemplate(text: string, questions: readonly string[]): string {
  const answers = new Map<number, string[]>();
  const extra: string[] = [];
  let current: number | "extra" | undefined;
  for (const line of text.split("\n")) {
    const q = /^#\s*(\d+)\)/.exec(line);
    if (q) {
      current = Number(q[1]);
      continue;
    }
    if (/^#\s*What else to change/.test(line)) {
      current = "extra";
      continue;
    }
    if (line.startsWith("#")) continue;
    if (current === undefined || current === "extra") extra.push(line);
    else answers.set(current, [...(answers.get(current) ?? []), line]);
  }
  const answered = [...answers.entries()]
    .map(([i, lines]) => [i, lines.join("\n").trim()] as const)
    .filter(([, a]) => a.length > 0)
    .map(([i, a]) => `${i}) ${questions[i - 1] ?? ""}\n   → ${a.replace(/\n/g, "\n     ")}`);
  const parts = [
    answered.length > 0 ? `Answers to the open questions:\n${answered.join("\n")}` : "",
    extra.join("\n").trim(),
  ].filter(Boolean);
  return parts.join("\n\n");
}

/** Answers to the document's open questions, then anything else; empty when nothing was said. */
async function changes(
  ctx: CliContext,
  prompt: Prompt,
  doc: Record<string, unknown> | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const at = signal ? { signal } : {};
  const st = ctx.out.style;
  const questions = strings(doc?.openQuestions);
  const answers: string[] = [];
  if (questions.length > 0) {
    ctx.out.line(`  ${st.muted("answer the open questions (empty line skips one):")}`);
    for (const [i, q] of questions.entries()) {
      ctx.out.line(`  ${st.warn(`${i + 1}/${questions.length}`)} ${q}`);
      const a = await prompt.ask(`  ${st.cmd(">")} `, at);
      if (a === undefined) return undefined;
      if (a) answers.push(`${i + 1}) ${q}\n   → ${a}`);
    }
  }
  ctx.out.line(`  ${st.muted("what else to change? (empty line sends)")}`);
  const extra: string[] = [];
  for (;;) {
    const line = await prompt.ask(`  ${st.cmd(">")} `, at);
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

/**
 * A back edge used up its rounds (ADR-0004 §3): the step kept sending the work back. The card says
 * why the last round failed, one reason a line, and where the run's checkout is; `s` opens a shell
 * there, `r` runs the step again with the person's fix, `q` leaves it. Pilot: the gate left at once
 * ("left waiting"), then a path of hashes and one long line of reasons.
 */
async function loopGate(
  ctx: CliContext,
  runtime: Runtime,
  run: Run,
  prompt: Prompt,
  shell: ShellIn,
  open: OpenIn,
  actor: Actor,
): Promise<GateResult> {
  const st = ctx.out.style;
  const record = runtime.artifacts.listLatest(run.id, "loop-exhausted")[0];
  const doc = record ? parseDoc(runtime.artifacts.text(record)) : undefined;
  const edge = typeof doc?.edge === "string" ? doc.edge : (run.waitingFor?.detail ?? "a back edge");
  const route = /^(.+)->(.+)#(.+)$/.exec(edge);
  const reasonText = typeof doc?.reason === "string" ? doc.reason : "";
  const reasons = reasonsOf(reasonText);
  const step = run.currentStep ?? "the step";
  const dir = run.workspace.path;
  const env = ctx.env ?? {};
  const width = ctx.out.columns - 1;
  ctx.out.line();
  ctx.out.line(
    `${st.warn("⏸")} ${st.heading(`${step} sent the work back ${typeof doc?.iterations === "number" ? `${doc.iterations} times` : "too often"}`)} ${st.muted(`— ${route ? `${route[1]} → ${route[2]}, ${route[3]}` : edge}; no rounds left`)}`,
  );
  // kinds in a column, so the reasons start at one place
  const pad = Math.min(16, Math.max(0, ...reasons.map((r) => r.kind?.length ?? 0)));
  const bullet = (r: Reason) =>
    `  ${st.warn("•")} ${r.kind ? `${st.heading(r.kind)}${" ".repeat(Math.max(0, pad - r.kind.length))}  ` : ""}${r.text}`;
  for (const r of reasons.slice(0, 4)) ctx.out.line(cutStyled(bullet(r), width));
  if (reasons.length > 4) ctx.out.line(st.muted(`  +${reasons.length - 4} more — enter shows them`));
  ctx.out.line();
  ctx.out.line(
    `  ${st.muted("fix it by hand in the run's checkout")}  ${checkoutLink(st, dir, ctx.homeDir)}`,
  );
  const changedLine = (changes: readonly Change[]) =>
    cutStyled(
      `  ${st.muted("changed")}  ${formatChanges(changes, st)}  ${st.muted(`· r runs ${step} again with them`)}`,
      width,
    );
  const already = changesIn(dir);
  if (already && already.length > 0) ctx.out.line(changedLine(already));
  const keys: Array<[string, string, string]> = [
    ["", "enter", "reasons"],
    ["o", "o", "open in your editor"],
    ["s", "s", "a shell there"],
    ["r", "r", `run ${step} again`],
    ["q", "q", "later"],
  ];
  const question = `${st.cmd(">")} `;
  // asked from the page before this card opened (`jarvis ui`, no terminal waiting): do it now
  const asked = rerunRequested(runtime, run.id);
  if (asked) {
    ctx.out.line(
      `${st.warn("↻")} running ${step} again ${st.muted(`(asked ${whereFrom(asked.channel, true)}${asked.actor ? ` by ${asked.actor}` : ""})`)}`,
    );
    return "decided";
  }
  // what the person does in the editor shows up on the card by itself
  const watch = () => watchCheckout(dir, (changes) => ctx.out.interject(changedLine(changes), question));
  let stopWatching = watch();
  // and what is decided elsewhere: "Run again" on the page, a `jarvis resume` in another tab
  const elsewhere = watchRun(() => {
    const now = runtime.runs.get(run.id);
    if (now?.state !== "WAITING_HUMAN") return { line: movedLine(ctx, now), moved: true };
    const again = rerunRequested(runtime, run.id);
    return again
      ? {
          line: `${st.warn("↻")} ${step} runs again ${st.muted(`(asked ${whereFrom(again.channel, false)}${again.actor ? ` by ${again.actor}` : ""})`)}`,
          moved: false,
        }
      : undefined;
  }, pollMs(ctx));
  const closeCard = openCard(runtime, run, "loop");
  const rerun = () => {
    requestRerun(runtime, run, actor, "cli");
    ctx.out.line(`${st.warn("↻")} running ${step} again`);
    return "decided" as const;
  };
  try {
    for (;;) {
      ctx.out.line();
      if (ctx.out.accessible) {
        for (const [i, [, , what]] of keys.entries()) ctx.out.line(`  ${i + 1}. ${what}`);
        ctx.out.bell();
      } else
        ctx.out.line(`  ${keys.map(([, key, what]) => `${st.cmd(key)} ${st.muted(what)}`).join("    ")}`);
      const answer = await prompt.ask(question, { signal: elsewhere.signal });
      const seen = elsewhere.seen();
      if (seen) return pickedUp(ctx, runtime, run.id, seen);
      const picked = ctx.out.accessible && answer !== undefined ? keys[Number(answer) - 1]?.[0] : undefined;
      const input = picked ?? answer;
      if (input === undefined || input === "q") return "detached";
      if (input === "") {
        if (reasons.length === 0) ctx.out.line(st.muted("  (no reason recorded)"));
        for (const r of reasons) ctx.out.line(bullet(r));
        continue;
      }
      if (input === "o") {
        // the files the reasons name first, at their lines, then what the run changed
        const files = reviewFiles(dir, run.workspace.baseCommit ?? run.workspace.baseRef, reasonText);
        const editor = open(dir, files);
        ctx.out.line(
          editor
            ? `  ${st.ok("↗")} opened in ${editor}${files.length > 0 ? `: ${describeFiles(files)}` : ""} ${st.muted(`· this card watches the checkout — save there, then r here`)}`
            : st.warn(
                `  no editor found — set JARVIS_EDITOR (code, idea, webstorm…); the checkout is ${homePath(dir, ctx.homeDir)}`,
              ),
        );
        continue;
      }
      if (input === "s") {
        const rule = st.muted("─".repeat(Math.max(10, Math.min(width, 72) - 4)));
        ctx.out.line();
        ctx.out.line(`  ${rule}`);
        ctx.out.line(
          `  ${st.heading(`a shell in the run's checkout`)} ${st.muted(homePath(dir, ctx.homeDir))}`,
        );
        ctx.out.line(
          `  fix what is listed above, then type ${st.cmd("jarvis c")} — ${step} runs again from here`,
        );
        ctx.out.line(st.muted(`  exit (Ctrl-D) — back to this card without going on`));
        ctx.out.line(`  ${rule}`);
        if (env.JARVIS_TITLE !== "off")
          ctx.out.terminal(
            passthrough(titleSequence(`jarvis ${shortRunId(run.id)} · fix, then jarvis c`), env),
          );
        stopWatching(); // the shell owns the terminal
        prompt.pause?.();
        const end = await shell(dir, run).finally(() => prompt.resume?.());
        if (end === "failed") {
          ctx.out.line(st.warn(`  could not start a shell; the checkout is ${dir}`));
          stopWatching = watch();
          continue;
        }
        ctx.out.line();
        const changes = changesIn(dir);
        if (changes && changes.length > 0) ctx.out.line(changedLine(changes));
        else if (changes) ctx.out.line(st.muted("  nothing changed in the checkout"));
        if (end === "go-on") return rerun();
        if (env.JARVIS_TITLE !== "off")
          ctx.out.terminal(passthrough(titleSequence(`⏸ jarvis ${shortRunId(run.id)}`), env));
        ctx.out.line(st.muted(`  back from the shell — r runs ${step} again with what you changed`));
        stopWatching = watch();
        continue;
      }
      if (input === "r") return rerun();
      ctx.out.line(st.muted(ctx.out.accessible ? "  1–5" : "  enter, o, s, r or q"));
    }
  } finally {
    stopWatching();
    elsewhere.stop();
    closeCard();
  }
}

const amount = (n: number) => n.toLocaleString("en-US");

/** What a grant says, in a line: "+40 tool calls" or "finish with what it has". */
function grantLine(stop: Pick<BudgetStop, "dimension">, g: { finish: boolean; amount?: number }): string {
  return g.finish ? "finish with what it has" : `+${amount(g.amount ?? 0)} ${unitOf(stop.dimension)}`;
}

/**
 * A run stopped on a budget (src/app/budgetStop.ts): a cap of the run or the step, or the agent's own
 * limit on a step with `onLimit: ask`. Enter grants half the cap again and goes on from where the step
 * stopped; `m` another amount; `f` finishes the step with what it has (marked incomplete). Pilot: the
 * stop parked the run and `jarvis continue` showed nothing.
 */
async function budgetGate(
  ctx: CliContext,
  runtime: Runtime,
  run: Run,
  prompt: Prompt,
  actor: Actor,
): Promise<GateResult> {
  const st = ctx.out.style;
  const stop = budgetStopOf(runtime, run);
  if (!stop) return "detached";
  const unit = unitOf(stop.dimension);
  const width = ctx.out.columns - 1;
  ctx.out.line();
  ctx.out.line(
    `${st.warn("⏸")} ${st.heading(`${stop.stepId} stopped: ${amount(stop.used)} of ${amount(stop.cap)} ${unit}`)} ${st.muted(`— ${sourceOf(stop)}`)}`,
  );
  ctx.out.line(
    `  ${st.muted(
      stop.scope === "agent"
        ? "its conversation is kept: more calls go on from where it stopped"
        : "the step goes on from its last model call; the cap grows for this run only",
    )}`,
  );
  if (run.workspace.mode === "worktree") {
    const changes = changesIn(run.workspace.path);
    if (changes && changes.length > 0)
      ctx.out.line(cutStyled(`  ${st.muted("changed")}  ${formatChanges(changes, st)}`, width));
  }
  // granted on the page before this card opened: go on with it
  const before = budgetGranted(runtime, run.id);
  if (before) {
    ctx.out.line(
      `${st.warn("↻")} ${grantLine(stop, before)} ${st.muted(`(${whereFrom(before.channel, true)}${before.actor ? ` by ${before.actor}` : ""})`)}`,
    );
    return "decided";
  }
  const keys: Array<[string, string, string]> = [
    ["", "enter", `+${amount(stop.suggested)} ${unit} and go on`],
    ["m", "m", "another amount"],
    ["f", "f", "finish with what it has (marked incomplete)"],
    ["q", "q", "later"],
  ];
  const question = `${st.cmd(">")} `;
  const elsewhere = watchRun(() => {
    const now = runtime.runs.get(run.id);
    if (now?.state !== "WAITING_HUMAN") return { line: movedLine(ctx, now), moved: true };
    const g = budgetGranted(runtime, run.id);
    return g
      ? {
          line: `${st.warn("↻")} ${grantLine(stop, g)} ${st.muted(`(${whereFrom(g.channel, false)}${g.actor ? ` by ${g.actor}` : ""})`)}`,
          moved: false,
        }
      : undefined;
  }, pollMs(ctx));
  const closeCard = openCard(runtime, run, "budget");
  const grant = (choice: { more: number } | { finish: true }) => {
    grantBudget(runtime, run, stop, actor, choice, "cli");
    ctx.out.line(
      `${st.warn("↻")} ${"finish" in choice ? `${stop.stepId} finishes with what it has` : `+${amount(choice.more)} ${unit} — ${stop.stepId} goes on`}`,
    );
    return "decided" as const;
  };
  try {
    for (;;) {
      ctx.out.line();
      if (ctx.out.accessible) {
        for (const [i, [, , what]] of keys.entries()) ctx.out.line(`  ${i + 1}. ${what}`);
        ctx.out.bell();
      } else
        ctx.out.line(`  ${keys.map(([, key, what]) => `${st.cmd(key)} ${st.muted(what)}`).join("    ")}`);
      const answer = await prompt.ask(question, { signal: elsewhere.signal });
      const seen = elsewhere.seen();
      if (seen) return pickedUp(ctx, runtime, run.id, seen);
      const picked = ctx.out.accessible && answer !== undefined ? keys[Number(answer) - 1]?.[0] : undefined;
      const input = picked ?? answer;
      if (input === undefined || input === "q") return "detached";
      if (input === "") return grant({ more: stop.suggested });
      if (input === "f") return grant({ finish: true });
      if (input === "m") {
        const raw = await prompt.ask(`  how many more ${unit}? `, { signal: elsewhere.signal });
        const again = elsewhere.seen();
        if (again) return pickedUp(ctx, runtime, run.id, again);
        const n = Number((raw ?? "").replace(/[\s,_]/g, ""));
        if (Number.isInteger(n) && n > 0) return grant({ more: n });
        ctx.out.line(st.muted("  a whole number above zero"));
        continue;
      }
      ctx.out.line(st.muted(ctx.out.accessible ? "  1–4" : "  enter, m, f or q"));
    }
  } finally {
    elsewhere.stop();
    closeCard();
  }
}

interface Reason {
  readonly kind?: string;
  readonly text: string;
}

/**
 * `lint_error: …; stray_files: …` — the reasons agents return, joined with "; " (ADR-0004 §4). Split
 * only before a `kind:`, so a "; " inside a reason stays.
 */
export function reasonsOf(text: string): Reason[] {
  const parts = text
    .split(/;\s+(?=[a-z][a-z0-9_]*:\s)/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.map((p) => {
    const m = /^([a-z][a-z0-9_]*):\s+([\s\S]*)$/.exec(p);
    return m
      ? { kind: m[1] as string, text: (m[2] as string).replace(/\s+/g, " ") }
      : { text: p.replace(/\s+/g, " ") };
  });
}

export async function humanGate(
  ctx: CliContext,
  runtime: Runtime,
  parked: Run,
  actor: Actor,
  prompt: Prompt,
  tools: GateTools = {},
): Promise<GateResult> {
  const pager = tools.pager ?? systemPager(ctx);
  const editor = tools.editor ?? systemEditor(ctx);
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
  const open = tools.open ?? systemOpener(ctx);
  if (run.waitingFor?.kind === "budget") return budgetGate(ctx, runtime, run, prompt, actor);
  if (run.waitingFor?.kind === "loop")
    return loopGate(ctx, runtime, run, prompt, tools.shell ?? systemShell(ctx), open, actor);
  const awaited = awaitedArtifact(runtime, run);
  if (!awaited) return "detached";
  const { type, artifact } = awaited;
  const label = `${type}/${artifact.name}@${artifact.version}`;
  // decided before this card opened (`jarvis approve`, the page): go on with that decision
  const before = decisionLine(ctx, runtime, artifact, label, true);
  if (before) {
    ctx.out.line();
    ctx.out.line(before);
    return "decided";
  }
  const text = runtime.artifacts.text(artifact);
  const doc = await brief(ctx, runtime, run, type, artifact, text);
  // a run with a checkout of its own: its changes open in the person's editor from the card
  const withOpen = run.workspace.mode === "worktree";
  // the same decision may come from the page or another terminal while the card waits (ADR-0023 §4)
  const elsewhere = watchRun(() => {
    const now = runtime.runs.get(run.id);
    const line = decisionLine(ctx, runtime, artifact, label);
    if (now?.state !== "WAITING_HUMAN") {
      const moved = movedLine(ctx, now);
      return { line: line ? `${line}\n${moved}` : moved, moved: true };
    }
    return line ? { line, moved: false } : undefined;
  }, pollMs(ctx));
  const closeCard = openCard(runtime, run, "approval");
  const at = { signal: elsewhere.signal };
  /** Records the person's decision; one made meanwhile elsewhere wins and is followed. */
  const decide = (
    decision: "approve" | "request_changes",
    comment: string | undefined,
    done: string,
  ): GateResult => {
    try {
      recordDecision(runtime, run, {
        actor,
        artifact,
        type,
        decision,
        ...(comment ? { comment } : {}),
        channel: "cli",
      });
    } catch (error) {
      if (!(error instanceof DecisionTakenError)) throw error;
      ctx.out.line(st.warn(`  ${error.message} — yours is not recorded`));
      return pickedUp(ctx, runtime, run.id, {
        line: decisionLine(ctx, runtime, artifact, label) ?? "",
        moved: false,
      });
    }
    ctx.out.line(done);
    return "decided";
  };
  try {
    for (;;) {
      menu(ctx, withOpen);
      if (ctx.out.accessible) ctx.out.bell(); // a decision is waiting
      const answer = await prompt.ask(`${st.cmd(">")} `, at);
      const seen = elsewhere.seen();
      if (seen) return pickedUp(ctx, runtime, run.id, seen);
      const input =
        ctx.out.accessible && answer !== undefined ? (numbered(keysFor(withOpen), answer) ?? answer) : answer;
      if (input === undefined || input === "q") return "detached";
      if (input === "") {
        const whole = renderMarkdown((doc ? documentToMarkdown(doc) : text).trimEnd(), st);
        if (pager(`${whole}\n`)) continue;
        ctx.out.line(st.muted("─".repeat(60)));
        ctx.out.raw(whole);
        ctx.out.line(st.muted("─".repeat(60)));
        continue;
      }
      if (input === "?") {
        help(ctx, withOpen);
        continue;
      }
      if (input === "o" && withOpen) {
        const files = reviewFiles(run.workspace.path, run.workspace.baseCommit ?? run.workspace.baseRef);
        const editor = open(run.workspace.path, files);
        ctx.out.line(
          editor
            ? `  ${st.ok("↗")} opened the run's changes in ${editor}${files.length > 0 ? `: ${describeFiles(files)}` : ""}`
            : st.warn(`  no editor found — set JARVIS_EDITOR (code, idea, webstorm…)`),
        );
        continue;
      }
      if (input === "e") {
        const questions = strings(doc?.openQuestions);
        const dir = mkdtempSync(join(tmpdir(), "jarvis-comment-"));
        const file = join(dir, "COMMENT.md");
        try {
          writeFileSync(file, editorTemplate(label, questions));
          if (!editor(file)) {
            ctx.out.line(st.muted("  the editor did not finish; choose again (c asks here)"));
            continue;
          }
          const comment = commentFromTemplate(readFileSync(file, "utf8"), questions);
          if (!comment) {
            ctx.out.line(st.muted("  nothing to send; choose again"));
            continue;
          }
          return decide("request_changes", comment, `${st.warn("↻")} sent back ${label} with your changes`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      if (input === "a") return decide("approve", undefined, `${st.ok("✓")} accepted ${label}`);
      if (input === "c") {
        const comment = await changes(ctx, prompt, doc, elsewhere.signal);
        const meanwhile = elsewhere.seen();
        if (meanwhile) return pickedUp(ctx, runtime, run.id, meanwhile);
        if (comment === undefined) return "detached";
        if (!comment) {
          ctx.out.line(st.muted("  nothing to send; choose again"));
          continue;
        }
        return decide("request_changes", comment, `${st.warn("↻")} sent back ${label} with your changes`);
      }
      ctx.out.line(st.muted("  enter, a, c, e, q or ? for help"));
    }
  } finally {
    elsewhere.stop();
    closeCard();
  }
}
