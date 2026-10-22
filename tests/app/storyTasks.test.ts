import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app/runtime.ts";
import { issueOfSubtask, readStoryTasks, STORY_TASKS, storyTasksText } from "../../src/app/storyTasks.ts";
import type { Split } from "../../src/app/subtasks.ts";
import { subtaskTask } from "../../src/cli/commands/subtask.ts";
import { RelatedWorkConfigSchema } from "../../src/core/config/schema.ts";
import type { Run } from "../../src/core/domain/run.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** A task across services that is a User Story: each subtask is one of the Story's Jira tasks. */

const LINK = { name: "Parent", inward: "is subtask of", outward: "is parent task of" };
const STORY = {
  key: "ABC-21",
  fields: {
    issuetype: { name: "User Story" },
    issuelinks: [
      {
        type: LINK,
        outward_issue: {
          key: "ABC-19",
          fields: { issuetype: { name: "Middle Task" }, summary: "Remove the fields" },
        },
      },
      {
        type: LINK,
        outward_issue: {
          key: "ABC-17",
          fields: { issuetype: { name: "Front Task" }, summary: "Remove the banner" },
        },
      },
    ],
  },
};

let sb: Sandbox;
let runtime: Runtime;
const artifacts = new Map<string, string>();
beforeEach(() => {
  sb = sandbox();
  sb.write(
    "kb/project.yaml",
    "version: 1\nservices:\n  orders-api: { kind: backend }\n  common-ui: { kind: frontend }\n",
  );
  artifacts.clear();
  runtime = {
    loaded: {
      config: {
        relatedWork: RelatedWorkConfigSchema.parse({
          story: {
            types: ["Story", "User Story"],
            includes: ["Включает в себя", "is parent task of"],
            includedIn: ["Включена в", "is subtask of"],
          },
        }),
      },
      meta: { root: `${sb.root}/kb`, configFile: "", repos: {} },
    },
    artifacts: {
      listLatest: (_id: string, type: string) => (artifacts.has(type) ? [{ type }] : []),
      text: (a: { type: string }) => artifacts.get(a.type) as string,
    },
  } as unknown as Runtime;
});
afterEach(() => sb.cleanup());

const master = { id: "run_master00001", task: "ABC-21 Remove the gift" } as Run;
const split = (issues: Array<string | undefined>): Split => ({
  subtasks: [
    {
      key: "1",
      service: "orders-api",
      task: "Remove the fields from the back",
      requirements: [],
      deliverAfter: [],
      ...(issues[0] ? { issue: issues[0] } : {}),
    },
    {
      key: "2",
      service: "common-ui",
      task: "Remove the banner",
      requirements: [],
      deliverAfter: ["1"],
      ...(issues[1] ? { issue: issues[1] } : {}),
    },
  ],
  contract: [],
  notInScope: [],
});

describe("the Story's Jira tasks for a task across services", () => {
  it("read with their sides; said to the split", async () => {
    const doc = await readStoryTasks(runtime, master.task, async () => ({
      ok: true,
      text: JSON.stringify(STORY),
    }));
    expect(doc).toEqual({
      story: "ABC-21",
      tasks: [
        { key: "ABC-19", type: "Middle Task", summary: "Remove the fields", side: "back" },
        { key: "ABC-17", type: "Front Task", summary: "Remove the banner", side: "front" },
      ],
    });
    expect(storyTasksText(doc as never)).toContain("- ABC-17 (Front Task) — front: Remove the banner");
  });

  it("each subtask its task: as the split named it, else by its service's side; the key first in its run's task", async () => {
    const doc = await readStoryTasks(runtime, master.task, async () => ({
      ok: true,
      text: JSON.stringify(STORY),
    }));
    artifacts.set(STORY_TASKS, JSON.stringify(doc));
    const named = split(["ABC-19", "ABC-17"]);
    expect(named.subtasks.map((s) => issueOfSubtask(runtime, master, s, named))).toEqual([
      "ABC-19",
      "ABC-17",
    ]);
    const unnamed = split([undefined, undefined]);
    expect(unnamed.subtasks.map((s) => issueOfSubtask(runtime, master, s, unnamed))).toEqual([
      "ABC-19",
      "ABC-17",
    ]);
    // a key that is not the Story's: by the side
    const wrong = split(["XYZ-1", undefined]);
    expect(issueOfSubtask(runtime, master, wrong.subtasks[0] as never, wrong)).toBe("ABC-19");
    const task = subtaskTask(
      master,
      { ...(unnamed.subtasks[1] as Split["subtasks"][number]), issue: "ABC-17" },
      unnamed,
    );
    expect(task.split("\n")[0]).toBe("ABC-17 Remove the banner");
    expect(task.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0]).toBe("ABC-17");
  });

  it("no Story: nothing to tie", async () => {
    expect(
      await readStoryTasks(runtime, "ABC-30 plain", async () => ({
        ok: true,
        text: JSON.stringify({ key: "ABC-30", fields: {} }),
      })),
    ).toBeUndefined();
    expect(
      issueOfSubtask(
        runtime,
        master,
        split([undefined, undefined]).subtasks[0] as never,
        split([undefined, undefined]),
      ),
    ).toBeUndefined();
  });
});
