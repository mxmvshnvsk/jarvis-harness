import { createHash } from "node:crypto";
import { TRIMMED_MARKER } from "../context/transcript.ts";
import type { Message } from "../models/types.ts";

/**
 * Files an agent reads again in one step (pilot: in one research step a file was read 62 times — its
 * result was trimmed a few calls after each read, and the agent read it once more).
 *
 * - The same lines of an unchanged file, whose earlier result is still in the conversation: a short
 *   answer pointing at that result instead of the text again.
 * - Read before, but trimmed or folded away since: the text again, and that result is pinned —
 *   light pressure (watch, compact) does not trim it; heavy pressure and compaction still may.
 * - Changed since: the text, marked as changed.
 *
 * Built from the conversation itself, so a resumed step knows what was read before it parked.
 */
export const UNCHANGED = "(unchanged:";
const PINNED_NOTE = "(read again: kept in your context from now on)";
const CHANGED_NOTE = "(changed since your read in call";
/** The tool's answer without the notes added here: what the hash is of. */
const plain = (content: string) =>
  content.replace(/\n\((?:read again: kept|changed since your read)[^\n]*\)$/, "");

interface Read {
  readonly callId: string;
  /** Of the result as the agent got it; undefined when only its trimmed form is left. */
  readonly hash?: string;
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

/** Which reads count as the same: one path and one range. */
export function readKey(name: string, args: Record<string, unknown>): string | undefined {
  if (name !== "repo.read" || typeof args.path !== "string") return undefined;
  const path = args.path.replace(/^\.\//, "");
  return `${path}#${args.startLine ?? ""}-${args.endLine ?? ""}`;
}

export class ReadLedger {
  private readonly reads = new Map<string, Read>();
  private readonly pins = new Set<string>();

  /** What the conversation already holds: the last full read of each file and the pinned results. */
  static from(transcript: readonly Message[]): ReadLedger {
    const ledger = new ReadLedger();
    const results = new Map(
      transcript.filter((m) => m.role === "tool").map((m) => [m.toolCallId, m.content]),
    );
    for (const m of transcript) {
      if (m.role !== "assistant") continue;
      for (const call of m.toolCalls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
        } catch {
          continue;
        }
        const key = readKey(call.name, args);
        const content = results.get(call.id);
        if (
          !key ||
          content === undefined ||
          !/^\[repo\.read\] ok/.test(content) ||
          content.includes(UNCHANGED)
        )
          continue;
        const trimmed = content.includes(TRIMMED_MARKER);
        ledger.reads.set(key, { callId: call.id, ...(trimmed ? {} : { hash: hashOf(plain(content)) }) });
        if (content.includes(PINNED_NOTE)) ledger.pins.add(call.id);
      }
    }
    return ledger;
  }

  pinned(toolCallId: string): boolean {
    return this.pins.has(toolCallId);
  }

  /** The result to put into the conversation for this read (`content` — the tool's answer as formatted). */
  answer(
    key: string | undefined,
    callId: string,
    content: string,
    transcript: readonly Message[],
  ): { content: string; kind: "first" | "unchanged" | "again" | "changed" } {
    if (!key || !/^\[repo\.read\] ok/.test(content)) return { content, kind: "first" };
    const hash = hashOf(content);
    const before = this.reads.get(key);
    this.reads.set(key, { callId, hash });
    if (!before) return { content, kind: "first" };
    const earlier = transcript.find((m) => m.role === "tool" && m.toolCallId === before.callId);
    const intact = earlier !== undefined && !earlier.content.includes(TRIMMED_MARKER);
    if (intact && before.hash === hash) {
      // the earlier result stays the one to look at
      this.reads.set(key, before);
      const what = key.replace(/#-$/, "").replace(/#(\d*)-(\d*)$/, " (lines $1-$2)");
      return {
        content: `[repo.read] ok\n${UNCHANGED} you read ${what} in this step already and it has not changed — its text is in your context above, in the result of call ${before.callId}. Use it; do not read it again.)`,
        kind: "unchanged",
      };
    }
    if (before.hash !== undefined && before.hash !== hash)
      return { content: `${content}\n${CHANGED_NOTE} ${before.callId})`, kind: "changed" };
    // trimmed or folded away since: the agent needs the text — and keeps it this time
    this.pins.add(callId);
    return { content: `${content}\n${PINNED_NOTE}`, kind: "again" };
  }
}
