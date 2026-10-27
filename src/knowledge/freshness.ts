import { git } from "../tools/local/exec.ts";
import { parseFrontMatter } from "./frontmatter.ts";

/**
 * How fresh a generated document is, by the code it was made from. A module map records the commit
 * and branch of the checkout it was mapped at (front matter `commit:`, `branch:`); the commits since
 * then under its paths are what it may have missed. Pilot: a service's documents live in the
 * knowledge repository, so «commits since the document's last edit» looked the document up in the
 * code's repository, found nothing and never called one stale — a form had been rewritten under it.
 */
export interface CodeAt {
  readonly commit: string;
  readonly branch?: string;
}

/** The commit (and branch) a document's front matter says it was made from. */
export function codeAtOf(text: string): CodeAt | undefined {
  const { data } = parseFrontMatter(text);
  const commit = typeof data.commit === "string" ? data.commit.trim() : undefined;
  if (!commit || !/^[0-9a-f]{7,40}$/i.test(commit)) return undefined;
  const branch = typeof data.branch === "string" && data.branch.trim() ? data.branch.trim() : undefined;
  return { commit, ...(branch ? { branch } : {}) };
}

/**
 * Commits on HEAD since `commit` that touched `paths` (globs or folders); undefined when the commit
 * is not in this repository (another clone, a rewritten history) — then nothing can be said.
 */
export async function commitsSinceCode(
  root: string,
  commit: string,
  paths: readonly string[],
): Promise<number | undefined> {
  if (paths.length === 0) return undefined;
  const known = await git(["cat-file", "-e", `${commit}^{commit}`], root);
  if (known.code !== 0) return undefined;
  const r = await git(
    ["rev-list", "--count", `${commit}..HEAD`, "--", ...paths.map((p) => `:(glob)${p}`)],
    root,
  );
  const n = Number(r.stdout.trim());
  return r.code === 0 && Number.isFinite(n) ? n : undefined;
}

/** The files under `paths` changed since `commit` (for a mapper told what moved), at most `limit`. */
export async function changedSinceCode(
  root: string,
  commit: string,
  paths: readonly string[],
  limit = 40,
): Promise<string[]> {
  const r = await git(
    ["diff", "--name-only", `${commit}..HEAD`, "--", ...paths.map((p) => `:(glob)${p}`)],
    root,
  );
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean).slice(0, limit) : [];
}

/** The branch a checkout is on, or undefined when detached. */
export async function branchOf(root: string): Promise<string | undefined> {
  const r = await git(["rev-parse", "--abbrev-ref", "HEAD"], root);
  const b = r.stdout.trim();
  return r.code === 0 && b && b !== "HEAD" ? b : undefined;
}
