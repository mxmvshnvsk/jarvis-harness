import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app/runtime.ts";
import {
  issueOfSubtask,
  readStoryTasks,
  STORY_TASKS,
  storyTasksLeftOut,
  storyTasksText,
} from "../../src/app/storyTasks.ts";
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

  it("the split's gate names a Story task left without a subtask while the map has its side (pilot)", async () => {
    const doc = await readStoryTasks(runtime, master.task, async () => ({
      ok: true,
      text: JSON.stringify(STORY),
    }));
    artifacts.set(STORY_TASKS, JSON.stringify(doc));
    (runtime.loaded.meta as { repos: Record<string, string> }).repos = {
      "orders-api": "/r/o",
      "common-ui": "/r/c",
    };
    const both = split(["ABC-19", "ABC-17"]);
    expect(storyTasksLeftOut(runtime, master, both)).toEqual([]);
    // the front only: the middle task is left out, and orders-api could take it
    const frontOnly: Split = { ...both, subtasks: both.subtasks.filter((s) => s.service === "common-ui") };
    expect(storyTasksLeftOut(runtime, master, frontOnly)).toEqual([
      {
        key: "ABC-19",
        type: "Middle Task",
        summary: "Remove the fields",
        side: "back",
        services: ["orders-api"],
      },
    ]);
    // a subtask of the side without an issue covers it
    const unnamed = split([undefined, undefined]);
    expect(storyTasksLeftOut(runtime, master, unnamed)).toEqual([]);
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

describe("the sources of a Story's task across services", () => {
  it("the Story's tasks read with the task, and the pages they link: the agent gets them as read", async () => {
    const { testRuntime, createRun } = await import("../helpers/engine.ts");
    const { BUILTIN_TOOLS } = await import("../../src/orchestration/tools/builtin.ts");
    sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
    sb.write(
      "project/.jarvis/project.yaml",
      'version: 1\nrelatedWork:\n  story:\n    types: [Story, User Story]\n    includes: ["is parent task of"]\n    includedIn: ["is subtask of"]\n',
    );
    const rt = await testRuntime(sb);
    try {
      const run = createRun(rt, "sdd-cross", "ABC-21 Remove the gift");
      const asked: string[] = [];
      const issues: Record<string, unknown> = {
        "ABC-21": STORY,
        "ABC-19": {
          key: "ABC-19",
          fields: {
            summary: "Remove the fields",
            description: "the API: https://wiki.example.com/pages/viewpage.action?pageId=55550001",
          },
        },
        "ABC-17": { key: "ABC-17", fields: { summary: "Remove the banner", description: "the layout" } },
      };
      const out = await (
        BUILTIN_TOOLS["sources.collect"] as never as (c: unknown, a: unknown) => Promise<{ status: string }>
      )(
        {
          run,
          runtime: rt,
          step: { id: "sources" },
          iteration: 1,
          workspace: { ref: run.workspace },
          tools: {
            list: () => [{ name: "jira.get" }, { name: "confluence.get" }],
            invoke: async (name: string, a: Record<string, unknown>) => {
              asked.push(`${name} ${String(a.key ?? a.id)}`);
              return name === "jira.get"
                ? { ok: true, text: `[jira.get] ok\n${JSON.stringify(issues[String(a.key)] ?? {})}` }
                : { ok: true, text: `[confluence.get] ok\n{"title":"Orders API","body":"POST /orders"}` };
            },
          },
        },
        {},
      );
      expect(out.status).toBe("success");
      expect(asked).toContain("jira.get ABC-19");
      expect(asked).toContain("jira.get ABC-17");
      expect(asked).toContain("confluence.get 55550001");
      const text = rt.artifacts.text(rt.artifacts.listLatest(run.id, "sources")[0] as never);
      expect(text).toContain("ABC-19 (a task of the Story ABC-21)");
      expect(text).toContain("Orders API");
    } finally {
      await rt.close();
    }
  });
});
