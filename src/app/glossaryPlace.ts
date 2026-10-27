import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { layoutOf } from "../core/paths.ts";
import { isHomonym, SHARED, sameTerm, serviceCodeRoots, symbolOf } from "../knowledge/glossaries.ts";
import { type GlossaryEntry, parseGlossary } from "../knowledge/retrieval/glossary.ts";
import {
  addGlossaryTerm,
  cell,
  checkSymbols,
  extendGlossaryTerm,
  GlossaryTermTaken,
  type NewTerm,
  type SymbolCheck,
} from "./knowledgeView.ts";

/**
 * Where a new term goes in a knowledge repository, and what a duplicate becomes (src/knowledge/
 * glossaries.ts): the shared glossary has it — the service's symbols join its row, said by service; the
 * service has it — its row gets the symbols; another service has it — nothing is written: whether it
 * is one sense or two is a person's call (a candidate: «shared» or «homonym»). A plain project has one
 * glossary and none of this.
 */

/** The file of a glossary: `shared` — the project's (or the knowledge repository's shared one), else a service's. */
export function glossaryFileFor(root: string, scope: string): string {
  const layout = layoutOf(root);
  if (scope === SHARED || !layout.meta) return layout.glossaryFile;
  return join(layout.meta.knowledgeRoot, "services", scope, "glossary.md");
}

/** The glossary a term from `root` goes to by default: its service's, else the shared one. */
export const defaultScopeOf = (root: string): string => layoutOf(root).meta?.service ?? SHARED;

/** Every glossary of the knowledge repository `root` belongs to (all services', not only those it reads). */
function everyGlossary(root: string): Array<{ scope: string; file: string }> {
  const layout = layoutOf(root);
  const out = [{ scope: SHARED, file: layout.glossaryFile }];
  if (!layout.meta) return out;
  const services = join(layout.meta.knowledgeRoot, "services");
  if (existsSync(services))
    for (const name of readdirSync(services).sort()) {
      const file = join(services, name, "glossary.md");
      if (existsSync(file)) out.push({ scope: name, file });
    }
  return out;
}

/** The glossaries a person can add a term to from `root`: a service's run — its own and the shared; the knowledge repository — the shared and every service's. */
export function glossaryScopesOf(root: string): string[] {
  const layout = layoutOf(root);
  if (!layout.meta) return [SHARED];
  if (layout.meta.service) return [layout.meta.service, SHARED];
  const services = join(layout.meta.knowledgeRoot, "services");
  const names = existsSync(services)
    ? readdirSync(services, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];
  return [SHARED, ...names];
}

/** The glossaries that have the term (by `sameTerm`), with its row there. */
export function whereTerm(
  root: string,
  term: Pick<GlossaryEntry, "term" | "synonyms">,
): Array<{ scope: string; file: string; entry: GlossaryEntry }> {
  const probe: GlossaryEntry = { term: term.term, synonyms: [...term.synonyms], symbols: [], sources: [] };
  return everyGlossary(root).flatMap((g) => {
    const hit = parseGlossary(readFileSync(g.file, "utf8")).find((e) => sameTerm(probe, e));
    return hit ? [{ ...g, entry: hit }] : [];
  });
}

export type Placement =
  | {
      readonly placed: "added" | "extended";
      readonly scope: string;
      readonly file: string;
      readonly line: number;
      readonly term: string;
    }
  /** Another service's glossary has it: one sense or two is for a person to say. */
  | { readonly conflict: { readonly scope: string; readonly term: string }; readonly scope: string };

const prefixed = (scope: string, symbols: readonly string[]) =>
  scope === SHARED ? [...symbols] : symbols.map((s) => (symbolOf(s).service ? s : `${scope}:${s}`));

/**
 * Puts a term where it belongs (see above). `taken`: what a term the same glossary already has does —
 * `extend` adds the new symbols to its row (a run's candidate), `throw` refuses (a person adding it).
 */
export function placeTerm(
  root: string,
  t: NewTerm,
  scope = defaultScopeOf(root),
  options: { readonly taken?: "extend" | "throw"; readonly today?: Date } = {},
): Placement {
  const today = options.today ?? new Date();
  const found = whereTerm(root, { term: t.term, synonyms: [...t.synonyms] });
  const shared = found.find((f) => f.scope === SHARED);
  const own = found.find((f) => f.scope === scope);
  const other = found.find((f) => f.scope !== SHARED && f.scope !== scope);
  // a homonym said in the shared glossary: each service keeps its own sense
  if (shared && isHomonym(shared.entry) && scope !== SHARED) {
    if (own && options.taken === "throw") throw new GlossaryTermTaken(own.entry.term);
    const { line } = own
      ? extendGlossaryTerm(root, own.entry.term, t.symbols, today, own.file)
      : addGlossaryTerm(root, t, today, glossaryFileFor(root, scope));
    return {
      placed: own ? "extended" : "added",
      scope,
      file: own?.file ?? glossaryFileFor(root, scope),
      line,
      term: own?.entry.term ?? t.term,
    };
  }
  // the shared glossary has it: a service's symbols join its row, said by service
  if (shared && scope !== SHARED) {
    const { line } = extendGlossaryTerm(
      root,
      shared.entry.term,
      prefixed(scope, t.symbols),
      today,
      shared.file,
    );
    return { placed: "extended", scope: SHARED, file: shared.file, line, term: shared.entry.term };
  }
  if (own) {
    if (options.taken === "throw") throw new GlossaryTermTaken(own.entry.term);
    const { line } = extendGlossaryTerm(root, own.entry.term, t.symbols, today, own.file);
    return { placed: "extended", scope, file: own.file, line, term: own.entry.term };
  }
  if (other && scope !== SHARED) return { conflict: { scope: other.scope, term: other.entry.term }, scope };
  const file = glossaryFileFor(root, scope);
  const { line } = addGlossaryTerm(root, t, today, file);
  return { placed: "added", scope, file, line, term: t.term };
}

/** The service whose glossary has the term when placing it in `scope` waits for a person (see placeTerm). */
export function conflictOf(
  root: string,
  t: Pick<GlossaryEntry, "term" | "synonyms">,
  scope = defaultScopeOf(root),
): string | undefined {
  if (scope === SHARED) return undefined;
  const found = whereTerm(root, t);
  if (found.some((f) => f.scope === SHARED || f.scope === scope)) return undefined;
  return found.find((f) => f.scope !== SHARED && f.scope !== scope)?.scope;
}

/** Takes a term's row out of a glossary file (it moved to the shared one). */
export function removeGlossaryTerm(file: string, term: string): void {
  const lines = readFileSync(file, "utf8").split("\n");
  const at = lines.findIndex((l) => {
    const cells = l.trim().startsWith("|") ? l.split("|").slice(1, -1) : [];
    return (cells[0] ?? "").trim().toLowerCase() === term.trim().toLowerCase();
  });
  if (at >= 0) {
    lines.splice(at, 1);
    writeFileSync(file, lines.join("\n"));
  }
}

/**
 * A person's call on a term two services have: `shared` — one sense: the row moves to the shared
 * glossary with both services' symbols said by service, synonyms and sources together; `homonym` — two
 * senses: the term goes to this service's glossary too, and the shared glossary says where each is.
 */
export function settleTerm(
  root: string,
  t: NewTerm,
  scope: string,
  other: string,
  as: "shared" | "homonym",
  today = new Date(),
): Placement {
  const there = whereTerm(root, { term: t.term, synonyms: [...t.synonyms] }).find((f) => f.scope === other);
  if (!there) return placeTerm(root, t, scope, { today });
  const e = there.entry;
  if (as === "shared") {
    const merged: NewTerm = {
      term: e.term,
      synonyms: [...new Set([...e.synonyms, ...t.synonyms])],
      symbols: [...prefixed(other, e.symbols), ...prefixed(scope, t.symbols)],
      sources: [...new Set([...e.sources, ...t.sources])],
      ...((e.definition ?? t.definition) ? { definition: (e.definition ?? t.definition) as string } : {}),
    };
    removeGlossaryTerm(there.file, e.term);
    const file = glossaryFileFor(root, SHARED);
    const { line } = addGlossaryTerm(root, merged, today, file);
    return { placed: "added", scope: SHARED, file, line, term: e.term };
  }
  const file = glossaryFileFor(root, scope);
  const { line } = addGlossaryTerm(root, t, today, file);
  const sharedFile = glossaryFileFor(root, SHARED);
  const note = `homonym — ${other}: ${cell(e.definition ?? e.term)}; ${scope}: ${cell(t.definition ?? t.term)}`;
  const shared = whereTerm(root, { term: e.term, synonyms: [] }).find((f) => f.scope === SHARED);
  if (!shared)
    addGlossaryTerm(
      root,
      { term: e.term, synonyms: [], symbols: [], sources: [], definition: note },
      today,
      sharedFile,
    );
  return { placed: "added", scope, file, line, term: t.term };
}

/**
 * A term's symbols looked for where they are: a service's glossary — in its repository; the shared one —
 * a symbol said by service in that service's, the rest in `root`. A repository not on this machine — in `root`.
 */
export async function checkScopedSymbols(
  root: string,
  scope: string,
  symbols: readonly string[],
  repos?: Readonly<Record<string, string>>,
): Promise<SymbolCheck[]> {
  const codes = serviceCodeRoots(root, repos);
  const byCode = new Map<string, string[]>();
  for (const raw of symbols) {
    const { service, name } = symbolOf(raw);
    const owner = service ?? (scope !== SHARED ? scope : undefined);
    const at = (owner && codes[owner]) || root;
    byCode.set(at, [...(byCode.get(at) ?? []), name]);
  }
  const out = await Promise.all(
    [...byCode].map(async ([at, names]) => [...(await checkSymbols(at, names)).values()]),
  );
  return out.flat();
}
