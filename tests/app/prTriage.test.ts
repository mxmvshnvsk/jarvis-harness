import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PR_ARTIFACT, PR_REQUEST } from "../../src/app/deliver.ts";
import { finalizedOf, finalizeRun } from "../../src/app/finalize.ts";
import { checkPr, followsPr, prReviewOf } from "../../src/app/prReview.ts";
import {
  decideThread,
  footerOf,
  ReplyError,
  threadsToWeigh,
  triageOf,
  triagePr,
} from "../../src/app/prTriage.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import type { Run } from "../../src/core/domain/run.ts";
import type { Capability } from "../../src/tools/types.ts";
import { prPanelHtml, prReviewPageHtml } from "../../src/ui/prPanel.ts";
import { ACTOR, createRun, testRuntime } from "../helpers/engine.ts";
import { completion, type FakeOpenAi, startFakeOpenAi } from "../helpers/fakeOpenAi.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** The PR flow: the agent weighs the reviewers' comments; what goes out to the PR is the person's call. */

const PR = JSON.stringify({
  id: 312,
  state: "OPEN",
  source_commit: "11c2075dfa19",
  reviewers: ["reviewer-a (APPROVED)"],
  active_comments: [
    {
      id: 101,
      author: "reviewer-a",
      text: "promoCode may be null here",
      created_on: "2026-10-22T12:06:00.000Z",
      file_path: "src/OrderService.java",
      line_number: 48,
      state: "OPEN",
    },
    {
      id: 103,
      author: "reviewer-b",
      text: "Вынеси расчёт в common-lib",
      created_on: "2026-10-22T12:08:00.000Z",
      state: "OPEN",
    },
  ],
});

let sb: Sandbox;
let rt: Runtime;
let server: FakeOpenAi;
let posted: Array<Record<string, unknown>>;

beforeEach(async () => {
  sb = sandbox();
  server = await startFakeOpenAi();
  sb.write(
    "home/.jarvis/config.yaml",
    `version: 1
actor: { id: me@corp }
models:
  flash: { provider: openai-compatible, baseUrl: ${server.baseUrl}, model: flash, egress: private, contextWindow: 32000, maxOutput: 2000, supports: { tools: true, jsonMode: true } }
roles:
  review: { models: [flash] }
`,
  );
  sb.write("project/.jarvis/project.yaml", "version: 1\n");
  rt = await testRuntime(sb);
  posted = [];
});
afterEach(async () => {
  await rt.close();
  await server.close();
  sb.cleanup();
});

function delivered(): Run {
  const run = createRun(rt, "sdd", "ABC-42 promo code");
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
  put("spec", { title: "Promo code", requirements: [{ id: "R3", text: "no change in common-lib" }] });
  put(PR_REQUEST, {
    title: "t",
    source: "feature/ABC-42",
    target: "dev",
    workspace: "SHOP",
    repo: "orders-api",
  });
  put(PR_ARTIFACT, {
    id: "312",
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

function commentServer(): void {
  const comment: Capability = {
    name: "bitbucket.pr.comment",
    description: "comment",
    network: "intranet",
    access: "write",
    effect: true,
    server: "bitbucket",
    parameters: { type: "object" },
    async handler(args) {
      posted.push(args);
      return { ok: true, text: "{}" };
    },
  };
  rt.registry.register({ name: "fake-bitbucket", capabilities: () => [comment] });
}

const VERDICTS = {
  items: [
    {
      thread: 101,
      verdict: "agree",
      reason: "the code reads promoCode without a check",
      reply: "Agreed, adding the check.",
      change: "src/OrderService.java:48 — return early when promoCode is null",
      sources: ["src/OrderService.java:48"],
    },
    {
      thread: 103,
      verdict: "disagree",
      reason: "the spec keeps common-lib as it is (R3)",
      reply: "Расчёт нужен только здесь, по спеке common-lib не меняем (R3).",
      sources: ["R3"],
    },
  ],
};

describe("the agent weighs the PR's comments", () => {
  it("a verdict per new thread: agreed — to be fixed, disagreed — waits for the person; weighed once", async () => {
    const run = delivered();
    const review = await checkPr(rt, run, "ui", async (cap) => (cap === "bitbucket.pr.get" ? PR : undefined));
    let asked = "";
    server.respond((req) => {
      asked = JSON.stringify(req.body.messages);
      return completion(JSON.stringify(VERDICTS));
    });
    const fresh = await triagePr(rt, run, review);
    expect(asked).toContain("promoCode may be null here");
    expect(asked).toContain("no change in common-lib");
    expect(fresh.map((f) => [f.thread, f.verdict, f.state])).toEqual([
      [101, "agree", "to-fix"],
      [103, "disagree", "proposed"],
    ]);
    expect(threadsToWeigh(review, triageOf(rt, run))).toEqual([]);
    expect(rt.events.list({ runId: run.id, kind: "pr.triaged" })[0]?.payload).toMatchObject({
      agree: 1,
      disagree: 1,
    });
    // the page: the waiting thread first, with the draft and the person's buttons
    const pr = {
      id: "312",
      source: "s",
      target: "dev",
      title: "t",
      commit: "c",
      capability: "x",
      actor: "user:me",
      at: "",
    };
    const page = prReviewPageHtml(
      run,
      pr,
      review,
      prPanelHtml(run, pr, review, { approvals: 1, pollMinutes: 5, following: true, waiting: 1 }),
      triageOf(rt, run),
      "tok",
    ).toString();
    expect(page.indexOf("Вынеси расчёт")).toBeLessThan(page.indexOf("promoCode may be null"));
    expect(page).toContain("Send reply");
    expect(page).toContain("Fix anyway");
    expect(page).toContain("1 comment waits");
  });

  it("the person sends the reply: posted in the thread, ending with the line that says Jarvis wrote it", async () => {
    const run = delivered();
    const review = await checkPr(rt, run, "ui", async (cap) => (cap === "bitbucket.pr.get" ? PR : undefined));
    server.respond(() => completion(JSON.stringify(VERDICTS)));
    await triagePr(rt, run, review);
    await expect(decideThread(rt, run, 103, "send", ACTOR)).rejects.toBeInstanceOf(ReplyError);
    commentServer();
    const sent = await decideThread(rt, run, 103, "send", ACTOR);
    expect(sent.state).toBe("replied");
    expect(posted[0]).toMatchObject({ workspace: "SHOP", repo: "orders-api", id: "312", parent: 103 });
    expect(String(posted[0]?.content)).toMatch(
      /common-lib не меняем \(R3\)\.\n\n— Jarvis, ответ согласован с /,
    );
    expect(rt.effects.byRun(run.id).map((e) => [e.capability, e.status])).toEqual([
      ["bitbucket.pr.comment", "done"],
    ]);
  });

  it("an edited reply says so; «fix anyway» and «I will answer myself» are noted, nothing posted", async () => {
    expect(footerOf("Fine, keeping it", "mx", true)).toBe("— Jarvis, edited by mx");
    expect(footerOf("Оставляем", "mx", false)).toBe("— Jarvis, ответ согласован с mx");
    const run = delivered();
    const review = await checkPr(rt, run, "ui", async (cap) => (cap === "bitbucket.pr.get" ? PR : undefined));
    server.respond(() => completion(JSON.stringify(VERDICTS)));
    await triagePr(rt, run, review);
    commentServer();
    expect((await decideThread(rt, run, 103, "fix", ACTOR)).state).toBe("to-fix");
    expect((await decideThread(rt, run, 101, "self", ACTOR)).state).toBe("handled");
    expect(posted).toHaveLength(0);
  });
});

describe("finalizing the task (the end of the PR flow)", () => {
  it("a PR not ready for merge asks to say «anyway»; finalized, the run stops following it", async () => {
    const run = delivered();
    await checkPr(rt, run, "ui", async (cap) => (cap === "bitbucket.pr.get" ? PR : undefined));
    await expect(finalizeRun(rt, run, ACTOR, { lessons: false })).rejects.toMatchObject({
      code: "not-ready",
    });
    const done = await finalizeRun(rt, run, ACTOR, { lessons: false, anyway: true });
    expect(done).toMatchObject({ ready: false, merged: false, lessons: 0 });
    expect(finalizedOf(rt, run)).toBeDefined();
    expect(followsPr(rt, run)).toBe(false);
    await expect(finalizeRun(rt, run, ACTOR, { anyway: true })).rejects.toMatchObject({ code: "done" });
    const pr = {
      id: "312",
      source: "s",
      target: "dev",
      title: "t",
      commit: "c",
      capability: "x",
      actor: "user:me",
      at: "",
    };
    const panel = prPanelHtml(run, pr, prReviewOf(rt, run), {
      token: "tok",
      approvals: 1,
      pollMinutes: 5,
      following: false,
      ...(finalizedOf(rt, run) ? { finalized: finalizedOf(rt, run) as { at: string } } : {}),
    }).toString();
    expect(panel).toContain("FINALIZED");
    expect(panel).not.toContain("Finalize the task");
  });

  it("the PR's agreed comments kept as review findings: one reviewers keep making becomes a standard candidate", async () => {
    const first = delivered();
    const second = delivered();
    for (const run of [first, second]) {
      await checkPr(rt, run, "ui", async (cap) =>
        cap === "bitbucket.pr.get"
          ? JSON.stringify({
              ...JSON.parse(PR),
              reviewers: ["a (APPROVED)"],
              active_comments: [
                {
                  ...JSON.parse(PR).active_comments[0],
                  text: "check promoCode for null before computing the discount",
                },
              ],
            })
          : undefined,
      );
      server.respond(() => completion(JSON.stringify({ items: [VERDICTS.items[0]] })));
      await triagePr(rt, run, prReviewOf(rt, run) as never);
    }
    const one = await finalizeRun(rt, first, ACTOR, { lessons: true, anyway: true });
    expect(one).toMatchObject({ lessons: 1, candidates: 0 });
    const two = await finalizeRun(rt, second, ACTOR, { lessons: true, anyway: true });
    expect(two).toMatchObject({ lessons: 1, candidates: 1 });
  });
});
