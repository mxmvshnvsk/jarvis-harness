import { knowledgeConfigOf } from "../core/config/meta.ts";
import type { Run } from "../core/domain/run.ts";
import { inclusionsOf, issueFacts, sideOfIssue, storyOf } from "../sources/relatedWork.ts";
import type { Runtime } from "./runtime.ts";
import type { Split, Subtask } from "./subtasks.ts";

/**
 * A task across services that is a Story (or in one): its Jira tasks per side — «Middle Task» for the
 * back, «Front Task» for the front — read by the catalog step for the split, and each subtask tied to
 * the one of its service's side. The subtask then works under that key: its branch, its commits, and
 * its PR into the Story's branch (src/app/storyBase.ts), as a person on that task would.
 */

export const STORY_TASKS = "story-tasks";

export interface StoryTask {
  readonly key: string;
  readonly type?: string;
  readonly summary?: string;
  readonly side?: string;
}

export interface StoryTasksDoc {
  readonly story: string;
  readonly tasks: readonly StoryTask[];
}

type Invoke = (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;

/** The Story of the task (itself, or the one it is in) and the Story's tasks with their sides. */
export async function readStoryTasks(
  runtime: Runtime,
  task: string,
  invoke: Invoke,
): Promise<StoryTasksDoc | undefined> {
  const cfg = runtime.loaded.config.relatedWork;
  const key = task.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0];
  if (!key) return undefined;
  const got = await invoke("jira.get", { key, fields: "*all" }).catch(() => undefined);
  if (!got?.ok) return undefined;
  const isStory = cfg.story.types.some(
    (t) => t.toLowerCase() === (issueFacts(got.text).type ?? "").toLowerCase(),
  );
  let story = isStory ? key : storyOf(got.text, cfg.story);
  if (!story) return undefined;
  let text = got.text;
  if (!isStory) {
    const s = await invoke("jira.get", { key: story, fields: "*all" }).catch(() => undefined);
    if (!s?.ok) return undefined;
    text = s.text;
  }
  const tasks = inclusionsOf(text, cfg.story).includes.map((i) => {
    const side = sideOfIssue(i, cfg.sides, cfg.prefixes);
    return {
      key: i.key,
      ...(i.type ? { type: i.type } : {}),
      ...(i.summary ? { summary: i.summary } : {}),
      ...(side ? { side } : {}),
    };
  });
  story = story as string;
  return tasks.length > 0 ? { story, tasks } : undefined;
}

/** For the split: the Story's tasks, one a line, and how to tie a subtask to one. */
export function storyTasksText(doc: StoryTasksDoc): string {
  return [
    `## Jira tasks of the Story ${doc.story}`,
    "Each subtask is one of these tasks: set its `issue` to the key of the task of its service's side (a backend service — the back/middle task, a frontend — the front task). A service with no task of its side here: leave `issue` empty.",
    ...doc.tasks.map(
      (t) =>
        `- ${t.key}${t.type ? ` (${t.type})` : ""}${t.side ? ` — ${t.side}` : ""}${t.summary ? `: ${t.summary}` : ""}`,
    ),
  ].join("\n");
}

export function storyTasksOf(runtime: Runtime, master: Run): StoryTasksDoc | undefined {
  const a = runtime.artifacts.listLatest(master.id, STORY_TASKS)[0];
  if (!a) return undefined;
  try {
    return JSON.parse(runtime.artifacts.text(a)) as StoryTasksDoc;
  } catch {
    return undefined;
  }
}

/** The side of a service of the map by its kind: a frontend — front, else back. */
function sideOfService(runtime: Runtime, service: string): string {
  const meta = runtime.loaded.meta;
  const config = meta ? knowledgeConfigOf(meta.root) : undefined;
  const services = (config?.services ?? {}) as Record<string, { kind?: unknown }>;
  return services[service]?.kind === "frontend" ? "front" : "back";
}

/**
 * The Jira task a subtask is: the one the split named, if it is the Story's; else the only task of
 * its service's side not taken by another subtask; else none (the subtask works under the Story's key).
 */
export function issueOfSubtask(
  runtime: Runtime,
  master: Run,
  sub: Subtask,
  split: Split,
): string | undefined {
  const doc = storyTasksOf(runtime, master);
  if (!doc) return undefined;
  const keys = new Set(doc.tasks.map((t) => t.key));
  if (sub.issue && keys.has(sub.issue)) return sub.issue;
  const taken = new Set(
    split.subtasks.filter((s) => s.key !== sub.key && s.issue && keys.has(s.issue)).map((s) => s.issue),
  );
  const side = sideOfService(runtime, sub.service);
  const free = doc.tasks.filter((t) => t.side === side && !taken.has(t.key));
  // the others of the same side, by order, when the split named none: one each, the first first
  const sameSide = split.subtasks.filter(
    (s) => !(s.issue && keys.has(s.issue)) && sideOfService(runtime, s.service) === side,
  );
  if (free.length === 1 && sameSide.length === 1) return free[0]?.key;
  return free.length === sameSide.length
    ? free[sameSide.findIndex((s) => s.key === sub.key)]?.key
    : undefined;
}
