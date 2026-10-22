import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app/runtime.ts";
import { storyBaseOf } from "../../src/app/storyBase.ts";
import { collectRelated } from "../../src/orchestration/tools/related.ts";
import type { StepContext } from "../../src/orchestration/types.ts";
import {
  devInfoOf,
  inclusionsOf,
  pickRelated,
  type RelatedWorkDoc,
  sideOfIssue,
  storyBranch,
  storyOf,
} from "../../src/sources/relatedWork.ts";
import { createRun, testRuntime } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** Stories between an epic and its tasks (`relatedWork.story`): the tasks branch off the Story's branch. */

const NAMES = {
  types: ["Story"],
  includes: ["Включает в себя", "includes"],
  includedIn: ["Включена в", "is included in"],
};
const INCLUSION = { id: "1", name: "Включение", inward: "Включена в", outward: "Включает в себя" };
const BLOCKS = { id: "2", name: "Blocks", inward: "is blocked by", outward: "blocks" };

const ORDER_V1 = "package shop;\n\npublic class OrderDto {\n  private Long id;\n}\n";
const ORDER_V2 = "package shop;\n\npublic class OrderDto {\n  private Long id;\n  private String promo;\n}\n";

/** A task's jira.get: in the Story by an inclusion link, blocked by another task. */
const task = (key: string, story: string, type = "Change task") => ({
  key,
  fields: {
    issuetype: { name: type },
    issuelinks: [
      { type: BLOCKS, inward_issue: { key: "ABC-60", fields: { issuetype: { name: "Change task" } } } },
      { type: INCLUSION, inward_issue: { key: story, fields: { issuetype: { name: "Story" } } } },
    ],
  },
});
const story = (key: string, tasks: readonly string[], epic = "EP-9") => ({
  key,
  fields: {
    issuetype: { name: "Story" },
    customfield_2: { value: epic },
    issuelinks: tasks.map((k) => ({
      type: INCLUSION,
      outward_issue: { key: k, fields: { issuetype: { name: "Change task" } } },
    })),
  },
});

describe("reading the inclusion links", () => {
  it("a task is included in its Story; a Story includes its tasks", () => {
    const t = JSON.stringify(task("ABC-50", "ABC-48"));
    expect(inclusionsOf(t, NAMES).includedIn).toEqual([{ key: "ABC-48", type: "Story" }]);
    expect(storyOf(t, NAMES)).toBe("ABC-48");
    const s = JSON.stringify(story("ABC-48", ["ABC-50", "ABC-51"]));
    expect(inclusionsOf(s, NAMES).includes.map((i) => i.key)).toEqual(["ABC-50", "ABC-51"]);
    expect(storyOf(s, NAMES)).toBeUndefined();
  });

  it("the names are the project's: an English link, camelCase keys", () => {
    const doc = {
      key: "ABC-50",
      fields: {
        issuelinks: [
          {
            type: { name: "Inclusion", inward: "is included in", outward: "includes" },
            inwardIssue: { key: "ABC-48", fields: { issuetype: { name: "Story" } } },
          },
        ],
      },
    };
    expect(storyOf(JSON.stringify(doc), NAMES)).toBe("ABC-48");
    expect(storyOf(JSON.stringify(doc), { ...NAMES, includedIn: ["входит в"], includes: ["входит"] })).toBe(
      undefined,
    );
  });

  it("the branch by the pattern; a PR's destination", () => {
    expect(storyBranch("feature/{key}", "ABC-48")).toBe("feature/ABC-48");
    const dev = devInfoOf(
      JSON.stringify({
        pullRequests: [
          {
            id: 7,
            status: "MERGED",
            source: { branch: "feature/ABC-51" },
            destination: { branch: "feature/ABC-48" },
            url: "https://git.example.com/projects/SHOP/repos/orders-api/pull-requests/7",
          },
        ],
      }),
    );
    expect(dev.prs[0]).toMatchObject({ branch: "feature/ABC-51", destination: "feature/ABC-48" });
  });
});

describe("the side of a task", () => {
  const sides = { "Front Task": "front", "Middle Task": "back" };
  const prefixes = { java: "back", back: "back", middle: "back", js: "front", front: "front" };
  it("by its type, else by its title's prefix in any case", () => {
    expect(sideOfIssue({ type: "Middle Task", summary: "[Front] x" }, sides, prefixes)).toBe("back");
    expect(sideOfIssue({ type: "front task" }, sides, prefixes)).toBe("front");
    expect(sideOfIssue({ type: "Change", summary: "[JAVA] promo in the order" }, sides, prefixes)).toBe(
      "back",
    );
    expect(sideOfIssue({ type: "Change", summary: "[Тест] [js] promo field" }, sides, prefixes)).toBe(
      "front",
    );
    expect(sideOfIssue({ type: "Change", summary: "promo [middle]" }, sides, prefixes)).toBe("back");
    expect(sideOfIssue({ type: "Change", summary: "promo" }, sides, prefixes)).toBeUndefined();
  });
  it("the Story's tasks first, the other side's before mine", () => {
    const side = (c: { type?: string; summary?: string }) => sideOfIssue(c, sides, prefixes);
    const picked = pickRelated(
      "ABC-50",
      "front",
      [
        { key: "ABC-41", summary: "[Java] other", links: [] },
        { key: "ABC-52", type: "Change", summary: "[Front] mine too", links: [] },
        { key: "ABC-51", type: "Change", summary: "[Back] api", links: [] },
      ],
      side,
      10,
      new Set(),
      new Set(["ABC-51", "ABC-52"]),
    );
    expect(picked.map((c) => c.key)).toEqual(["ABC-51", "ABC-52", "ABC-41"]);
  });
});

describe("the related-work step in a Story", () => {
  let sb: Sandbox;
  let rt: Runtime;
  beforeEach(async () => {
    sb = sandbox();
    sb.write("project/.jarvis/project.yaml", "version: 1\n");
    rt = await testRuntime(sb);
  });
  afterEach(async () => {
    await rt.close();
    sb.cleanup();
  });

  const fileRefs: string[] = [];
  const answers: Record<string, (a: Record<string, unknown>) => unknown> = {
    "jira.get": (a) =>
      a.key === "ABC-50"
        ? task("ABC-50", "ABC-48")
        : a.key === "ABC-48"
          ? story("ABC-48", ["ABC-50", "ABC-51"])
          : a.key === "EP-9"
            ? { key: "EP-9", fields: { issuetype: { name: "Epic" } } }
            : { key: a.key },
    "jira.search": () => ({
      issues: [
        { key: "ABC-41", issue_type: { name: "Change task" } },
        { key: "ABC-51", issue_type: { name: "Change task" } },
        { key: "ABC-48", issue_type: { name: "Story" } },
      ],
    }),
    "jira.devInfo": (a) =>
      a.key === "ABC-51"
        ? {
            branches: [
              {
                name: "feature/ABC-51",
                url: "https://git.example.com/projects/SHOP/repos/orders-api/browse",
              },
            ],
            pullRequests: [
              {
                id: 7,
                status: "OPEN",
                source: { branch: "feature/ABC-51" },
                destination: { branch: "feature/ABC-48" },
                url: "https://git.example.com/projects/SHOP/repos/orders-api/pull-requests/7",
              },
            ],
          }
        : {},
    "bitbucket.branch.commits": () => ({ values: [{ id: "a1b2c3d4e5f6a7b8c9d0", message: "ABC-51 promo" }] }),
    "bitbucket.commit.get": () => ({ files: [{ path: "src/main/java/shop/OrderDto.java" }] }),
    "bitbucket.file.get": (a) => {
      fileRefs.push(String(a.ref));
      return { content: a.ref === "feature/ABC-51" ? ORDER_V2 : ORDER_V1 };
    },
  };

  function ctxFor(taskText: string): StepContext {
    const run = createRun(rt, "spec", taskText);
    return {
      run,
      runtime: rt,
      step: { id: "related-work" },
      iteration: 1,
      tools: {
        list: () => Object.keys(answers).map((name) => ({ name })),
        invoke: async (name: string, args: Record<string, unknown>) => ({
          ok: true,
          text: `[${name}] ok\n${JSON.stringify(answers[name]?.(args) ?? {})}`,
        }),
      },
    } as unknown as StepContext;
  }

  it("the Story's tasks first, compared with the Story's branch; the epic's tasks after", async () => {
    fileRefs.length = 0;
    const ctx = ctxFor("ABC-50 promo code on the order");
    await collectRelated(ctx, {});
    const doc = JSON.parse(
      rt.artifacts.text(rt.artifacts.listLatest(ctx.run.id, "related-work")[0] as never),
    ) as RelatedWorkDoc;
    expect(doc.story).toMatchObject({ key: "ABC-48", branch: "feature/ABC-48", tasks: ["ABC-51"] });
    expect(doc.items[0]).toMatchObject({
      issue: "ABC-51",
      story: "ABC-48",
      branch: "feature/ABC-51",
      base: "feature/ABC-48",
      contract: [{ kind: "dto", name: "OrderDto", fields: [{ name: "promo", change: "added" }] }],
    });
    // compared with the Story's branch, not with dev
    expect(fileRefs).toContain("feature/ABC-48");
    expect(fileRefs).not.toContain("dev");
    // the Story itself next, then the epic's own task
    expect(doc.notFound).toEqual(["ABC-48", "ABC-60", "ABC-41"]);
    expect(doc.about).toContain("Story");
    const said = rt.events.list({ runId: ctx.run.id, kind: "related.story" })[0];
    expect(said?.payload).toMatchObject({ story: "ABC-48", branch: "feature/ABC-48", based: false });
  });

  it("a Story's own run: its tasks first, the Story compared with the base", async () => {
    const ctx = ctxFor("ABC-48 promo codes");
    await collectRelated(ctx, {});
    const doc = JSON.parse(
      rt.artifacts.text(rt.artifacts.listLatest(ctx.run.id, "related-work")[0] as never),
    ) as RelatedWorkDoc;
    expect(doc.story).toMatchObject({ key: "ABC-48", tasks: ["ABC-50", "ABC-51"] });
    expect(doc.story?.based).toBeUndefined();
    expect(doc.items[0]).toMatchObject({ issue: "ABC-51", story: "ABC-48", base: "feature/ABC-48" });
  });
});

describe("the run's base: the Story's branch", () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(() => sb.cleanup());

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });

  function repoWith(branches: readonly string[]): string {
    const origin = `${sb.root}/origin.git`;
    const clone = `${sb.root}/orders-api`;
    git(sb.root, "init", "-q", "--bare", "-b", "dev", origin);
    git(sb.root, "clone", "-q", origin, clone);
    sb.write("orders-api/a.txt", "a\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-q", "-m", "init");
    git(clone, "push", "-q", "origin", "HEAD:dev");
    for (const b of branches) git(clone, "push", "-q", "origin", `HEAD:${b}`);
    return clone;
  }

  function fakeRuntime(answer: unknown, over: Record<string, unknown> = {}): Runtime {
    return {
      loaded: {
        config: {
          relatedWork: {
            enabled: true,
            story: { ...NAMES, branch: "feature/{key}", base: true, ...over },
          },
          delivery: { remote: "origin" },
        },
      },
      registry: { get: () => ({ name: "jira.get" }) },
      tools: { policy: () => ({ allowed: true }) },
      mcp: {
        provider: {
          invoke: async () => ({ result: { ok: true, text: JSON.stringify(answer) } }),
        },
      },
    } as unknown as Runtime;
  }

  it("starts from the Story's branch when the repository has it", async () => {
    const root = repoWith(["feature/ABC-48"]);
    const got = await storyBaseOf(fakeRuntime(task("ABC-50", "ABC-48")), "ABC-50 promo", root, undefined);
    expect(got).toEqual({
      key: "ABC-48",
      branch: "feature/ABC-48",
      based: true,
      ref: "origin/feature/ABC-48",
    });
  });

  it("says the branch is not there yet; nothing for a task with no Story, or when turned off", async () => {
    const root = repoWith([]);
    expect(await storyBaseOf(fakeRuntime(task("ABC-50", "ABC-48")), "ABC-50", root, undefined)).toEqual({
      key: "ABC-48",
      branch: "feature/ABC-48",
      based: false,
    });
    expect(await storyBaseOf(fakeRuntime({ key: "ABC-50", fields: {} }), "ABC-50", root, undefined)).toBe(
      undefined,
    );
    expect(await storyBaseOf(fakeRuntime(task("ABC-50", "ABC-48")), "ABC-50", root, false)).toBeUndefined();
    expect(
      await storyBaseOf(fakeRuntime(task("ABC-50", "ABC-48"), { base: false }), "ABC-50", root, undefined),
    ).toBeUndefined();
  });
});

describe("another team's Stories: User Story, «is parent task of» / «is subtask of»", () => {
  const names = {
    types: ["Story", "User Story"],
    includes: ["Включает в себя", "is parent task of"],
    includedIn: ["Включена в", "is subtask of"],
  };
  const link = (
    type: Record<string, string>,
    side: "inward_issue" | "outward_issue",
    key: string,
    issuetype: string,
  ) => ({
    type,
    [side]: { key, fields: { issuetype: { name: issuetype } } },
  });
  it("the task's Story, the Story's tasks — drawn either way", () => {
    const drawn = { name: "Parent", inward: "is subtask of", outward: "is parent task of" };
    const reversed = { name: "Child", inward: "is parent task of", outward: "is subtask of" };
    const task = (l: unknown) => JSON.stringify({ key: "ABC-77", fields: { issuelinks: [l] } });
    expect(storyOf(task(link(drawn, "inward_issue", "ABC-70", "User Story")), names)).toBe("ABC-70");
    expect(storyOf(task(link(reversed, "outward_issue", "ABC-70", "User Story")), names)).toBe("ABC-70");
    const story = JSON.stringify({
      key: "ABC-70",
      fields: {
        issuelinks: [
          link(drawn, "outward_issue", "ABC-77", "Front Task"),
          link(reversed, "inward_issue", "ABC-78", "Middle Task"),
        ],
      },
    });
    expect(inclusionsOf(story, names).includes.map((i) => i.key)).toEqual(["ABC-77", "ABC-78"]);
    // a link of another kind is not an inclusion
    expect(
      storyOf(
        task(link({ inward: "is blocked by", outward: "blocks" }, "inward_issue", "ABC-70", "User Story")),
        names,
      ),
    ).toBeUndefined();
  });
});
