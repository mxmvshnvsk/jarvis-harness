import { loadGlossaries } from "../glossaries.ts";

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
  /** In a knowledge repository: `shared`, or the service whose glossary it is in. */
  readonly scope?: string;
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

/**
 * The terms a project reads: its glossary; in a knowledge repository the shared one, the service's own
 * and its libraries' (src/knowledge/glossaries.ts) — each entry with its `scope`.
 */
export function loadGlossary(projectRoot: string | undefined): GlossaryEntry[] {
  if (!projectRoot) return [];
  return loadGlossaries(projectRoot);
}

/**
 * A symbol of the shared glossary may say whose it is: `orders-api:OrderEntity`. Its service and its
 * name; a plain symbol has no service.
 */
export function symbolOf(raw: string): { readonly service?: string; readonly name: string } {
  const t = raw.trim();
  const m = /^([a-z0-9][a-z0-9._-]*):(?!:)(\S.*)$/i.exec(t);
  return m && !/^[a-z]:[\\/]/i.test(t)
    ? { service: m[1] as string, name: (m[2] as string).trim() }
    : { name: t };
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
    // the term as a word or a phrase, not inside another word («ТС» in «статус»)
    if (wholeIn(lower, term)) return true;
    const words = term.split(/\s+/);
    return words.every((w) => {
      const stem = w.length >= 5 ? w.slice(0, w.length - 2) : w;
      return tokens.some((tok) => tok.startsWith(stem));
    });
  };
  for (const e of glossary) {
    const hit = [e.term, ...e.synonyms].some((t) => t.length > 0 && matches(t));
    if (!hit) continue;
    // a shared term's symbol says its service (`orders-api:OrderEntity`): the code knows only the name
    const added = [...e.synonyms, ...e.symbols.map((x) => symbolOf(x).name)].filter(
      (t) => t.length > 0 && !terms.has(t.toLowerCase()),
    );
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

function wholeIn(hay: string, needle: string): boolean {
  if (!needle) return false;
  const word = /[\p{L}\p{N}_]/u;
  for (let from = 0; ; ) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return false;
    const before = hay[at - 1];
    const after = hay[at + needle.length];
    if (!(before && word.test(before)) && !(after && word.test(after))) return true;
    from = at + 1;
  }
}
