import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PR_ARTIFACT, PR_REQUEST } from "../../src/app/deliver.ts";
import {
  buildOf,
  checkPr,
  followsPr,
  type PrReader,
  prCheckDue,
  prReviewOf,
  prStateOf,
  readinessOf,
} from "../../src/app/prReview.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import type { Run } from "../../src/core/domain/run.ts";
import { feedItem } from "../../src/ui/model.ts";
import { prPanelHtml, prReviewPageHtml } from "../../src/ui/prPanel.ts";
import { createRun, testRuntime } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** The PR flow after the PR is up: the PR read from the server, ready for merge or what stands before it. */

/** `get_pull_request` of @nexus2520/bitbucket-mcp-server on Bitbucket Server, as the pilot's answered. */
const PR = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 312,
    version: 5,
    title: "feat(orders): ABC-42 order totals",
    state: "OPEN",
    source_branch: "feature/ABC-42",
    destination_branch: "dev",
    source_commit: "11c2075dfa190aa63798c3b044aa3e94f385fcc2",
    reviewers: ["reviewer-a (APPROVED)", "Reviewer B", "reviewer-c (NEEDS_WORK)"],
    active_comments: [
      {
        id: 101,
        author: "reviewer-a",
        text: "promoCode may be null here",
        created_on: "2026-10-22T12:06:00.000Z",
        is_inline: true,
        file_path: "src/main/java/shop/OrderService.java",
        line_number: 48,
        state: "OPEN",
        version: 0,
        replies: [
          {
            id: 102,
            author: "Dev",
            text: "Fixed in a1b2c3d\n\n— Jarvis <!-- jarvis:run=abc;thread=101 -->",
            created_on: "2026-10-22T12:11:00.000Z",
            is_inline: true,
            state: "OPEN",
          },
        ],
      },
      {
        id: 103,
        author: "reviewer-b",
        text: "Describe the migration",
        is_inline: false,
        state: "OPEN",
        is_task: true,
      },
    ],
    active_comment_count: 3,
    total_comment_count: 3,
    open_task_count: 1,
    ...over,
  });
const COMMITS = JSON.stringify({
  pull_request_id: 312,
  commits: [
    { hash: "11c2075dfa19", message: "feat", build_status: { successful: 1, failed: 0, in_progress: 0 } },
  ],
});

describe("reading a PR", () => {
  it("its state, reviewers, open threads with their replies and Jarvis's own, the tasks", () => {
    const s = prStateOf(`[bitbucket.pr.get] ok\n${PR()}`);
    expect(s).toMatchObject({ state: "OPEN", version: 5, approvals: 1, openTasks: 1 });
    expect(s.reviewers).toEqual([
      { name: "Reviewer B" },
      { name: "reviewer-a", status: "APPROVED" },
      { name: "reviewer-c", status: "NEEDS_WORK" },
    ]);
    expect(s.threads[0]).toMatchObject({ id: 101, file: "src/main/java/shop/OrderService.java", line: 48 });
    expect(s.threads[0]?.replies[0]).toMatchObject({ id: 102, mine: true });
    expect(s.threads[1]).toMatchObject({ id: 103, task: true });
    expect(buildOf(COMMITS, s.head)).toEqual({ successful: 1, failed: 0, inProgress: 0 });
  });

  it("the reviewers in a stable order; a tool's comment is not an open thread", () => {
    // pilot: the server listed the reviewers in another order on every read — a new document each poll
    const one = prStateOf(PR({ reviewers: ["b (APPROVED)", "a", "c"] }));
    const two = prStateOf(PR({ reviewers: ["c", "b (APPROVED)", "a"] }));
    expect(one.reviewers).toEqual(two.reviewers);
    // a scanner's summary and a code-owners notice hold no merge and get no answer
    const bots = prStateOf(
      PR({
        reviewers: ["a (APPROVED)"],
        active_comments: [
          { id: 1, author: "scanner", text: "| tool | issues |", state: "OPEN" },
          { id: 2, author: "Owners Bot", text: "owners added", state: "OPEN" },
          { id: 3, author: "Reviewer B", text: "why?", state: "OPEN" },
        ],
        open_task_count: 0,
      }),
      ["scanner"],
    );
    expect(bots.threads.map((t) => [t.id, t.bot ?? false])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
    expect(readinessOf({ ...bots, approvals: 5 }, 1).blockers).toEqual(["open threads: 1"]);
  });

  it("ready for merge: enough approvals, nobody wants work, no open thread or task, the build green", () => {
    const s = prStateOf(PR());
    expect(
      readinessOf({ ...s, build: buildOf(COMMITS) as NonNullable<ReturnType<typeof buildOf>> }, 2).blockers,
    ).toEqual(["approvals: 1 of 2", "needs work: reviewer-c", "open threads: 2", "open tasks: 1"]);
    const clean = prStateOf(
      PR({ reviewers: ["a (APPROVED)", "b (APPROVED)"], active_comments: [], open_task_count: 0 }),
    );
    expect(
      readinessOf({ ...clean, build: buildOf(COMMITS) as NonNullable<ReturnType<typeof buildOf>> }, 2),
    ).toEqual({ ready: true, blockers: [] });
    expect(readinessOf({ ...clean, build: { successful: 0, failed: 1, inProgress: 0 } }, 2).ready).toBe(
      false,
    );
    expect(readinessOf({ ...clean, state: "MERGED" }, 2)).toEqual({
      ready: false,
      blockers: ["the PR is MERGED"],
    });
  });
});

describe("following the run's PR", () => {
  let sb: Sandbox;
  let rt: Runtime;
  beforeEach(async () => {
    sb = sandbox();
    sb.write("project/.jarvis/project.yaml", "version: 1\ndelivery:\n  flow: { ready: { approvals: 2 } }\n");
    rt = await testRuntime(sb);
  });
  afterEach(async () => {
    await rt.close();
    sb.cleanup();
  });

  function delivered(): Run {
    const run = createRun(rt, "sdd", "ABC-42 order totals");
    rt.db.db.prepare("UPDATE runs SET state = 'COMPLETED' WHERE id = ?").run(run.id);
    const put = (type: string, content: unknown) =>
      rt.artifacts.put({
        runId: run.id,
        type,
        name: `${type}.json`,
        content: JSON.stringify(content),
        provenance: { kind: "tool", capability: "runtime.delivery" },
        stepId: "deliver",
      });
    put(PR_REQUEST, {
      title: "t",
      source: "feature/ABC-42",
      target: "dev",
      workspace: "SHOP",
      repo: "orders-api",
    });
    put(PR_ARTIFACT, {
      id: "312",
      url: "https://git.example.com/projects/SHOP/repos/orders-api/pull-requests/312",
      title: "t",
      source: "feature/ABC-42",
      target: "dev",
      commit: "c",
      capability: "bitbucket.pr.create",
      actor: "user:me@corp",
      at: "2026-10-22T12:00:00.000Z",
    });
    return rt.runs.require(run.id);
  }

  it("reads it now: the document, what is new in the feed, and the next read after pollMinutes", async () => {
    const run = delivered();
    expect(followsPr(rt, run)).toBe(true);
    expect(prCheckDue(rt, run)).toBe(true);
    const calls: Array<[string, Record<string, unknown>]> = [];
    const read: PrReader = async (cap, args) => {
      calls.push([cap, args]);
      return cap === "bitbucket.pr.get" ? PR() : COMMITS;
    };
    const doc = await checkPr(rt, run, "ui", read);
    expect(calls[0]).toEqual(["bitbucket.pr.get", { workspace: "SHOP", repo: "orders-api", id: "312" }]);
    expect(doc).toMatchObject({ approvals: 1, ready: false, build: { successful: 1 } });
    expect(prReviewOf(rt, run)?.threads).toHaveLength(2);
    const said = rt.events.list({ runId: run.id, kind: "pr.checked" })[0];
    // the reply of Jarvis is not news
    expect(said?.payload).toMatchObject({ fresh: 2, open: 2, ready: false });
    expect(feedItem(said as never)?.text).toContain("2 comments new");
    expect(prCheckDue(rt, run)).toBe(false);
    expect(prCheckDue(rt, run, Date.now() + 5 * 60_000)).toBe(true);
    // read again, nothing changed: no new version, nothing in the feed
    await checkPr(rt, run, "poll", read);
    expect(rt.artifacts.listLatest(run.id, "pr-review")[0]?.version).toBe(1);
    const again = rt.events.list({ runId: run.id, kind: "pr.checked" })[1];
    expect(feedItem(again as never)).toBeUndefined();
  });

  it("merged: the run stops following it", async () => {
    const run = delivered();
    await checkPr(rt, run, "poll", async (cap) =>
      cap === "bitbucket.pr.get" ? PR({ state: "MERGED" }) : undefined,
    );
    expect(followsPr(rt, run)).toBe(false);
    expect(prCheckDue(rt, run, Date.now() + 3600_000)).toBe(false);
  });

  it("the panel and the code review page show where it stands, the threads, Jarvis's apart", async () => {
    const run = delivered();
    const doc = await checkPr(rt, run, "ui", async (cap) => (cap === "bitbucket.pr.get" ? PR() : COMMITS));
    const pr = {
      id: "312",
      source: "feature/ABC-42",
      target: "dev",
      title: "t",
      commit: "c",
      capability: "x",
      actor: "user:me",
      at: "",
    };
    const panel = prPanelHtml(run, pr, doc, {
      token: "tok",
      approvals: 2,
      pollMinutes: 5,
      following: true,
    }).toString();
    expect(panel).toContain("PR_REVIEW");
    expect(panel).toContain("1 of 2");
    expect(panel).toContain("Check comments");
    const page = prReviewPageHtml(
      run,
      pr,
      doc,
      prPanelHtml(run, pr, doc, { approvals: 2, pollMinutes: 5, following: true }),
    ).toString();
    expect(page).toContain("promoCode may be null here");
    expect(page).toContain("OrderService.java:48");
    expect(page).not.toContain("jarvis:run=");
    const ready = { ...doc, ready: true, blockers: [] };
    expect(
      prPanelHtml(run, pr, ready, { approvals: 2, pollMinutes: 5, following: true }).toString(),
    ).toContain("READY_TO_MERGE");
  });
});
