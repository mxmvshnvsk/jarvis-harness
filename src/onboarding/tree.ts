import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globMatches, parseFrontMatter } from "../knowledge/frontmatter.ts";
import { loadSourceDocuments } from "../knowledge/sources.ts";
import type { KnowledgeRoots } from "../knowledge/standards.ts";
import { git } from "../tools/local/exec.ts";
import { MODULE_MARKER, ONBOARD_MARKER } from "./render.ts";
import { countFile, moduleOf, rolOf, trackedFiles } from "./scan.ts";

/**
 * What can be researched, for the Modules page of `jarvis ui`: the modules of the scan (`src/x`,
 * `packages/x`, …) and every folder inside them, with their size and the knowledge that covers
 * them. No model: git, the files and the front matter of the documents. A node bigger than
 * `TOO_BIG` is offered in parts — one mapper pass covers about that much well (pilot: a shared
 * library of a monorepo was too large for one pass).
 */
export const TOO_BIG = { files: 150, lines: 15_000 } as const;

export interface Coverage {
  /**
   * `document` — a document is about exactly this folder; `generated` — the same, but jarvis
   * wrote it and nobody took it over; `via` — a document about a wider folder (or a glob) covers it.
   */
  readonly kind: "document" | "generated" | "via";
  /** Repository path of the document. */
  readonly doc: string;
  /** From `knowledge.sources` (the team's documentation): read-only here. */
  readonly source: boolean;
  /** Commits under the folder since the document's last commit (own documents only). */
  readonly staleCommits?: number;
}

export interface TreeNode {
  readonly path: string;
  readonly name: string;
  readonly files: number;
  readonly lines: number;
  readonly languages: readonly string[];
  /** A module of the scan (the top of a branch). */
  readonly module: boolean;
  readonly tooBig: boolean;
  readonly coverage?: Coverage;
  readonly children: readonly TreeNode[];
}

export interface ModuleTree {
  readonly modules: readonly TreeNode[];
  /** Every folder of the tree, for the path field's suggestions. */
  readonly dirs: readonly string[];
  readonly head: string;
}

/** A document that says which code it is about. */
export interface DocScope {
  readonly path: string;
  readonly paths: readonly string[];
  readonly generated: boolean;
  readonly source: boolean;
}

/** `.jarvis/knowledge/*.md` and the `knowledge.sources` documents with `paths` (or scopes). */
export function docScopes(roots: KnowledgeRoots): DocScope[] {
  const out: DocScope[] = [];
  const root = roots.projectRoot;
  if (!root) return out;
  const dir = join(root, ".jarvis", "knowledge");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    names = [];
  }
  for (const name of names.sort()) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const { data } = parseFrontMatter(text);
    const paths = Array.isArray(data.paths)
      ? data.paths.filter((p): p is string => typeof p === "string")
      : [];
    if (paths.length === 0) continue;
    out.push({
      path: `.jarvis/knowledge/${name}`,
      paths,
      generated: text.includes(MODULE_MARKER) || text.includes(ONBOARD_MARKER),
      source: false,
    });
  }
  for (const d of loadSourceDocuments(roots)) {
    if (d.skill || d.paths.length === 0) continue;
    out.push({ path: d.path, paths: d.paths, generated: false, source: true });
  }
  return out;
}

const exactly = (glob: string, path: string) => {
  const base = glob.replace(/\/\*\*(\/\*)?$/, "").replace(/\/$/, "");
  return base === path || (/[*?{[]/.test(base) && globMatches(path, [base]));
};

/** The best document for a folder: own over the team's, exact over wider, written by a person over generated. */
function coverageOf(path: string, docs: readonly DocScope[]): Omit<Coverage, "staleCommits"> | undefined {
  let best: { c: Omit<Coverage, "staleCommits">; rank: number } | undefined;
  for (const d of docs) {
    if (!globMatches(`${path}/x`, d.paths)) continue;
    const exact = d.paths.some((g) => exactly(g, path));
    const kind: Coverage["kind"] = exact ? (d.generated ? "generated" : "document") : "via";
    const rank = (exact ? 4 : 0) + (d.source ? 0 : 2) + (d.generated ? 0 : 1);
    if (!best || rank > best.rank) best = { c: { kind, doc: d.path, source: d.source }, rank };
  }
  return best?.c;
}

interface Building {
  path: string;
  name: string;
  module: boolean;
  s: { files: number; lines: number; langs: Set<string> };
  kids: Map<string, Building>;
}

async function staleCommits(root: string, doc: string, path: string): Promise<number | undefined> {
  const last = await git(["log", "-1", "--format=%H", "--", doc], root);
  const commit = last.stdout.trim();
  if (last.code !== 0 || !commit) return undefined;
  const count = await git(["rev-list", "--count", `${commit}..HEAD`, "--", path], root);
  const n = Number(count.stdout.trim());
  return count.code === 0 && Number.isFinite(n) ? n : undefined;
}

export async function moduleTree(roots: KnowledgeRoots): Promise<ModuleTree> {
  const root = roots.projectRoot as string;
  const head = (await git(["rev-parse", "HEAD"], root)).stdout.trim();
  const files = (await trackedFiles(root)).filter((f) => !roots.isDenied?.(f));
  const tops = new Map<string, Building>();
  const fresh = (path: string, module: boolean): Building => ({
    path,
    name: path.split("/").pop() ?? path,
    module,
    s: { files: 0, lines: 0, langs: new Set() },
    kids: new Map(),
  });
  for (const f of files) {
    const m = moduleOf(f);
    if (m === "(root)" || rolOf(m, m.split("/")[0] as string) !== "source") continue;
    const top = tops.get(m) ?? fresh(m, true);
    tops.set(m, top);
    const per = { files: 0, lines: 0, langs: new Set<string>() };
    countFile(root, f, per);
    const chain: Building[] = [top];
    const rest = f
      .slice(m.length + 1)
      .split("/")
      .slice(0, -1);
    let at = top;
    for (const part of rest) {
      const p = `${at.path}/${part}`;
      const next = at.kids.get(p) ?? fresh(p, false);
      at.kids.set(p, next);
      chain.push(next);
      at = next;
    }
    for (const b of chain) {
      b.s.files += per.files;
      b.s.lines += per.lines;
      for (const l of per.langs) b.s.langs.add(l);
    }
  }
  const docs = docScopes(roots);
  const dirs: string[] = [];
  const stale: Array<Promise<void>> = [];
  const finish = (b: Building): TreeNode => {
    dirs.push(b.path);
    const c = coverageOf(b.path, docs);
    const node: { -readonly [K in keyof TreeNode]: TreeNode[K] } = {
      path: b.path,
      name: b.name,
      files: b.s.files,
      lines: b.s.lines,
      languages: [...b.s.langs].sort(),
      module: b.module,
      tooBig: b.s.files > TOO_BIG.files || b.s.lines > TOO_BIG.lines,
      ...(c ? { coverage: c } : {}),
      children: [...b.kids.values()]
        .sort((x, y) => y.s.files - x.s.files || x.path.localeCompare(y.path))
        .map(finish),
    };
    if (c && c.kind !== "via" && !c.source)
      stale.push(
        staleCommits(root, c.doc, b.path).then((n) => {
          if (n && n > 0) node.coverage = { ...c, staleCommits: n };
        }),
      );
    return node;
  };
  const modules = [...tops.values()].sort((a, b) => a.path.localeCompare(b.path)).map(finish);
  await Promise.all(stale);
  return { modules, dirs: dirs.sort(), head };
}

/** A node by path, anywhere in the tree. */
export function findNode(tree: ModuleTree, path: string): TreeNode | undefined {
  const walk = (nodes: readonly TreeNode[]): TreeNode | undefined => {
    for (const n of nodes) {
      if (n.path === path) return n;
      // `src` (files right under it) and `src/ui` are both modules: look further on a miss
      const inside = path.startsWith(`${n.path}/`) ? walk(n.children) : undefined;
      if (inside) return inside;
    }
    return undefined;
  };
  return walk(tree.modules);
}

/** The parts a big node is offered in: its child folders, files loose in it don't make a part. */
export function partsOf(node: TreeNode): readonly TreeNode[] {
  return node.children;
}
