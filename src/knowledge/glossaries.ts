import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { isPlainObject } from "../core/config/merge.ts";
import { serviceRepos } from "../core/config/meta.ts";
import { layoutOf, metaConfigFile } from "../core/paths.ts";
import { type GlossaryEntry, parseGlossary } from "./retrieval/glossary.ts";

export { symbolOf } from "./retrieval/glossary.ts";

/**
 * Glossaries of a knowledge repository (ADR-0025): a shared one — the domain's terms, `knowledge/
 * glossary.md` — and one per service, `knowledge/services/<service>/glossary.md`, for the terms of its
 * code. A run in a service reads the shared one, its own and those of the libraries it `uses`; the
 * knowledge repository itself reads them all. A term several services share in one sense lives in the
 * shared glossary, its symbols said by service (`orders-api:OrderEntity`); a term that means different
 * things in two services stays in each, and the shared glossary says it is a homonym. Pilot: one
 * glossary for 38 services, a service's own glossary read by nothing, and every symbol of the shared one
 * «not in the code» — it was looked for in the knowledge repository, which has no code.
 */
export interface GlossaryFile {
  /** `shared`, or the service whose glossary it is. */
  readonly scope: string;
  readonly file: string;
  /** The code its symbols are in (a service's repository); none when it is not on this machine. */
  readonly codeRoot?: string;
}

export const SHARED = "shared";

interface MetaMap {
  readonly repos: Readonly<Record<string, string>>;
  readonly uses: Readonly<Record<string, readonly string[]>>;
}

const maps = new Map<string, { at: number; map: MetaMap }>();

/** The knowledge repository's map: where each service's repository is, which libraries it uses. */
function metaMapOf(metaRoot: string, repos?: Readonly<Record<string, string>>): MetaMap {
  const file = metaConfigFile(metaRoot);
  let at = 0;
  try {
    at = statSync(file).mtimeMs;
  } catch {
    return { repos: repos ?? {}, uses: {} };
  }
  const known = maps.get(file);
  let map = known && known.at === at ? known.map : undefined;
  if (!map) {
    let doc: Record<string, unknown> = {};
    try {
      const raw = parse(readFileSync(file, "utf8")) as unknown;
      doc = isPlainObject(raw) ? raw : {};
    } catch {
      doc = {};
    }
    const services = isPlainObject(doc.services) ? doc.services : {};
    const uses: Record<string, string[]> = {};
    for (const [name, def] of Object.entries(services))
      if (isPlainObject(def) && Array.isArray(def.uses))
        uses[name] = def.uses.filter((x): x is string => typeof x === "string");
    map = { repos: serviceRepos(metaRoot, doc, undefined, homedir()), uses };
    maps.set(file, { at, map });
  }
  return repos ? { ...map, repos: { ...map.repos, ...repos } } : map;
}

const cloned = (path: string | undefined) => (path && existsSync(path) ? path : undefined);

/**
 * The glossaries `root` reads, the shared one first: a plain project — its own; a service of a
 * knowledge repository — the shared, its own, its libraries'; the knowledge repository — all.
 * `repos`: where the services' repositories are on this machine, when known better than the map says.
 */
export function glossaryFilesOf(root: string, repos?: Readonly<Record<string, string>>): GlossaryFile[] {
  const layout = layoutOf(root);
  const meta = layout.meta;
  if (!meta) return [{ scope: SHARED, file: layout.glossaryFile, codeRoot: root }];
  const map = metaMapOf(meta.root, repos);
  const serviceFile = (name: string) => join(meta.knowledgeRoot, "services", name, "glossary.md");
  const own = (name: string): GlossaryFile => {
    const code = name === meta.service ? root : cloned(map.repos[name]);
    return { scope: name, file: serviceFile(name), ...(code ? { codeRoot: code } : {}) };
  };
  const shared: GlossaryFile = {
    scope: SHARED,
    file: join(meta.knowledgeRoot, "glossary.md"),
    ...(meta.service ? { codeRoot: root } : {}),
  };
  if (meta.service) return [shared, own(meta.service), ...(map.uses[meta.service] ?? []).map(own)];
  const services = join(meta.knowledgeRoot, "services");
  const names = existsSync(services)
    ? readdirSync(services)
        .filter((n) => existsSync(serviceFile(n)))
        .sort()
    : [];
  return [shared, ...names.map(own)];
}

/** A glossary entry with the glossary it is in. */
export interface ScopedEntry extends GlossaryEntry {
  /** `shared`, or the service whose glossary has it. */
  readonly scope: string;
}

/** Every term `root` reads, each with its glossary (the shared ones first). */
export function loadGlossaries(root: string, repos?: Readonly<Record<string, string>>): ScopedEntry[] {
  return glossaryFilesOf(root, repos).flatMap((g) =>
    existsSync(g.file)
      ? parseGlossary(readFileSync(g.file, "utf8")).map((e) => ({ ...e, scope: g.scope }))
      : [],
  );
}

/** Every service whose repository the knowledge repository knows on this machine (for a shared symbol). */
export function serviceCodeRoots(
  root: string,
  repos?: Readonly<Record<string, string>>,
): Record<string, string> {
  const meta = layoutOf(root).meta;
  if (!meta) return {};
  const out: Record<string, string> = {};
  for (const [name, path] of Object.entries(metaMapOf(meta.root, repos).repos)) {
    const c = cloned(path);
    if (c) out[name] = c;
  }
  return out;
}

/**
 * A term's key for telling two rows are the same term: lower case, without what the brackets explain
 * («Справочная запись ОКВЭД (code/title/…)» → «справочная запись оквэд»), spaces squashed.
 */
export function termKey(term: string): string {
  return term
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Two entries are the same term: the same key, or one's term is the other's synonym. A synonym two
 * terms share is not enough (both widen by it — a problem said on the glossary page, not a duplicate).
 */
export function sameTerm(a: GlossaryEntry, b: GlossaryEntry): boolean {
  const ka = termKey(a.term);
  const kb = termKey(b.term);
  return (
    ka !== "" &&
    (ka === kb || b.synonyms.some((s) => termKey(s) === ka) || a.synonyms.some((s) => termKey(s) === kb))
  );
}

/** The shared glossary's row that says a term is a homonym: its sense differs by service. */
export const isHomonym = (e: Pick<GlossaryEntry, "definition">) => /^homonym\b/i.test(e.definition ?? "");

/** The same term in two glossaries: where the shared glossary or a service's could have it once. */
export interface GlossaryDuplicate {
  readonly term: string;
  readonly scopes: readonly string[];
}

export function glossaryDuplicates(entries: readonly ScopedEntry[]): GlossaryDuplicate[] {
  const out: GlossaryDuplicate[] = [];
  const seen = new Set<number>();
  entries.forEach((e, i) => {
    if (seen.has(i)) return;
    const same = entries.map((x, j) => [x, j] as const).filter(([x, j]) => j !== i && sameTerm(e, x));
    const scopes = [...new Set([e.scope, ...same.map(([x]) => x.scope)])];
    for (const [, j] of same) seen.add(j);
    // a homonym the shared glossary says: two senses, kept apart on purpose
    if (same.length > 0 && !isHomonym(e) && !same.some(([x]) => isHomonym(x)))
      out.push({ term: e.term, scopes });
  });
  return out;
}
