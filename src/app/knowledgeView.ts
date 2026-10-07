import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseFrontMatter } from "../knowledge/frontmatter.ts";
import { type GlossaryEntry, parseGlossary } from "../knowledge/retrieval/glossary.ts";
import { splitSections } from "../knowledge/retrieval/index.ts";
import { BUILTIN_SKILLS, loadSkills, type Skill } from "../knowledge/skills.ts";
import { loadSourceDocuments } from "../knowledge/sources.ts";
import { type KnowledgeRoots, loadStandards, type Standard } from "../knowledge/standards.ts";
import { MODULE_MARKER, ONBOARD_MARKER } from "../onboarding/render.ts";
import { trackedFiles } from "../onboarding/scan.ts";
import { shortRunId } from "../storage/runStore.ts";
import { git } from "../tools/local/exec.ts";
import type { Runtime } from "./runtime.ts";

/**
 * What the Knowledge pages of `jarvis ui` show (docs/adr/0024-knowledge-in-web-ui.md): the documents,
 * standards, skills and glossary as the agents get them, with what the journal says about their
 * use. Read-only, except adding a glossary term — documents, standards and skills are written in an
 * editor (by people or models), the page only shows them and opens the file.
 */

/* ---- use in runs ---- */

export interface Usage {
  /** Agent calls whose context package had it. */
  readonly calls: number;
  /** Runs among them. */
  readonly runs: number;
  /** Times an agent asked for it by name (knowledge.read). */
  readonly asked: number;
  readonly lastRun?: string;
  readonly lastAt?: string;
}

const USAGE_EVENTS = 20_000;
const USAGE_DAYS = 30;

/**
 * Use of knowledge over the last 30 days of the journal: `agent.start` carries the package's provenance
 * (`knowledge:<name>#sha`, `skill:<id>@v`, `standard:<id>@v`), `tool.call knowledge.read` an
 * explicit ask. Keyed without the version: `knowledge:<name>`, `skill:<id>`, `standard:<id>`.
 */
export function usageOf(runtime: Runtime, now = new Date()): Map<string, Usage> {
  const since = new Date(now.getTime() - USAGE_DAYS * 86_400_000).toISOString();
  const acc = new Map<
    string,
    { calls: number; runs: Set<string>; asked: number; lastRun?: string; lastAt?: string }
  >();
  const keyOf = (ref: string) => ref.replace(/[#@][^#@]*$/, "");
  const at = (key: string) => {
    const a = acc.get(key) ?? { calls: 0, runs: new Set<string>(), asked: 0 };
    acc.set(key, a);
    return a;
  };
  for (const e of runtime.events.list({ kind: "agent.start", since, limit: USAGE_EVENTS, latest: true })) {
    const refs = Array.isArray(e.payload?.knowledge) ? (e.payload.knowledge as unknown[]) : [];
    for (const r of refs) {
      if (typeof r !== "string") continue;
      const a = at(keyOf(r));
      a.calls += 1;
      if (e.runId) {
        a.runs.add(e.runId);
        if (!a.lastAt || e.ts > a.lastAt) {
          a.lastAt = e.ts;
          a.lastRun = e.runId;
        }
      }
    }
  }
  for (const e of runtime.events.list({ kind: "tool.call", since, limit: USAGE_EVENTS, latest: true })) {
    if (e.payload?.capability !== "knowledge.read" || typeof e.payload.args !== "string") continue;
    const ref = /"ref"\s*:\s*"([^"]+)"/.exec(e.payload.args)?.[1];
    if (ref) at(keyOf(ref)).asked += 1;
  }
  return new Map(
    [...acc.entries()].map(([k, a]) => [
      k,
      {
        calls: a.calls,
        runs: a.runs.size,
        asked: a.asked,
        ...(a.lastRun ? { lastRun: shortRunId(a.lastRun) } : {}),
        ...(a.lastAt ? { lastAt: a.lastAt } : {}),
      },
    ]),
  );
}

/* ---- documents ---- */

export interface DocView {
  /** Repository path. */
  readonly path: string;
  /** The name agents know it by (`knowledge:<name>`). */
  readonly name: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly paths: readonly string[];
  readonly agents: readonly string[];
  /** jarvis wrote it and nobody took it over (the marker is there). */
  readonly generated: boolean;
  /** From `knowledge.sources`: the team's documentation, read in place. */
  readonly source: boolean;
  readonly body: string;
  /** How the index cuts it: one unit per section. */
  readonly sections: ReadonlyArray<{ readonly heading: string; readonly chars: number }>;
  /** Last commit of the document (YYYY-MM-DD); none — not committed yet. */
  readonly edited?: string;
  /** Commits under its paths since that commit. */
  readonly staleCommits?: number;
  readonly usage?: Usage;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

async function lastCommit(root: string, file: string): Promise<{ hash: string; date: string } | undefined> {
  const r = await git(["log", "-1", "--format=%H %cs", "--", file], root);
  const [hash, date] = r.stdout.trim().split(" ");
  return r.code === 0 && hash && date ? { hash, date } : undefined;
}

async function commitsSince(
  root: string,
  hash: string,
  paths: readonly string[],
): Promise<number | undefined> {
  if (paths.length === 0) return undefined;
  const r = await git(
    ["rev-list", "--count", `${hash}..HEAD`, "--", ...paths.map((p) => `:(glob)${p}`)],
    root,
  );
  const n = Number(r.stdout.trim());
  return r.code === 0 && Number.isFinite(n) ? n : undefined;
}

function sectionsOf(body: string): DocView["sections"] {
  return splitSections(body).map((s) => ({ heading: s.heading ?? "(top)", chars: s.body.length }));
}

/** `.jarvis/knowledge/*.md` (not the glossary) and the `knowledge.sources` documents, skills aside. */
export async function docsOf(roots: KnowledgeRoots, usage?: ReadonlyMap<string, Usage>): Promise<DocView[]> {
  const root = roots.projectRoot;
  if (!root) return [];
  const out: Array<Omit<DocView, "edited" | "staleCommits">> = [];
  const dir = join(root, ".jarvis", "knowledge");
  const names = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md" && f !== "glossary.md")
    : [];
  for (const f of names.sort()) {
    const raw = readFileSync(join(dir, f), "utf8");
    const { data, body } = parseFrontMatter(raw);
    const u = usage?.get(`knowledge:${f}`);
    out.push({
      path: `.jarvis/knowledge/${f}`,
      name: f,
      title: /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? f,
      tags: strings(data.tags),
      paths: strings(data.paths),
      agents: strings(data.agents),
      generated: raw.includes(MODULE_MARKER) || raw.includes(ONBOARD_MARKER),
      source: false,
      body: body.replace(/^<!--[\s\S]*?-->\n?/gm, "").trim(),
      sections: sectionsOf(body),
      ...(u ? { usage: u } : {}),
    });
  }
  for (const d of loadSourceDocuments(roots)) {
    if (d.skill) continue;
    const u = usage?.get(`knowledge:${d.path}`);
    out.push({
      path: d.path,
      name: d.path,
      title: d.title ?? d.path,
      tags: d.tags,
      paths: d.paths,
      agents: d.agents,
      generated: false,
      source: true,
      body: d.text,
      sections: sectionsOf(d.text),
      ...(u ? { usage: u } : {}),
    });
  }
  return Promise.all(
    out.map(async (d) => {
      const last = await lastCommit(root, d.path);
      if (!last) return d;
      const stale = d.source ? undefined : await commitsSince(root, last.hash, d.paths);
      return { ...d, edited: last.date, ...(stale ? { staleCommits: stale } : {}) };
    }),
  );
}

/* ---- standards ---- */

export interface Finding {
  readonly run: string;
  readonly at: string;
  readonly file?: string;
  readonly line?: number;
  readonly detail: string;
}

export interface StandardView extends Standard {
  /** Repository path of its file (or `~/.jarvis/…` for a user one). */
  readonly path: string;
  /** What the deterministic check found in recent runs (`standards-check` of each run). */
  readonly findings: readonly Finding[];
  readonly usage?: Usage;
}

export function standardsOf(
  runtime: Runtime,
  roots: KnowledgeRoots,
  usage?: ReadonlyMap<string, Usage>,
): StandardView[] {
  const found = new Map<string, Finding[]>();
  for (const run of runtime.runs.list({ includeTerminal: true, limit: 60 })) {
    for (const a of runtime.artifacts.listLatest(run.id, "standards-check")) {
      try {
        const doc = JSON.parse(runtime.artifacts.text(a)) as {
          violations?: Array<{ standardId: string; file?: string; line?: number; detail: string }>;
        };
        for (const v of doc.violations ?? []) {
          const list = found.get(v.standardId) ?? [];
          list.push({
            run: shortRunId(run.id),
            at: a.createdAt,
            ...(v.file ? { file: v.file } : {}),
            ...(v.line ? { line: v.line } : {}),
            detail: v.detail.split("\n")[0] ?? "",
          });
          found.set(v.standardId, list);
        }
      } catch {
        // not a report
      }
    }
  }
  const root = roots.projectRoot ?? "";
  return loadStandards(roots).map((s) => {
    const u = usage?.get(`standard:${s.id}`);
    return {
      ...s,
      path: root && s.file.startsWith(root) ? relative(root, s.file).split("\\").join("/") : s.file,
      findings: (found.get(s.id) ?? []).slice(0, 20),
      ...(u ? { usage: u } : {}),
    };
  });
}

/* ---- skills ---- */

export interface SkillView {
  readonly skill: Skill;
  /** Where it comes from: `.jarvis/skills/<id>/`, a `documentation/` file, or built in. */
  readonly origin: "project" | "source" | "builtin" | "user";
  /** Repository path of its instructions; none for a built-in. */
  readonly path?: string;
  /** A built-in replaced by a project skill with the same id (not used). */
  readonly overridden?: boolean;
  /** A project skill that replaces a built-in. */
  readonly overrides?: boolean;
  readonly usage?: Usage;
}

export function skillsOf(roots: KnowledgeRoots, usage?: ReadonlyMap<string, Usage>): SkillView[] {
  const root = roots.projectRoot ?? "";
  const active = loadSkills(roots);
  const builtinIds = new Set(BUILTIN_SKILLS.map((s) => s.id));
  const views: SkillView[] = active.map((skill) => {
    const origin: SkillView["origin"] = skill.source
      ? "source"
      : skill.level === "builtin"
        ? "builtin"
        : skill.level === "user"
          ? "user"
          : "project";
    const path = skill.source
      ? skill.source
      : skill.dir && root && skill.dir.startsWith(root)
        ? `${relative(root, skill.dir).split("\\").join("/")}/instructions.md`
        : undefined;
    const u = usage?.get(`skill:${skill.id}`);
    return {
      skill,
      origin,
      ...(path ? { path } : {}),
      ...(origin !== "builtin" && builtinIds.has(skill.id) ? { overrides: true } : {}),
      ...(u ? { usage: u } : {}),
    };
  });
  const ids = new Set(active.map((s) => s.id));
  for (const b of BUILTIN_SKILLS)
    if (ids.has(b.id) && !active.includes(b)) views.push({ skill: b, origin: "builtin", overridden: true });
  return views;
}

/* ---- glossary ---- */

export const GLOSSARY = ".jarvis/knowledge/glossary.md";

export interface SymbolCheck {
  readonly symbol: string;
  readonly found: boolean;
  /** Where: a file:line for a code symbol, "folder" / "file" for a path. */
  readonly where?: string;
}

export interface GlossaryRow extends GlossaryEntry {
  readonly updated?: string;
  readonly problems: readonly string[];
}

export interface GlossaryView {
  readonly exists: boolean;
  readonly rows: readonly GlossaryRow[];
  readonly checked: boolean;
}

const cleanSymbol = (s: string) => s.replace(/^`|`$/g, "").replace(/\(\)$/, "").trim();
const isPackage = (s: string) => /^@[\w.-]+\/[\w.-]+$/.test(s);
const isFileName = (s: string) =>
  /^[\w.-]+\.(tsx?|jsx?|mjs|cjs|json|s?css|md|ya?ml|cs|py|go|java|kt)$/.test(s);
const isPath = (s: string) =>
  !isPackage(s) && !/\s/.test(s) && (/\//.test(s) || isFileName(s) || /^[\w.-]+\*$/.test(s));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Each symbol against the code, without a model: a path must name a folder or file (from the root,
 * or the tail of one — `checkout/payment` inside an app; `#/` and `@/` aliases dropped), a
 * package (`@scope/name`) must be in a package.json, a name must occur as a word in a tracked file.
 */
export async function checkSymbols(
  root: string,
  symbols: readonly string[],
): Promise<Map<string, SymbolCheck>> {
  const out = new Map<string, SymbolCheck>();
  const wanted = [...new Set(symbols.map(cleanSymbol).filter(Boolean))];
  if (wanted.length === 0) return out;
  const files = await trackedFiles(root);
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const names: string[] = [];
  const packages: string[] = [];
  for (const sym of wanted) {
    if (isPackage(sym)) packages.push(sym);
    else if (isPath(sym)) {
      const p = sym.replace(/^[#@~]\//, "").replace(/\/+$/, "");
      // `form-step*`: a folder or file whose path ends so; otherwise the path or its tail
      const glob = p.includes("*")
        ? new RegExp(`(^|/)${p.split("*").map(escapeRe).join("[^/]*")}$`)
        : undefined;
      const fits = (x: string) => (glob ? glob.test(x) : x === p || x.endsWith(`/${p}`));
      const hit =
        [...dirs].find(fits) ??
        files.find((f) => fits(f) || (!glob && (f.startsWith(`${p}.`) || f.includes(`/${p}.`))));
      out.set(sym, { symbol: sym, found: !!hit, ...(hit ? { where: hit } : {}) });
    } else names.push(sym);
  }
  const left = new Set(names);
  const pkgsLeft = new Set(packages);
  const re =
    names.length > 0
      ? new RegExp(
          `(?<![\\w$])(${names
            .map(escapeRe)
            .sort((a, b) => b.length - a.length)
            .join("|")})(?![\\w$])`,
          "g",
        )
      : undefined;
  for (const f of files) {
    if (left.size === 0 && pkgsLeft.size === 0) break;
    const isManifest = f === "package.json" || f.endsWith("/package.json");
    // a symbol is looked for in code, not in documents that only mention it
    if ((!re || /\.(md|mdx|txt)$/i.test(f)) && !isManifest) continue;
    let text: string;
    try {
      const full = join(root, f);
      if (statSync(full).size > 1_000_000) continue;
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (isManifest)
      for (const p of [...pkgsLeft])
        if (text.includes(`"${p}"`)) {
          pkgsLeft.delete(p);
          out.set(p, { symbol: p, found: true, where: f });
        }
    if (!re || left.size === 0) continue;
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const sym = m[1] as string;
      if (!left.has(sym)) continue;
      left.delete(sym);
      out.set(sym, { symbol: sym, found: true, where: `${f}:${text.slice(0, m.index).split("\n").length}` });
    }
  }
  for (const s of [...left, ...pkgsLeft]) out.set(s, { symbol: s, found: false });
  return out;
}

/** Synonyms claimed by two terms: a query with one widens to both. */
export function sharedSynonyms(entries: readonly GlossaryEntry[]): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const e of entries)
    for (const s of e.synonyms) {
      const k = s.toLowerCase();
      owners.set(k, [...(owners.get(k) ?? []), e.term]);
    }
  return new Map(
    [...owners.entries()]
      .map(([k, terms]): [string, string[]] => [k, [...new Set(terms)]])
      .filter(([, terms]) => terms.length > 1),
  );
}

function updatedOf(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of markdown.split("\n")) {
    const cells = line.trim().startsWith("|")
      ? line
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim())
      : [];
    if (cells.length >= 5 && cells[0]) out.set(cells[0], cells[4] ?? "");
  }
  return out;
}

export async function glossaryOf(root: string, check = true): Promise<GlossaryView> {
  const file = join(root, GLOSSARY);
  if (!existsSync(file)) return { exists: false, rows: [], checked: false };
  const text = readFileSync(file, "utf8");
  const entries = parseGlossary(text);
  const updated = updatedOf(text);
  const symbols = check
    ? await checkSymbols(
        root,
        entries.flatMap((e) => e.symbols),
      )
    : new Map<string, SymbolCheck>();
  const shared = sharedSynonyms(entries);
  const rows = entries.map((e): GlossaryRow => {
    const problems: string[] = [];
    for (const s of e.symbols) {
      const c = symbols.get(cleanSymbol(s));
      if (c && !c.found) problems.push(`${cleanSymbol(s)} is not in the code`);
    }
    for (const syn of e.synonyms) {
      const terms = shared.get(syn.toLowerCase());
      if (terms)
        problems.push(
          `«${syn}» is also a synonym of ${terms
            .filter((t) => t !== e.term)
            .map((t) => `«${t}»`)
            .join(", ")}`,
        );
    }
    const u = updated.get(e.term);
    return { ...e, ...(u ? { updated: u } : {}), problems };
  });
  return { exists: true, rows, checked: check };
}

export interface NewTerm {
  readonly term: string;
  readonly synonyms: readonly string[];
  readonly symbols: readonly string[];
  readonly sources: readonly string[];
  readonly definition?: string;
}

const HEADER = `# Glossary

Business term → synonyms → code symbols. Jarvis widens searches with this table and answers \`jarvis ask <term>\` from it.

| term | synonyms | symbols/modules | sources | updated | definition |
| --- | --- | --- | --- | --- | --- |
`;

const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ").trim();

export class GlossaryTermTaken extends Error {
  constructor(term: string) {
    super(`«${term}» is in the glossary already`);
    this.name = "GlossaryTermTaken";
  }
}

/**
 * Adds a row to the glossary table (after its last row, in its own column order), dated today.
 * The file stays a draft in the working copy until committed.
 */
export function addGlossaryTerm(root: string, t: NewTerm, today = new Date()): { readonly line: number } {
  const file = join(root, GLOSSARY);
  const text = existsSync(file) ? readFileSync(file, "utf8") : HEADER;
  if (parseGlossary(text).some((e) => e.term.toLowerCase() === t.term.trim().toLowerCase()))
    throw new GlossaryTermTaken(t.term.trim());
  const lines = text.replace(/\n+$/, "").split("\n");
  // the table: the header row (термин|term), its separator, then rows until the first non-row line
  const head = lines.findIndex((l) => /^\|\s*(термин|term)(?!\p{L})/iu.test(l.trim()));
  let last = head >= 0 ? head + 1 : -1;
  if (head >= 0)
    while (last + 1 < lines.length && (lines[last + 1] as string).trim().startsWith("|")) last += 1;
  const columns = head >= 0 ? (lines[head] as string).split("|").slice(1, -1).length : 6;
  const date = today.toISOString().slice(0, 10);
  mkdirSync(join(root, ".jarvis", "knowledge"), { recursive: true });
  const cells = [
    cell(t.term),
    t.synonyms.map(cell).join(", "),
    t.symbols.map((s) => `\`${cell(cleanSymbol(s))}\``).join(", "),
    t.sources.map(cell).join(", "),
    date,
    cell(t.definition ?? ""),
  ].slice(0, Math.max(columns, 3));
  const row = `| ${cells.join(" | ")} |`;
  if (head < 0) {
    const fresh = `${HEADER}${row}\n`;
    writeFileSync(file, `${text.replace(/\n+$/, "")}\n\n${fresh.slice(fresh.indexOf("| term"))}`);
    return { line: text.split("\n").length + 4 };
  }
  lines.splice(last + 1, 0, row);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return { line: last + 2 };
}
