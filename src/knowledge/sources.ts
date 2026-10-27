import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import type { ResolvedConfig } from "../core/config/schema.ts";
import { DEFAULT_DENIED_PATHS, PathPolicy } from "../security/redactor.ts";
import { globMatches, parseFrontMatter } from "./frontmatter.ts";
import type { KnowledgeRoots } from "./standards.ts";

/**
 * `knowledge.sources`: documentation the team already keeps in the repository (`documentation/`,
 * `AGENTS.md`) read in place, so there is one source of truth and nothing to copy into `.jarvis/`.
 * Pilot: the onboarding agent found the module's mechanics in the code but almost none of the usage
 * rules and traps that live only in the team's documentation.
 */
export interface SourceDocument {
  /** Repository-relative path — also the knowledge name and the `knowledge:` ref. */
  readonly path: string;
  readonly text: string;
  readonly sha: string;
  readonly title?: string;
  /** Code paths the document is about; empty = everywhere. */
  readonly paths: string[];
  readonly stacks: string[];
  readonly tags: string[];
  /** Agents (knowledge: who may see it; skill: who it is for). */
  readonly agents: string[];
  readonly skill: boolean;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".jarvis", "dist", "build", "coverage"]);

function walk(dir: string, rel: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, r, out);
    else if (st.isFile()) out.push(r);
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

/**
 * A source file as read and parsed, kept while its size and mtime stay: the team's documentation was
 * read and parsed again several times a step (the package, the index, the coverage) and per page.
 */
const parsedFiles = new Map<
  string,
  { at: string; data: Record<string, unknown>; text: string; sha: string }
>();

function readParsed(file: string): { data: Record<string, unknown>; text: string; sha: string } | undefined {
  let at: string;
  try {
    const st = statSync(file);
    at = `${st.size}:${st.mtimeMs}`;
  } catch {
    return undefined;
  }
  const kept = parsedFiles.get(file);
  if (kept?.at === at) return kept;
  const raw = readFileSync(file, "utf8");
  const { data, body } = parseFrontMatter(raw);
  const doc = {
    at,
    data,
    text: body.trim(),
    sha: createHash("sha256").update(raw).digest("hex").slice(0, 12),
  };
  if (parsedFiles.size > 10_000) parsedFiles.clear();
  parsedFiles.set(file, doc);
  return doc;
}

/** Every document of every source, in configuration order; denied and missing paths are skipped. */
export function loadSourceDocuments(roots: KnowledgeRoots): SourceDocument[] {
  const root = roots.projectRoot;
  if (!root || !roots.sources || roots.sources.length === 0) return [];
  const out: SourceDocument[] = [];
  const seen = new Set<string>();
  for (const source of roots.sources) {
    const base = posix
      .normalize(source.path.replace(/\\/g, "/"))
      .replace(/^\.\/?/, "")
      .replace(/\/+$/, "");
    if (base.startsWith("..")) continue;
    const abs = join(root, base);
    if (!existsSync(abs)) continue;
    const isFile = statSync(abs).isFile();
    let files: Array<{ repo: string; local: string }>;
    if (isFile) files = [{ repo: base, local: basename(base) }];
    else {
      const found: string[] = [];
      walk(abs, "", found);
      files = found
        .filter((f) => globMatches(f, source.include) && !globMatches(f, source.exclude))
        .map((f) => ({ repo: base ? `${base}/${f}` : f, local: f }));
    }
    for (const { repo, local } of files) {
      if (seen.has(repo) || roots.isDenied?.(repo)) continue;
      seen.add(repo);
      const parsed = readParsed(join(root, repo));
      if (!parsed) continue;
      const { data, text, sha } = parsed;
      if (!text) continue;
      const scoped = Object.entries(source.scopes)
        .filter(([glob]) => globMatches(local, [glob]))
        .flatMap(([, paths]) => paths);
      // a module's own memo applies to the module (AGENTS.md at the root applies everywhere)
      const dir = dirname(repo);
      const memo = basename(repo) === "AGENTS.md" && dir !== "." ? [`${dir}/**`] : [];
      const skill = source.skills.some((g) => globMatches(local, [g]) || globMatches(basename(repo), [g]));
      const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
      out.push({
        path: repo,
        text,
        sha,
        ...(heading ? { title: heading } : {}),
        paths: [...new Set([...strings(data.paths), ...scoped, ...memo])],
        stacks: strings(data.stacks),
        tags: strings(data.tags),
        agents: skill ? source.agents : strings(data.agents),
        skill,
      });
    }
  }
  return out;
}

/** `SKILL_invoice-events.md` (or `.mdx`) → `invoice-events`; unique within the list. */
export function skillIdOf(path: string, taken: ReadonlySet<string>): string {
  const stem = basename(path)
    .replace(/\.mdx?$/i, "")
    .replace(/^SKILL[_-]/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  let id = stem || "doc";
  if (!/^[a-z0-9]/.test(id)) id = `doc-${id}`;
  if (!taken.has(id)) return id;
  const parent = basename(dirname(path))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
  return taken.has(`${parent}-${id}`)
    ? `${parent}-${id}-${createHash("sha256").update(path).digest("hex").slice(0, 6)}`
    : `${parent}-${id}`;
}

/** The knowledge roots of a run or a command: project, user home, sources and the denied paths. */
export function knowledgeRootsOf(
  loaded: { config: ResolvedConfig; home: { root: string } },
  projectRoot: string | undefined,
): KnowledgeRoots {
  const policy = new PathPolicy([...DEFAULT_DENIED_PATHS, ...loaded.config.security.deniedPaths]);
  return {
    projectRoot,
    userRoot: loaded.home.root,
    sources: loaded.config.knowledge.sources,
    isDenied: (rel) => policy.isDenied(rel),
  };
}
