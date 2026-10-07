import type { Message } from "../models/types.ts";

/**
 * Searches that found nothing, again: the search still runs (files may have changed — a fresh result always
 * wins), but an empty answer to what was already searched empty — the same text, the same files or fewer —
 * says so, with the call that found nothing first. Pilot: one research step searched "slot" in the same
 * two files six times, as `glob` and as `path`, as `slot` and as `[Ss]lot`, every time empty.
 */

export const SEARCHED_EMPTY = "(searched already:";

interface Search {
  readonly pattern: string;
  /** Folder or file the search covered; "." is the whole workspace. */
  readonly scope: string;
  /** A glob that filters files (`*.tsx`), not a place. */
  readonly filter?: string;
}

/** `[Ss]lot`, `SLOT`, `\bslot\b` → `slot`: a search that differs only in case or word marks is the same search. */
function normal(pattern: string): string {
  return pattern
    .replace(/\\b/g, "")
    .replace(/\[([A-Za-z])([A-Za-z])\]/g, (m, a: string, b: string) =>
      a.toLowerCase() === b.toLowerCase() ? a : m,
    )
    .toLowerCase()
    .trim();
}

const clean = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "") || ".";

export function searchOf(name: string, args: Record<string, unknown>): Search | undefined {
  if (name !== "repo.search" || typeof args.pattern !== "string" || !args.pattern.trim()) return undefined;
  const path = typeof args.path === "string" ? clean(args.path) : ".";
  const glob = typeof args.glob === "string" ? args.glob.trim() : "";
  // a glob that only names a place (`apps/server/**`, `src/a.ts`) is a scope; with wildcards it filters
  const place = glob.replace(/\/\*\*(\/\*)?$/, "");
  const isPlace = glob !== "" && !/[*?{[]/.test(place);
  return {
    pattern: normal(args.pattern),
    scope: isPlace ? (path === "." ? clean(place) : `${path}/${clean(place)}`) : path,
    ...(glob && !isPlace ? { filter: glob } : {}),
  };
}

/** `b` searched nothing `a` did not: the same text, within the same place, no wider filter. */
function within(b: Search, a: Search): boolean {
  if (b.pattern !== a.pattern) return false;
  if (a.filter !== undefined && a.filter !== b.filter) return false;
  return a.scope === "." || b.scope === a.scope || b.scope.startsWith(`${a.scope}/`);
}

const isEmpty = (content: string) => content.trim() === "[repo.search] ok";

export class SearchLedger {
  private readonly empty: Array<{ search: Search; callId: string }> = [];

  /** What the conversation already holds: the searches that found nothing. */
  static from(transcript: readonly Message[]): SearchLedger {
    const ledger = new SearchLedger();
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
        const search = searchOf(call.name, args);
        const content = results.get(call.id);
        if (search && content !== undefined && (isEmpty(content) || content.includes(SEARCHED_EMPTY)))
          ledger.empty.push({ search, callId: call.id });
      }
    }
    return ledger;
  }

  /** The result to put into the conversation for this search (`content` — the tool's answer as formatted). */
  answer(
    name: string,
    args: Record<string, unknown>,
    callId: string,
    content: string,
  ): { content: string; kind: "first" | "empty-again" } {
    const search = searchOf(name, args);
    if (!search || !isEmpty(content)) return { content, kind: "first" };
    const before = this.empty.find((e) => within(search, e.search));
    this.empty.push({ search, callId });
    if (!before) return { content, kind: "first" };
    const where = before.search.scope === "." ? "the whole workspace" : before.search.scope;
    return {
      content: `${content}\n${SEARCHED_EMPTY} call ${before.callId} searched "${before.search.pattern}" in ${where}${before.search.filter ? ` (${before.search.filter})` : ""} and found nothing, as now. The text is not in these files, in any case: look for another name, or in another place.)`,
      kind: "empty-again",
    };
  }
}
