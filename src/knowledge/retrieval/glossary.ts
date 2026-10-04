import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Glossary (ADR-0015 §3): `.jarvis/knowledge/glossary.md`, a markdown table
 * `термин | синонимы | символы/модули | источники | обновлено`. Query expansion is deterministic and
 * every expansion is reported, so the trace shows why a term was searched.
 */
export interface GlossaryEntry {
  readonly term: string;
  readonly synonyms: string[];
  readonly symbols: string[];
  readonly sources: string[];
  /** Optional sixth column: what the term means, in the project's own words. */
  readonly definition?: string;
}

export function parseGlossary(markdown: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  for (const line of markdown.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 3) continue;
    if (/^-+$/.test(cells[0] ?? "") || /^(термин|term)/i.test(cells[0] ?? "")) continue;
    const split = (s: string | undefined) =>
      (s ?? "")
        .split(/[,;]/)
        .map((x) => x.trim().replace(/^`|`$/g, ""))
        .filter(Boolean);
    entries.push({
      term: cells[0] as string,
      synonyms: split(cells[1]),
      symbols: split(cells[2]),
      sources: split(cells[3]),
      ...(cells[5] ? { definition: cells[5] } : {}),
    });
  }
  return entries;
}

export function loadGlossary(projectRoot: string | undefined): GlossaryEntry[] {
  if (!projectRoot) return [];
  const file = join(projectRoot, ".jarvis", "knowledge", "glossary.md");
  return existsSync(file) ? parseGlossary(readFileSync(file, "utf8")) : [];
}

export interface Expansion {
  readonly term: string;
  readonly added: string[];
}

/** Adds synonyms and code symbols of every glossary term that occurs in the query. */
export function expandQuery(
  query: string,
  glossary: readonly GlossaryEntry[],
): { terms: string[]; expansions: Expansion[] } {
  const lower = query.toLowerCase();
  const tokens = tokenize(query);
  const terms = new Set(tokens);
  const expansions: Expansion[] = [];
  // Inflected forms (заявка / заявки / заявку) match on a stem: the term minus its last two letters.
  const matches = (t: string) => {
    const term = t.toLowerCase();
    if (lower.includes(term)) return true;
    const words = term.split(/\s+/);
    return words.every((w) => {
      const stem = w.length >= 5 ? w.slice(0, w.length - 2) : w;
      return tokens.some((tok) => tok.startsWith(stem));
    });
  };
  for (const e of glossary) {
    const hit = [e.term, ...e.synonyms].some((t) => t.length > 0 && matches(t));
    if (!hit) continue;
    const added = [...e.synonyms, ...e.symbols].filter((t) => t.length > 0 && !terms.has(t.toLowerCase()));
    for (const a of added) terms.add(a.toLowerCase());
    if (added.length > 0) expansions.push({ term: e.term, added });
  }
  return { terms: [...terms], expansions };
}

/**
 * Glossary entries whose term or synonym occurs in `text` as a whole word or phrase (case-insensitive).
 * Unlike `expandQuery` this does not stem: it answers "what does RTL mean", not "what to search for".
 */
export function matchTerms(text: string, glossary: readonly GlossaryEntry[]): GlossaryEntry[] {
  const hay = text.toLowerCase();
  const found = (needle: string) => {
    const n = needle.toLowerCase().trim();
    if (!n) return false;
    let from = 0;
    for (;;) {
      const at = hay.indexOf(n, from);
      if (at < 0) return false;
      const before = hay[at - 1];
      const after = hay[at + n.length];
      const word = /[\p{L}\p{N}_]/u;
      if (!(before && word.test(before)) && !(after && word.test(after))) return true;
      from = at + 1;
    }
  };
  return glossary.filter((e) => [e.term, ...e.synonyms].some(found));
}

export function tokenize(text: string): string[] {
  return [
    ...new Set(
      (text.toLowerCase().match(/[\p{L}\p{N}_][\p{L}\p{N}_.-]*/gu) ?? []).filter((t) => t.length > 2),
    ),
  ];
}
