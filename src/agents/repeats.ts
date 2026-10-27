import type { Message } from "../models/types.ts";

/**
 * The same read again in one step: an issue, a page, a search, a listing the step already has an answer
 * to is not run and not counted — the answer says where the first one is. Pilot (a task across
 * services): research asked for its own issue three times with different `fields`, searched the same
 * word in the same folder twice, and stopped at its 40 calls asking for more.
 * A file read has its own ledger (src/agents/rereads.ts); a write makes the workspace's reads stale.
 */

/** Calls answered by their own ledger or that mark progress: never a repeat. */
const OWN = new Set(["repo.read", "plan.step"]);

/** The workspace's reads: stale after a write in the step. */
const WORKSPACE = /^(repo|code|graph|project)\./;

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${k}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/** What makes two calls the same: an issue by its key, a page by its id (their fields and formats aside), else every argument. */
export function repeatKey(name: string, args: Record<string, unknown>): string | undefined {
  if (OWN.has(name)) return undefined;
  if (name === "jira.get" && typeof args.key === "string") return `jira.get:${args.key.trim().toUpperCase()}`;
  const page = args.id ?? args.pageId;
  if (name === "confluence.get" && (typeof page === "string" || typeof page === "number"))
    return `confluence.get:${String(page).trim()}`;
  return `${name}:${stable(args)}`;
}

export const ASKED_ALREADY = "(asked already in this step";

export class RepeatLedger {
  private readonly seen = new Map<string, string>();

  /** What the conversation already answered (a resumed step keeps knowing it). */
  static from(transcript: readonly Message[]): RepeatLedger {
    const ledger = new RepeatLedger();
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
        const content = results.get(call.id);
        if (content?.startsWith(`[${call.name}] ok`) && !content.includes(ASKED_ALREADY))
          ledger.answered(call.name, args, call.id);
      }
    }
    return ledger;
  }

  /** The call that answered this one already, if any. */
  first(name: string, args: Record<string, unknown>): string | undefined {
    const key = repeatKey(name, args);
    return key ? this.seen.get(key) : undefined;
  }

  answered(name: string, args: Record<string, unknown>, callId: string): void {
    const key = repeatKey(name, args);
    if (key && !this.seen.has(key)) this.seen.set(key, callId);
  }

  /** A write or a command changed the workspace: its reads are not the same any more. */
  changed(): void {
    for (const key of [...this.seen.keys()]) if (WORKSPACE.test(key)) this.seen.delete(key);
  }

  static text(name: string, first: string): string {
    return `[${name}] ok\n${ASKED_ALREADY}: the answer to call ${first} above is the same — use it; this did not count against your tool calls)`;
  }
}
