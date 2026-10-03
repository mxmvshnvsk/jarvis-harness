import { git } from "../tools/local/exec.ts";

/** What a push sends: one entry per ref git lists on the pre-push hook's stdin. */
export interface PushRef {
  readonly localRef: string;
  readonly localSha: string;
  readonly remoteRef: string;
  readonly remoteSha: string;
}

export const ZERO_SHA = /^0+$/;
/** The empty tree: the base when a repository has no usable ancestor to compare with. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbb4830";

export function parsePushRefs(stdin: string): PushRef[] {
  return stdin
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((p) => p.length >= 4)
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({
      localRef: localRef as string,
      localSha: localSha as string,
      remoteRef: remoteRef as string,
      remoteSha: remoteSha as string,
    }));
}

export interface CommitRange {
  /** Branch being pushed (short name) or the current branch. */
  readonly branch: string;
  readonly base: string;
  readonly head: string;
  readonly baseLabel: string;
}

async function revParse(cwd: string, rev: string): Promise<string | undefined> {
  const r = await git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], cwd);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

async function mergeBase(cwd: string, a: string, b: string): Promise<string | undefined> {
  const r = await git(["merge-base", a, b], cwd);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** Where a branch with no remote counterpart forked from: upstream, then the usual trunk names. */
async function trunkBase(
  cwd: string,
  head: string,
  remote?: string,
): Promise<{ sha: string; label: string }> {
  const candidates = [
    "@{upstream}",
    ...(remote ? [`${remote}/HEAD`, `${remote}/main`, `${remote}/master`] : []),
    "origin/HEAD",
    "origin/main",
    "origin/master",
    "main",
    "master",
  ];
  for (const candidate of candidates) {
    const sha = await revParse(cwd, candidate);
    if (!sha) continue;
    const base = await mergeBase(cwd, sha, head);
    if (base && base !== head) return { sha: base, label: candidate };
  }
  return { sha: EMPTY_TREE, label: "empty tree" };
}

/** Short branch name of a ref (`refs/heads/x` → `x`); other refs (tags, notes) have none. */
export function branchOf(ref: string): string | undefined {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
}

/**
 * Ranges the pushed refs add on the remote: from the remote tip when the remote has it, else from
 * the fork point. Deletions and non-branch refs are not reviewed.
 */
export async function rangesForPush(
  cwd: string,
  refs: readonly PushRef[],
  remote?: string,
): Promise<CommitRange[]> {
  const ranges: CommitRange[] = [];
  for (const ref of refs) {
    const branch = branchOf(ref.remoteRef);
    if (!branch || ZERO_SHA.test(ref.localSha)) continue;
    const head = await revParse(cwd, ref.localSha);
    if (!head) continue;
    const known = ZERO_SHA.test(ref.remoteSha) ? undefined : await revParse(cwd, ref.remoteSha);
    if (known) {
      const base = (await mergeBase(cwd, known, head)) ?? known;
      if (base !== head) ranges.push({ branch, base, head, baseLabel: "remote tip" });
      continue;
    }
    const trunk = await trunkBase(cwd, head, remote);
    ranges.push({ branch, base: trunk.sha, head, baseLabel: trunk.label });
  }
  return ranges;
}

/** `jarvis prepush` run by hand: the current branch against `--base`, or against its upstream/trunk. */
export async function rangeForHead(
  cwd: string,
  base?: string,
  head = "HEAD",
): Promise<CommitRange | undefined> {
  const headSha = await revParse(cwd, head);
  if (!headSha) return undefined;
  const branchRef = await git(["rev-parse", "--abbrev-ref", head], cwd);
  const branch = branchRef.code === 0 ? branchRef.stdout.trim() : "HEAD";
  if (base) {
    const baseSha = await revParse(cwd, base);
    if (!baseSha) return undefined;
    return {
      branch,
      base: (await mergeBase(cwd, baseSha, headSha)) ?? baseSha,
      head: headSha,
      baseLabel: base,
    };
  }
  const trunk = await trunkBase(cwd, headSha);
  return { branch, base: trunk.sha, head: headSha, baseLabel: trunk.label };
}
