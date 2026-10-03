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

export interface TrimOptions {
  /** Tool results among the newest N are left alone. */
  readonly keepRecent: number;
  /** Results shorter than this are not worth a pointer. */
  readonly minChars?: number;
  /** Stores the full text, returns a reference the agent can read back. */
  readonly store: (text: string) => string;
}

export interface TrimResult {
  readonly transcript: Message[];
  readonly trimmed: number;
  readonly savedChars: number;
}

const HEAD_CHARS = 240;

export function trimToolResults(transcript: readonly Message[], options: TrimOptions): TrimResult {
  const minChars = options.minChars ?? 600;
  const toolIndexes = transcript.flatMap((m, i) => (m.role === "tool" ? [i] : []));
  const protectedIndexes = new Set(toolIndexes.slice(Math.max(0, toolIndexes.length - options.keepRecent)));
  let trimmed = 0;
  let savedChars = 0;
  const next = transcript.map((m, i) => {
    if (m.role !== "tool" || protectedIndexes.has(i)) return m;
    if (m.content.length < minChars || m.content.includes(TRIMMED_MARKER)) return m;
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
  readonly summarize: (rendered: string, previousHandoff?: string) => Promise<string>;
  readonly kind: "compact" | "reset";
}

export interface CompactResult {
  readonly transcript: Message[];
  readonly compactedBlocks: number;
  readonly original: string;
  readonly originals: string[];
  readonly summary: string;
}

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
  const summary = await options.summarize(renderForSummary(toSummarize), previous);
  const handoff: Message = {
    role: "user",
    content: [
      `${HANDOFF_HEADING} (${options.kind === "reset" ? "reset" : "compacted"})`,
      "",
      summary.trim(),
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
  };
}

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
