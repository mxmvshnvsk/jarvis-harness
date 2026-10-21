import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app/runtime.ts";
import { checkRelated, collectRelated } from "../../src/orchestration/tools/related.ts";
import type { StepContext } from "../../src/orchestration/types.ts";
import {
  contractChanges,
  devInfoOf,
  isContractFile,
  issueFacts,
  localReader,
  pickRelated,
  type RelatedWorkDoc,
  repoOfUrl,
  searchHits,
} from "../../src/sources/relatedWork.ts";
import { git as runGit } from "../../src/tools/local/exec.ts";
import { createRun, engineFor, testRuntime, workflowOf } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** ADR-0026: the work of related tasks — their branches and PRs — read before the spec. */

const ORDER_V1 =
  "package shop;\n\npublic class OrderDto {\n  private Long id;\n  private String status;\n}\n";
const ORDER_V2 =
  "package shop;\n\npublic class OrderDto {\n  private Long id;\n  private String status;\n  private java.math.BigDecimal discountAmount;\n}\n";
const CONTROLLER_V2 =
  'package shop;\n\n@RestController\npublic class OrderController {\n  @GetMapping("/orders/{id}/discount")\n  public OrderDto discount() { return null; }\n}\n';

describe("reading what the tools answer", () => {
  it("an issue: its type, status, epic or parent and its links", () => {
    const facts = issueFacts(
      `[jira.get] ok\n${JSON.stringify({
        key: "ABC-42",
        summary: "Discount on the order screen",
        issue_type: { name: "Front Task" },
        status: { name: "In Progress" },
        parent: { key: "ABC-40" },
        issuelinks: [{ type: "relates", outward_issue: { key: "ABC-77" } }],
      })}`,
    );
    expect(facts).toMatchObject({
      key: "ABC-42",
      type: "Front Task",
      status: "In Progress",
      parent: "ABC-40",
    });
    expect(facts.links).toEqual(["ABC-77"]);
  });

  it("a search: each issue once with its type", () => {
    const hits = searchHits(
      JSON.stringify({
        issues: [
          { key: "ABC-41", issue_type: { name: "Back Task" }, status: { name: "In Review" } },
          { key: "ABC-43", issue_type: { name: "Front Task" } },
        ],
      }),
    );
    expect(hits.map((h) => `${h.key}:${h.type}`)).toEqual(["ABC-41:Back Task", "ABC-43:Front Task"]);
  });

  it("the Development panel: branches and pull requests with their repository", () => {
    const dev = devInfoOf(
      JSON.stringify({
        branches: [
          {
            name: "feature/ABC-41-discount",
            url: "https://git.example.com/projects/SHOP/repos/orders-api/browse?at=refs/heads/feature/ABC-41-discount",
          },
        ],
        pullRequests: [
          {
            id: 312,
            status: "OPEN",
            url: "https://git.example.com/projects/SHOP/repos/orders-api/pull-requests/312",
            source: { branch: "feature/ABC-41-discount" },
          },
        ],
      }),
    );
    expect(dev.branches).toEqual([
      {
        name: "feature/ABC-41-discount",
        repo: { workspace: "SHOP", slug: "orders-api" },
        url: expect.stringContaining("orders-api"),
      },
    ]);
    expect(dev.prs[0]).toMatchObject({ id: "312", state: "OPEN", branch: "feature/ABC-41-discount" });
    expect(repoOfUrl("https://bitbucket.org/acme/payments-service/src")).toEqual({
      workspace: "acme",
      slug: "payments-service",
    });
  });

  it("picks the other side first: a front task reads the back ones", () => {
    const sides = { "Back Task": "back", "Front Task": "front" };
    const picked = pickRelated(
      "ABC-42",
      "front",
      [
        { key: "ABC-43", type: "Front Task", links: [] },
        { key: "ABC-42", type: "Front Task", links: [] },
        { key: "ABC-44", type: "Task", links: [] },
        { key: "ABC-41", type: "Back Task", links: [] },
      ],
      sides,
      3,
    );
    expect(picked.map((p) => p.key)).toEqual(["ABC-41", "ABC-44", "ABC-43"]);
  });

  it("the contract in a change: DTO fields and endpoints, not the rest", () => {
    expect(isContractFile("src/main/java/shop/OrderDto.java")).toBe(true);
    expect(isContractFile("src/main/java/shop/OrderController.java")).toBe(true);
    expect(isContractFile("src/main/java/shop/DiscountCalculator.java")).toBe(false);
    expect(contractChanges("src/main/java/shop/OrderDto.java", ORDER_V1, ORDER_V2)).toEqual([
      {
        kind: "dto",
        name: "OrderDto",
        change: "changed",
        file: "src/main/java/shop/OrderDto.java",
        fields: [{ name: "discountAmount", change: "added", type: "number" }],
      },
    ]);
    expect(contractChanges("src/main/java/shop/OrderController.java", "", CONTROLLER_V2)).toEqual([
      {
        kind: "endpoint",
        name: "GET /orders/{id}/discount",
        change: "added",
        file: "src/main/java/shop/OrderController.java",
      },
    ]);
  });
});

describe("a branch on this machine", () => {
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

  /** A remote with dev and the back task's branch, and a clone of it on this machine. */
  function backRepo() {
    const origin = `${sb.root}/origin.git`;
    const work = `${sb.root}/work`;
    const clone = `${sb.root}/orders-api`;
    git(sb.root, "init", "-q", "--bare", "-b", "dev", origin);
    git(sb.root, "clone", "-q", origin, work);
    sb.write("work/src/main/java/shop/OrderDto.java", ORDER_V1);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "ABC-1 orders");
    git(work, "push", "-q", "origin", "HEAD:dev");
    git(sb.root, "clone", "-q", origin, clone);
    git(work, "checkout", "-q", "-b", "feature/ABC-41-discount");
    sb.write("work/src/main/java/shop/OrderDto.java", ORDER_V2);
    sb.write("work/src/main/java/shop/OrderController.java", CONTROLLER_V2);
    sb.write("work/src/main/java/shop/DiscountCalculator.java", "class DiscountCalculator {}\n");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "ABC-41 discount");
    git(work, "push", "-q", "origin", "feature/ABC-41-discount");
    return { clone };
  }

  it("fetches the branch, compares it with its base and reads the contract files on both sides", async () => {
    const { clone } = backRepo();
    const reader = localReader(clone, async (args, cwd) => {
      const r = await runGit(args, cwd);
      return { code: r.code ?? 1, stdout: r.stdout };
    });
    const work = await reader.read("feature/ABC-41-discount", "ABC-41");
    expect(work?.base).toBe("dev");
    expect(work?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect([...(work?.files ?? [])].sort()).toEqual([
      "src/main/java/shop/DiscountCalculator.java",
      "src/main/java/shop/OrderController.java",
      "src/main/java/shop/OrderDto.java",
    ]);
    expect(work?.read.map((f) => f.file).sort()).toEqual([
      "src/main/java/shop/OrderController.java",
      "src/main/java/shop/OrderDto.java",
    ]);
  });
});

describe("the related-work step", () => {
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

  /** Jira and Bitbucket as the pilot's servers answer, without a network. */
  const answers: Record<string, (a: Record<string, unknown>) => unknown> = {
    "jira.get": (a) =>
      a.key === "ABC-42"
        ? { key: "ABC-42", issue_type: { name: "Front Task" }, parent: { key: "ABC-40" } }
        : { key: a.key },
    "jira.search": () => ({
      issues: [
        { key: "ABC-42", issue_type: { name: "Front Task" } },
        { key: "ABC-41", issue_type: { name: "Back Task" }, status: { name: "In Review" } },
        { key: "ABC-45", issue_type: { name: "Back Task" } },
      ],
    }),
    "jira.devInfo": (a) =>
      a.key === "ABC-41"
        ? {
            branches: [
              {
                name: "feature/ABC-41-discount",
                url: "https://git.example.com/projects/SHOP/repos/orders-api/browse",
              },
            ],
            pullRequests: [
              {
                id: 312,
                status: "OPEN",
                source: { branch: "feature/ABC-41-discount" },
                url: "https://git.example.com/projects/SHOP/repos/orders-api/pull-requests/312",
              },
            ],
          }
        : {},
    "bitbucket.branch.commits": () => ({
      values: [
        { id: "a1b2c3d4e5f6a7b8c9d0", message: "ABC-41 discount on the order" },
        { id: "0f0f0f0f0f0f0f0f0f0f", message: "ABC-1 orders" },
      ],
    }),
    "bitbucket.commit.get": () => ({
      files: [{ path: "src/main/java/shop/OrderDto.java" }, { path: "src/main/java/shop/Calc.java" }],
    }),
    "bitbucket.file.get": (a) => ({ content: a.ref === "feature/ABC-41-discount" ? ORDER_V2 : ORDER_V1 }),
  };

  function ctxFor(task: string, available = Object.keys(answers)): StepContext {
    const run = createRun(rt, "spec", task);
    return {
      run,
      runtime: rt,
      step: { id: "related-work" },
      iteration: 1,
      tools: {
        list: () => available.map((name) => ({ name })),
        invoke: async (name: string, args: Record<string, unknown>) => ({
          ok: true,
          text: `[${name}] ok\n${JSON.stringify(answers[name]?.(args) ?? {})}`,
        }),
      },
    } as unknown as StepContext;
  }

  it("reads the back task's branch through Bitbucket: its PR, commit and the contract it changes", async () => {
    const ctx = ctxFor("ABC-42 discount on the order screen");
    const out = await collectRelated(ctx, {});
    expect(out.status).toBe("success");
    const doc = JSON.parse(
      rt.artifacts.text(rt.artifacts.listLatest(ctx.run.id, "related-work")[0] as never),
    ) as RelatedWorkDoc;
    expect(doc.from).toBe("ABC-42");
    expect(doc.items[0]).toMatchObject({
      issue: "ABC-41",
      type: "Back Task",
      repo: "orders-api",
      branch: "feature/ABC-41-discount",
      commit: "a1b2c3d4e5f6",
      pr: { id: "312", state: "OPEN" },
      found: "bitbucket",
      contract: [{ kind: "dto", name: "OrderDto", fields: [{ name: "discountAmount", change: "added" }] }],
      files: { contract: 1, other: 1 },
    });
    expect(doc.notFound).toEqual(["ABC-45"]);
    expect(doc.about).toContain("dependency");
  });

  it("before implementation: a branch that moved on with its contract changed is said", async () => {
    const ctx = ctxFor("ABC-42 discount on the order screen");
    await collectRelated(ctx, {});
    // meanwhile the back task pushed again and dropped the field
    answers["bitbucket.branch.commits"] = () => ({
      values: [{ id: "b2c3d4e5f6a7b8c9d0e1", message: "ABC-41 rename" }],
    });
    answers["bitbucket.file.get"] = () => ({ content: ORDER_V1 });
    await checkRelated({ ...ctx, step: { id: "related-check" } } as StepContext, {});
    expect(rt.events.list({ runId: ctx.run.id, kind: "related.moved" })[0]?.payload).toMatchObject({
      issue: "ABC-41",
      from: "a1b2c3d4e5f6",
      to: "b2c3d4e5f6a7",
      contractChanged: true,
      merged: false,
    });
    expect(rt.artifacts.listLatest(ctx.run.id, "related-work")[0]?.version).toBe(2);
  });

  it("says what is missing instead of failing: no Development panel tool", async () => {
    const ctx = ctxFor("ABC-42 discount", ["jira.get", "jira.search"]);
    await collectRelated(ctx, {});
    const doc = JSON.parse(
      rt.artifacts.text(rt.artifacts.listLatest(ctx.run.id, "related-work")[0] as never),
    ) as RelatedWorkDoc;
    expect(doc.items[0]?.note).toContain("jira.devInfo is not available");
  });

  it("is skipped for a run that does not want it, and by the project's default", async () => {
    const wf = workflowOf({
      name: "rel",
      entry: "related-work",
      steps: [
        {
          id: "related-work",
          kind: "deterministic",
          tool: "related.collect",
          transitions: { onSuccess: "DONE" },
        },
      ],
    });
    const engine = engineFor(rt, [wf]);
    const off = createRun(rt, "rel", "ABC-42 x", { related: false });
    expect((await engine.execute(off.id, { owner: "cli:test:1" })).run.state).toBe("COMPLETED");
    expect(rt.events.list({ runId: off.id, kind: "step.finish" })[0]?.payload).toMatchObject({
      status: "skipped",
      reason: "related work is off for this run",
    });
  });
});
