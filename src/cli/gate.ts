import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitedArtifact, recordDecision } from "../app/decide.ts";
import type { Runtime } from "../app/runtime.ts";
import type { Actor } from "../core/domain/actor.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import type { Run } from "../core/domain/run.ts";
import { git } from "../tools/local/exec.ts";
import { changesIn, checkoutLink, formatChanges, homePath, type ShellIn, systemShell } from "./checkout.ts";
import { clarifyLoop } from "./commands/human.ts";
import type { CliContext } from "./context.ts";
import type { Prompt } from "./prompt.ts";
import { documentToMarkdown, renderMarkdown } from "./render.ts";
import { cutStyled, incompleteOf } from "./style.ts";
import { artifactLink } from "./view.ts";

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
    for (const risk of strings(doc.risks).slice(0, 2)) ctx.out.line(`  ${st.warn("risk")} ${cut(risk, 160)}`);
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

/** Keys of the gate; Enter never accepts. */
const KEYS: ReadonlyArray<[string, string, string]> = [
  ["enter", "read it whole", "the whole document, in $PAGER when there is one"],
  ["a", "accept", "approve this version; the run goes on"],
  ["c", "send back", "answer the open questions one by one here, then say what else to change"],
  ["e", "send back in $EDITOR", "the same, written in your editor from a template with the questions"],
  ["q", "decide later", "leave the run waiting; `jarvis continue` comes back here"],
  ["?", "help", "what each key does"],
];

/** Accessible mode: numbers instead of keys, one per line. */
const NUMBERED: Record<string, string> = { "1": "", "2": "a", "3": "c", "4": "e", "5": "q", "6": "?" };

function menu(ctx: CliContext): void {
  const st = ctx.out.style;
  if (ctx.out.accessible) {
    ctx.out.line();
    KEYS.forEach(([, what], i) => {
      ctx.out.line(`  ${i + 1}. ${what}`);
    });
    return;
  }
  const item = (key: string, what: string) => `${st.cmd(key)} ${st.muted(what)}`;
  ctx.out.line();
  ctx.out.line(
    `  ${[item("enter", "read it whole"), item("a", "accept"), item("c", "send back with changes"), item("e", "…in $EDITOR"), item("q", "decide later"), item("?", "help")].join("    ")}`,
  );
}

function help(ctx: CliContext): void {
  const st = ctx.out.style;
  const w = Math.max(...KEYS.map(([k]) => k.length));
  for (const [key, , what] of KEYS) ctx.out.line(`  ${st.cmd(key.padEnd(w))}  ${st.inline(what)}`);
}

export interface GateTools {
  /** Shows text in a pager; false when there is none (the text is printed instead). */
  readonly pager?: (text: string) => boolean;
  /** Opens a file in the person's editor and waits; false when it could not. */
  readonly editor?: (file: string) => boolean;
  /** Opens a shell in the run's checkout and waits (a used-up loop, `s`). */
  readonly shell?: ShellIn;
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
): Promise<GateResult> {
  const st = ctx.out.style;
  const record = runtime.artifacts.listLatest(run.id, "loop-exhausted")[0];
  const doc = record ? parseDoc(runtime.artifacts.text(record)) : undefined;
  const edge = typeof doc?.edge === "string" ? doc.edge : (run.waitingFor?.detail ?? "a back edge");
  const route = /^(.+)->(.+)#(.+)$/.exec(edge);
  const reasons = reasonsOf(typeof doc?.reason === "string" ? doc.reason : "");
  const step = run.currentStep ?? "the step";
  const dir = run.workspace.path;
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
  const keys: Array<[string, string, string]> = [
    ["", "enter", "reasons in full"],
    ["s", "s", "a shell in the checkout"],
    ["r", "r", `run ${step} again`],
    ["q", "q", "later"],
  ];
  for (;;) {
    ctx.out.line();
    if (ctx.out.accessible) {
      for (const [i, [, , what]] of keys.entries()) ctx.out.line(`  ${i + 1}. ${what}`);
      ctx.out.bell();
    } else ctx.out.line(`  ${keys.map(([, key, what]) => `${st.cmd(key)} ${st.muted(what)}`).join("    ")}`);
    const answer = await prompt.ask(`${st.cmd(">")} `);
    const picked = ctx.out.accessible && answer !== undefined ? keys[Number(answer) - 1]?.[0] : undefined;
    const input = picked ?? answer;
    if (input === undefined || input === "q") return "detached";
    if (input === "") {
      if (reasons.length === 0) ctx.out.line(st.muted("  (no reason recorded)"));
      for (const r of reasons) ctx.out.line(bullet(r));
      continue;
    }
    if (input === "s") {
      ctx.out.line(
        st.muted(
          `  a shell in ${homePath(dir, ctx.homeDir)} — fix, then \`exit\` (Ctrl-D) back to this card and r`,
        ),
      );
      if (!shell(dir, run)) {
        ctx.out.line(st.warn(`  could not start a shell; the checkout is ${dir}`));
        continue;
      }
      const changes = changesIn(dir);
      if (changes && changes.length > 0)
        ctx.out.line(cutStyled(`  ${st.muted("changed:")} ${formatChanges(changes, st)}`, width));
      else if (changes) ctx.out.line(st.muted("  nothing changed in the checkout"));
      continue;
    }
    if (input === "r") {
      ctx.out.line(`${st.warn("↻")} running ${step} again`);
      return "decided";
    }
    ctx.out.line(st.muted(ctx.out.accessible ? "  1–4" : "  enter, s, r or q"));
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
  if (run.waitingFor?.kind === "loop")
    return loopGate(ctx, runtime, run, prompt, tools.shell ?? systemShell(ctx));
  const awaited = awaitedArtifact(runtime, run);
  if (!awaited) return "detached";
  const { type, artifact } = awaited;
  const text = runtime.artifacts.text(artifact);
  const doc = await brief(ctx, runtime, run, type, artifact, text);
  const label = `${type}/${artifact.name}@${artifact.version}`;
  for (;;) {
    menu(ctx);
    if (ctx.out.accessible) ctx.out.bell(); // a decision is waiting
    const answer = await prompt.ask(`${st.cmd(">")} `);
    const input =
      ctx.out.accessible && answer !== undefined && answer in NUMBERED ? NUMBERED[answer] : answer;
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
      help(ctx);
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
        recordDecision(runtime, run, { actor, artifact, type, decision: "request_changes", comment });
        ctx.out.line(`${st.warn("↻")} sent back ${label} with your changes`);
        return "decided";
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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
    ctx.out.line(st.muted("  enter, a, c, e, q or ? for help"));
  }
}
