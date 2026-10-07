import type { Message } from "../models/types.ts";

/**
 * Transcript management (ADR-0001 §7, ADR-0013 §6). Two operations on the tool-calling transcript
 * that follows the byte-stable layers L0–L2 (and the L3/L4 working set):
 *
 *  - trimming: old tool results are replaced with a head and a pointer to the original blob;
 *  - compaction: older blocks are replaced with one structured handoff message, the originals kept
 *    as a blob — a summary is never the source of truth.
 *
 * Both are pure over their inputs; storing blobs and calling the model are injected.
 */

export const TRIMMED_MARKER = "[trimmed:";
export const HANDOFF_HEADING = "## Context handoff";

/** A unit that must stay together: an assistant message with its tool calls and their results. */
export function splitBlocks(transcript: readonly Message[]): Message[][] {
  const blocks: Message[][] = [];
  for (const message of transcript) {
    const last = blocks.at(-1);
    if (message.role === "tool" && last) last.push(message);
    else blocks.push([message]);
  }
  return blocks;
}

export function isHandoff(message: Message | undefined): boolean {
  return message?.role === "user" && message.content.startsWith(HANDOFF_HEADING);
}

/* ---- trimming ---- */

/**
 * Results of the task's own sources — the issue, its Confluence pages, its design frames (also as read
 * back with knowledge.read): short, and what the step is about. Kept under light pressure; pilot: they
 * were trimmed at 49% and the agent spent 12 of its tool calls reading them back.
 */
const SOURCE_RESULT = /^(?:\[knowledge\.read\] ok\n)?\[(?:jira|confluence|figma)\.[a-z.]+\]/;
export const isSourceResult = (content: string): boolean => SOURCE_RESULT.test(content);

export interface TrimOptions {
  /** Tool results among the newest N are left alone. */
  readonly keepRecent: number;
  /** Results to leave alone whatever their age (the task's sources under light pressure, files read again). */
  readonly keep?: (content: string, message: Message) => boolean;
  /** Results shorter than this are not worth a pointer. */
  readonly minChars?: number;
  /** Stores the full text, returns a reference the agent can read back. */
  readonly store: (text: string) => string;
  /**
   * Stop once this many characters are saved (default: trim every result it may). With it, the results
   * `first` picks go before the others, and each group oldest first.
   */
  readonly saveChars?: number;
  /** Results that are cheap to have again and rarely needed again (a search, a listing): trimmed first. */
  readonly first?: (message: Message) => boolean;
}

export interface TrimResult {
  readonly transcript: Message[];
  readonly trimmed: number;
  readonly savedChars: number;
}

const HEAD_CHARS = 240;

/** The tool behind each result, by its call id (the assistant message that asked for it). */
export function toolNamesOf(transcript: readonly Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of transcript) for (const c of m.toolCalls ?? []) names.set(c.id, c.name);
  return names;
}

/** Searches and listings: a pointer is as good as the result, and running them again is cheap. */
export const CHEAP_TO_REDO = /(?:^|[._])(?:search|list|grep|glob|find)$|^git[._](?:log|status)$/;

/** Tool results older than the `keepRecent` newest that a trim would shorten. */
export function trimmable(
  transcript: readonly Message[],
  keepRecent: number,
  minChars = 600,
  keep?: (content: string, message: Message) => boolean,
): number {
  const tools = transcript.filter((m) => m.role === "tool");
  return tools
    .slice(0, Math.max(0, tools.length - keepRecent))
    .filter(
      (m) => m.content.length >= minChars && !m.content.includes(TRIMMED_MARKER) && !keep?.(m.content, m),
    ).length;
}

export function trimToolResults(transcript: readonly Message[], options: TrimOptions): TrimResult {
  const minChars = options.minChars ?? 600;
  const toolIndexes = transcript.flatMap((m, i) => (m.role === "tool" ? [i] : []));
  const protectedIndexes = new Set(toolIndexes.slice(Math.max(0, toolIndexes.length - options.keepRecent)));
  let trimmed = 0;
  let savedChars = 0;
  const candidates = toolIndexes.filter((i) => {
    const m = transcript[i] as Message;
    if (protectedIndexes.has(i)) return false;
    if (m.content.length < minChars || m.content.includes(TRIMMED_MARKER)) return false;
    return !options.keep?.(m.content, m);
  });
  const chosen = new Set<number>();
  if (options.saveChars === undefined) for (const i of candidates) chosen.add(i);
  else {
    const rank = (i: number) => (options.first?.(transcript[i] as Message) ? 0 : 1);
    let planned = 0;
    for (const i of [...candidates].sort((a, b) => rank(a) - rank(b) || a - b)) {
      if (planned >= options.saveChars) break;
      chosen.add(i);
      planned += (transcript[i] as Message).content.length - HEAD_CHARS;
    }
  }
  const next = transcript.map((m, i) => {
    if (!chosen.has(i)) return m;
    const ref = options.store(m.content);
    const newline = m.content.indexOf("\n");
    const header = newline > 0 && newline < 200 ? m.content.slice(0, newline) : "";
    const body = m.content.slice(header.length).trimStart();
    const head = body.slice(0, HEAD_CHARS).replace(/\s+/g, " ");
    const content = `${header}${header ? "\n" : ""}${head}…\n${TRIMMED_MARKER} ${m.content.length} chars; original: blob:${ref} — read it with knowledge.read, or run the tool again]`;
    trimmed += 1;
    savedChars += m.content.length - content.length;
    return { ...m, content };
  });
  return { transcript: next, trimmed, savedChars };
}

/* ---- compaction ---- */

export interface CompactOptions {
  /** Newest blocks kept verbatim. */
  readonly keepBlocks: number;
  /** Token budget for the kept tail, newest first; at least `keepBlocks` blocks are kept regardless. */
  readonly tailBudgetTokens?: number;
  readonly estimate: (messages: readonly Message[]) => number;
  /** Stores the original of the compacted part; returns a reference. */
  readonly store: (json: string) => string;
  /** Produces the structured summary of the rendered head. */
  readonly summarize: (rendered: string, previousHandoff?: string) => Promise<Summary>;
  readonly kind: "compact" | "reset";
  /** Right before the summary is asked for: how many blocks go into it (a slow model call to show). */
  readonly onSummarize?: (blocks: number) => void;
}

/** What the summarizer gave: its text, and whether the model stopped at its output limit. */
export type Summary = string | { readonly text: string; readonly truncated?: boolean };

export interface CompactResult {
  readonly transcript: Message[];
  readonly compactedBlocks: number;
  readonly original: string;
  readonly originals: string[];
  readonly summary: string;
  /** The summary came back empty or cut off: the handoff carries the record of the calls as well. */
  readonly fallback?: "empty" | "truncated";
}

/**
 * Output for a summary: a reasoning model thinks before it writes, and its thinking counts against
 * the limit (pilot: at 2000 one handoff came back empty, the next cut off mid-sentence).
 */
export const SUMMARY_MAX_OUTPUT = 8000;

/** Shorter than this, a summary says nothing (pilot: a reasoning model spent its whole output thinking). */
const MIN_SUMMARY_CHARS = 40;
/** The task's sources carried verbatim into a handoff whose summary failed, at most this much. */
const SOURCES_CHARS = 12_000;

/** Plain-text rendering of messages for the summarizer; long tool results are shortened (originals stay in the blob). */
export function renderForSummary(messages: readonly Message[], perResultChars = 1500): string {
  return messages
    .map((m) => {
      if (m.role === "assistant") {
        const calls = (m.toolCalls ?? [])
          .map((c) => `  → ${c.name}(${c.arguments.slice(0, 300)})`)
          .join("\n");
        return `assistant: ${m.content.trim()}${calls ? `\n${calls}` : ""}`.trimEnd();
      }
      if (m.role === "tool") {
        const text =
          m.content.length > perResultChars
            ? `${m.content.slice(0, perResultChars)}… [${m.content.length - perResultChars} more chars]`
            : m.content;
        return `tool: ${text}`;
      }
      return `${m.role}: ${m.content}`;
    })
    .join("\n\n");
}

/** `originals:` line of an earlier handoff, so references accumulate instead of being re-summarised away. */
function earlierOriginals(handoff: string | undefined): string[] {
  if (!handoff) return [];
  const m = /^Originals: (.*)$/m.exec(handoff);
  return m?.[1]
    ? m[1]
        .split(",")
        .map((s) => s.trim().replace(/^blob:/, ""))
        .filter(Boolean)
    : [];
}

export async function compactTranscript(
  transcript: readonly Message[],
  options: CompactOptions,
): Promise<CompactResult | undefined> {
  const blocks = splitBlocks(transcript);
  // Keep the newest blocks that fit the tail budget (always at least keepBlocks of them).
  let keep = Math.min(options.keepBlocks, blocks.length);
  if (options.tailBudgetTokens !== undefined && options.keepBlocks > 0) {
    let used = 0;
    let fits = 0;
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      used += options.estimate(blocks[i] as Message[]);
      if (used > options.tailBudgetTokens) break;
      fits += 1;
    }
    keep = Math.min(blocks.length, Math.max(keep, fits));
  }
  const headBlocks = blocks.slice(0, blocks.length - keep);
  if (headBlocks.length === 0) return undefined;
  const tail = blocks.slice(blocks.length - keep).flat();
  const head = headBlocks.flat();
  const previous = isHandoff(head[0]) ? (head[0] as Message).content : undefined;
  const toSummarize = previous ? head.slice(1) : head;
  const original = options.store(JSON.stringify(head));
  const originals = [...earlierOriginals(previous), original];
  options.onSummarize?.(headBlocks.length);
  const got = await options.summarize(renderForSummary(toSummarize), previous);
  const text = (typeof got === "string" ? got : got.text).trim();
  const fallback =
    text.length < MIN_SUMMARY_CHARS
      ? "empty"
      : typeof got !== "string" && got.truncated
        ? "truncated"
        : undefined;
  // A summary that failed never replaces the history with nothing (pilot: an empty handoff, and the
  // agent read the issue, the pages and the files all over again): the earlier handoff, what was
  // written, the record of the calls with their originals, and the task's sources as they were.
  const summary =
    fallback === undefined
      ? text
      : [
          fallback === "empty"
            ? [
                "(The summary of this part came back empty: below is what was carried and the record of the calls.)",
                previous ? handoffBody(previous) : "",
              ]
                .filter(Boolean)
                .join("\n\n")
            : `${text}\n\n(The summary above was cut off at the model's output limit: the record of the calls below is complete.)`,
          callsRecord(toSummarize),
          sourcesOf(toSummarize),
        ]
          .filter(Boolean)
          .join("\n\n");
  const handoff: Message = {
    role: "user",
    content: [
      `${HANDOFF_HEADING} (${options.kind === "reset" ? "reset" : "compacted"})`,
      "",
      summary,
      "",
      `Originals: ${originals.map((o) => `blob:${o}`).join(", ")}`,
      "The originals hold the full tool results and reasoning of the part summarised above; read them with knowledge.read when an exact detail matters.",
    ].join("\n"),
  };
  return {
    transcript: [handoff, ...tail],
    compactedBlocks: headBlocks.length,
    original,
    originals,
    summary,
    ...(fallback ? { fallback } : {}),
  };
}

/** An earlier handoff without its heading and its references (they are written again below it). */
function handoffBody(handoff: string): string {
  return handoff
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith(HANDOFF_HEADING) &&
        !line.startsWith("Originals: ") &&
        !line.startsWith("The originals hold the full tool results"),
    )
    .join("\n")
    .trim();
}

/**
 * The calls of a part, recorded rather than summarised: each with its arguments and where its result
 * is — the blob of a trimmed result, else the originals of this part.
 */
export function callsRecord(messages: readonly Message[]): string {
  const results = new Map(messages.filter((m) => m.role === "tool").map((m) => [m.toolCallId, m.content]));
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.content.trim()) lines.push(`- noted: ${oneLine(m.content, 300)}`);
    for (const c of m.role === "assistant" ? (m.toolCalls ?? []) : []) {
      const result = results.get(c.id) ?? "";
      const blob = /original: (blob:[0-9a-f]+)/.exec(result)?.[1];
      const failed = /^\[[^\]]+\] (?:error|failed|denied)/.test(result);
      lines.push(
        `- ${c.name}(${oneLine(c.arguments, 200)})${failed ? " — failed" : ""}${blob ? ` — result: ${blob}` : result ? " — result in the originals" : ""}`,
      );
    }
  }
  return lines.length > 0 ? `### Calls made (recorded, not summarised)\n${lines.join("\n")}` : "";
}

/** The task's own sources (the issue, its pages, its frames) as read, newest last, within a budget. */
function sourcesOf(messages: readonly Message[]): string {
  const sources = messages.filter((m) => m.role === "tool" && isSourceResult(m.content));
  const seen = new Set<string>();
  const kept: string[] = [];
  let left = SOURCES_CHARS;
  for (const m of [...sources].reverse()) {
    // the same page read twice: once is enough
    if (seen.has(m.content) || m.content.includes(TRIMMED_MARKER) || m.content.length > left) continue;
    seen.add(m.content);
    kept.unshift(m.content);
    left -= m.content.length;
  }
  return kept.length > 0 ? `### The task's sources, as read\n\n${kept.join("\n\n")}` : "";
}

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export const SUMMARIZER_SYSTEM = `You compress the working history of an engineering agent into a handoff note. The agent continues from your note, so anything you leave out is lost to it (the originals stay on disk but the agent will not remember them).
Preserve, as short bullet lists under these headings: Goal; Requirements; Decisions; Business rules and constraints; Progress (what was done, which files were read or modified, with paths and line numbers); Unresolved questions; Next actions; Sources (file paths, artifact and blob references exactly as written).
Rules: never invent facts; keep identifiers, paths, numbers and quoted error messages verbatim; drop pleasantries, repeated attempts and raw dumps. If an earlier handoff is given, carry its content forward and update it — do not summarise it again from memory.`;

export function summarizerMessages(rendered: string, previousHandoff?: string): Message[] {
  return [
    { role: "system", content: SUMMARIZER_SYSTEM },
    {
      role: "user",
      content: `${previousHandoff ? `Earlier handoff to carry forward:\n${previousHandoff}\n\n` : ""}History to compress:\n\n${rendered}`,
    },
  ];
}
