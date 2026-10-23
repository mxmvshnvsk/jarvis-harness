import { createHash } from "node:crypto";

/**
 * Writes to one file going round, within an agent's step: the same file written again and again, or
 * written back to what it was a few calls before. The pilot's implementation «removed» a folder it had
 * no tool to remove by writing "", "null" and its old stub into the same files for twenty minutes; each
 * call was new to the stall check (different content), so nothing told it. The answer to such a write
 * says so, once per file and threshold.
 */
export const CHURN_WRITES = 5;

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export class WriteLedger {
  private readonly byPath = new Map<string, Array<{ callId: string; content?: string }>>();
  private readonly told = new Set<string>();

  /** A successful write's note for the agent, if its file goes round; undefined otherwise. */
  note(
    name: string,
    args: Record<string, unknown>,
    callId: string,
  ): { text: string; path: string; writes: number; back?: string } | undefined {
    if (name !== "repo.write" && name !== "repo.edit") return undefined;
    const path = typeof args.path === "string" ? args.path.replace(/^\.\//, "") : undefined;
    if (!path) return undefined;
    const content =
      name === "repo.write" && typeof args.content === "string" ? hash(args.content) : undefined;
    const list = this.byPath.get(path) ?? [];
    // back to an earlier content: not the last write's (that is a write of the same again)
    const back = content ? list.slice(0, -1).find((w) => w.content === content)?.callId : undefined;
    list.push({ callId, ...(content ? { content } : {}) });
    this.byPath.set(path, list);
    const key = back
      ? `${path} back`
      : list.length >= CHURN_WRITES
        ? `${path} ${list.length >= CHURN_WRITES * 2 ? 2 : 1}`
        : "";
    if (!key || this.told.has(key)) return undefined;
    this.told.add(key);
    return {
      path,
      writes: list.length,
      ...(back ? { back } : {}),
      text: `(${path}: written ${list.length} times in this step${back ? `, now back to what call ${back} wrote` : ""} — this is going round. If the step needs what your tools cannot do, stop and say so in the result's notes instead of working around it.)`,
    };
  }
}
