import { storyBranch, storyOf } from "../sources/relatedWork.ts";
import { git } from "../tools/local/exec.ts";
import { defaultBranchOf } from "./deliver.ts";
import type { Runtime } from "./runtime.ts";

/**
 * A task in a Story (`relatedWork.story`) is made on the Story's branch: the run starts from it and its
 * PR goes into it. Read before the run's checkout is made — one `jira.get`, the same policy as an
 * agent's call — and only when the repository has the branch: a Story that has not touched this
 * repository yet leaves the run on its usual base, and the run says so. A task with no Story: nothing.
 */
export interface StoryBase {
  readonly key: string;
  readonly branch: string;
  /** The repository has the branch: the run starts from it. */
  readonly based: boolean;
  /** The ref the checkout is made from, when based. */
  readonly ref?: string;
  /** The repository had no branch for the Story: Jarvis made it from the base and pushed it. */
  readonly created?: { readonly from: string };
  /** It could not be made: why. */
  readonly notCreated?: string;
}

export async function storyBaseOf(
  runtime: Runtime,
  task: string,
  repoRoot: string,
  related: boolean | undefined,
  /** The run has its own checkout: a missing Story branch may be made (`relatedWork.story.create`). */
  canCreate = false,
): Promise<StoryBase | undefined> {
  const cfg = runtime.loaded.config.relatedWork;
  if (!(related ?? cfg.enabled) || !cfg.story.base) return undefined;
  const key = task.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0];
  if (!key) return undefined;
  const cap = runtime.registry.get("jira.get");
  if (!cap || !runtime.tools.policy(cap, ["*"]).allowed) return undefined;
  let text: string;
  try {
    const call = await runtime.mcp.provider.invoke("jira.get", { key, fields: "*all" });
    if (!call.result.ok) return undefined;
    text = call.result.text;
  } catch {
    return undefined;
  }
  const story = storyOf(text, cfg.story);
  if (!story) return undefined;
  const branch = storyBranch(cfg.story.branch, story);
  const remote = runtime.loaded.config.delivery.remote;
  await git(["fetch", "--quiet", remote, branch], repoRoot, { timeoutMs: 60_000 });
  const ref = `${remote}/${branch}`;
  const there = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoRoot);
  if (there.code === 0) return { key: story, branch, based: true, ref };
  if (!canCreate || !cfg.story.create) return { key: story, branch, based: false };
  // the first task of the Story in this repository: its branch made from the base as the remote has it
  // now and pushed — the person's own git, as every push of Jarvis; the next tasks branch off it
  const from = runtime.loaded.config.delivery.target ?? cfg.base ?? (await defaultBranchOf(repoRoot, remote));
  const fetched = await git(["fetch", "--quiet", remote, from], repoRoot, { timeoutMs: 120_000 });
  if (fetched.code !== 0)
    return { key: story, branch, based: false, notCreated: `${remote}/${from} could not be fetched` };
  const pushed = await git(
    ["push", "--porcelain", remote, `refs/remotes/${remote}/${from}:refs/heads/${branch}`],
    repoRoot,
    {
      env: runtime.env,
      timeoutMs: 300_000,
    },
  );
  await git(["fetch", "--quiet", remote, branch], repoRoot, { timeoutMs: 60_000 });
  const made = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoRoot);
  // pushed, or someone made it a moment ago: either way the branch is there now
  if (made.code === 0) {
    runtime.events.emit({
      kind: "story.branchCreated",
      payload: { story, branch, from: `${remote}/${from}`, pushed: pushed.code === 0 },
    });
    return {
      key: story,
      branch,
      based: true,
      ref,
      ...(pushed.code === 0 ? { created: { from: `${remote}/${from}` } } : {}),
    };
  }
  return {
    key: story,
    branch,
    based: false,
    notCreated:
      (pushed.stderr.trim() || pushed.stdout.trim()).split("\n").slice(-2).join(" ") ||
      "the push was refused",
  };
}
