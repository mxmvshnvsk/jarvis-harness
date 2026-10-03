import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type {
  FileFacts,
  GraphEdge,
  GraphNode,
  ProjectGraphExtractor,
} from "../../core/capabilities/contracts.ts";
import { git } from "../../tools/local/exec.ts";
import { contentHashOf, FactsCache, type GraphStore, type Snapshot } from "./store.ts";

/**
 * Incremental update (ADR-0008 §2): facts per file come from the content-addressed cache
 * whenever the blob was seen before (any branch, any worktree); only new blobs are extracted.
 * Edges are resolved per tree. Deterministic: sorted output, no time, no randomness.
 */
export interface UpdateOptions {
  readonly workspace: string;
  readonly repoId: string;
  readonly cacheRoot: string;
  readonly extractors: readonly ProjectGraphExtractor[];
  readonly store: GraphStore;
  /** Ignore the facts cache (for `--verify` and `--full`). */
  readonly noCache?: boolean;
  /** Save even when a snapshot for this tree exists. */
  readonly force?: boolean;
}

export interface UpdateResult {
  readonly snapshot: Snapshot;
  readonly reused: boolean;
  readonly extracted: number;
  readonly cacheHits: number;
  readonly skipped: number;
}

/**
 * The main checkout of a repository: a linked worktree (`.git` is a file pointing into
 * `<main>/.git/worktrees/<name>`) maps to its main checkout, so the graph built for the project is
 * the one agents find from a run's worktree.
 */
export function mainCheckoutOf(path: string): string {
  try {
    const dotGit = join(path, ".git");
    if (statSync(dotGit).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
      const m = pointer ? /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(pointer) : undefined;
      if (m?.[1]) return m[1];
    }
  } catch {
    // not a git checkout: the path itself identifies the repository
  }
  return path;
}

export function repoIdOf(repoRoot: string): string {
  const main = mainCheckoutOf(repoRoot);
  let canonical = main;
  try {
    canonical = realpathSync(main); // /tmp vs /private/tmp: the same checkout gets the same id
  } catch {
    // a path that does not exist yet identifies itself
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

interface IndexedFile {
  readonly path: string;
  readonly blobSha: string;
}

/** Files in the index with their blob shas: `git ls-files -s` is cheap and exact. */
async function indexedFiles(workspace: string): Promise<IndexedFile[]> {
  const r = await git(["ls-files", "-s", "-z"], workspace);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t") as [string, string];
      const blobSha = meta.split(" ")[1] as string;
      return { path, blobSha };
    });
}

const RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
];

/** Resolves a relative specifier to a file of the tree; non-relative ones stay as `pkg:` nodes. */
function resolveSpecifier(from: string, spec: string, files: ReadonlySet<string>): string {
  if (!spec.startsWith(".")) return `pkg:${spec}`;
  const base = posix.normalize(posix.join(dirname(from).split("\\").join("/"), spec));
  const stripped = base.replace(/\.[cm]?[jt]sx?$/, "");
  for (const candidate of [base, ...RESOLVE_SUFFIXES.map((s) => `${stripped}${s}`)]) {
    if (files.has(candidate)) return candidate;
  }
  return `unresolved:${base}`;
}

export async function updateGraph(options: UpdateOptions): Promise<UpdateResult> {
  const tree = await git(["rev-parse", "HEAD^{tree}"], options.workspace);
  const treeSha = tree.code === 0 ? tree.stdout.trim() : "worktree";
  const branchResult = await git(["rev-parse", "--abbrev-ref", "HEAD"], options.workspace);
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : undefined;
  const extractorsKey = options.extractors.map((e) => `${e.constructor.name}@${e.version}`).join(",");

  if (!options.force && !options.noCache) {
    const existing = options.store.byTree(options.repoId, treeSha);
    if (existing && existing.extractors === extractorsKey) {
      const snapshot = options.store.load(existing.id);
      if (snapshot) return { snapshot, reused: true, extracted: 0, cacheHits: existing.files, skipped: 0 };
    }
  }

  const cache = new FactsCache(options.cacheRoot, options.repoId);
  const files = await indexedFiles(options.workspace);
  const known = new Set(files.map((f) => f.path));
  const nodes: GraphNode[] = [];
  const rawEdges: Array<{ from: string; spec: string; relation: GraphEdge["relation"] }> = [];
  let extracted = 0;
  let cacheHits = 0;
  let skipped = 0;
  for (const file of files) {
    const extractor = options.extractors.find((e) => e.extensions.some((ext) => file.path.endsWith(ext)));
    if (!extractor || /(^|\/)(node_modules|dist|coverage|\.jarvis)\//.test(file.path)) {
      skipped += 1;
      continue;
    }
    let facts: FileFacts | undefined = options.noCache
      ? undefined
      : cache.get(extractor.version, file.blobSha);
    if (facts) cacheHits += 1;
    else {
      let content: string;
      try {
        content = readFileSync(join(options.workspace, file.path), "utf8");
      } catch {
        skipped += 1;
        continue;
      }
      facts = await extractor.extract(file.path, content);
      cache.put(extractor.version, file.blobSha, facts);
      extracted += 1;
    }
    nodes.push(...facts.nodes);
    for (const e of facts.edges) {
      if (e.to.startsWith("spec:"))
        rawEdges.push({ from: e.from, spec: e.to.slice(5), relation: e.relation });
      else rawEdges.push({ from: e.from, spec: e.to, relation: e.relation });
    }
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const e of rawEdges) {
    const to =
      e.spec.startsWith("pkg:") || e.spec.startsWith("unresolved:")
        ? e.spec
        : resolveSpecifier(e.from, e.spec, known);
    // A test file's imports are the modules it tests: edge from the module to the test (TESTED_BY).
    const edge: GraphEdge =
      e.relation === "TESTED_BY"
        ? { from: to, to: e.from, relation: "TESTED_BY" }
        : { from: e.from, to, relation: e.relation };
    const key = `${edge.from}|${edge.relation}|${edge.to}`;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push(edge);
    }
  }
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => `${a.from}|${a.relation}|${a.to}`.localeCompare(`${b.from}|${b.relation}|${b.to}`));

  const snapshot = options.store.save({
    repoId: options.repoId,
    treeSha,
    ...(branch ? { branch } : {}),
    extractors: extractorsKey,
    files: extracted + cacheHits,
    cacheHits,
    nodes,
    edges,
  });
  return { snapshot, reused: false, extracted, cacheHits, skipped };
}

/** Recomputes without the cache and compares — the determinism check of ADR-0008 §3. */
export async function verifyGraph(
  options: UpdateOptions,
): Promise<{ ok: boolean; stored?: string; recomputed: string }> {
  const latest = options.store.latest(options.repoId);
  const fresh = await updateGraph({ ...options, noCache: true, force: true });
  const recomputed = contentHashOf(fresh.snapshot.nodes, fresh.snapshot.edges);
  return {
    ok: latest !== undefined && latest.contentHash === recomputed,
    ...(latest ? { stored: latest.contentHash } : {}),
    recomputed,
  };
}

/* ---- traversal (ADR-0008, ADR-0021 §6): generic over any extractor's output ---- */

export interface ImpactResult {
  readonly changed: string[];
  /** Files that (transitively) depend on the changed ones, nearest first. */
  readonly dependents: Array<{ file: string; distance: number }>;
  /** Test files that cover the changed or dependent files. */
  readonly tests: string[];
  readonly unresolved: string[];
}

export function impactOf(snapshot: Snapshot, changed: readonly string[], maxDepth = 3): ImpactResult {
  const reverse = new Map<string, string[]>();
  const tests = new Map<string, string[]>();
  for (const e of snapshot.edges) {
    if (e.relation === "DEPENDS_ON") reverse.set(e.to, [...(reverse.get(e.to) ?? []), e.from]);
    if (e.relation === "TESTED_BY") tests.set(e.from, [...(tests.get(e.from) ?? []), e.to]);
  }
  const distance = new Map<string, number>();
  const queue: Array<[string, number]> = changed.map((c) => [c, 0]);
  for (const c of changed) distance.set(c, 0);
  while (queue.length > 0) {
    const [file, d] = queue.shift() as [string, number];
    if (d >= maxDepth) continue;
    for (const dep of reverse.get(file) ?? []) {
      if (!distance.has(dep)) {
        distance.set(dep, d + 1);
        queue.push([dep, d + 1]);
      }
    }
  }
  const dependents = [...distance.entries()]
    .filter(([f]) => !changed.includes(f))
    .map(([file, dist]) => ({ file, distance: dist }))
    .sort((a, b) => a.distance - b.distance || a.file.localeCompare(b.file));
  const covering = new Set<string>();
  for (const f of [...changed, ...dependents.map((d) => d.file)])
    for (const t of tests.get(f) ?? []) covering.add(t);
  const unresolved = [
    ...new Set(
      snapshot.edges
        .filter((e) => changed.includes(e.from) && e.to.startsWith("unresolved:"))
        .map((e) => e.to.slice(11)),
    ),
  ];
  return { changed: [...changed], dependents, tests: [...covering].sort(), unresolved };
}

export function neighborsOf(
  snapshot: Snapshot,
  file: string,
): { imports: string[]; importedBy: string[]; tests: string[]; symbols: string[] } {
  return {
    imports: snapshot.edges.filter((e) => e.from === file && e.relation === "DEPENDS_ON").map((e) => e.to),
    importedBy: snapshot.edges.filter((e) => e.to === file && e.relation === "DEPENDS_ON").map((e) => e.from),
    tests: snapshot.edges.filter((e) => e.from === file && e.relation === "TESTED_BY").map((e) => e.to),
    symbols: snapshot.nodes
      .filter((n) => n.file === file && n.id !== file)
      .map((n) => n.id.split("#")[1] as string),
  };
}
