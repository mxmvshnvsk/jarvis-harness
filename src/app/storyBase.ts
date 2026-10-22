import { storyBranch, storyOf } from "../sources/relatedWork.ts";
import { git } from "../tools/local/exec.ts";
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
}

export async function storyBaseOf(
  runtime: Runtime,
  task: string,
  repoRoot: string,
  related: boolean | undefined,
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
  return there.code === 0 ? { key: story, branch, based: true, ref } : { key: story, branch, based: false };
}
