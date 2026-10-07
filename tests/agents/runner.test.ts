import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_AGENTS } from "../../src/agents/builtin/index.ts";
import { AgentRegistry } from "../../src/agents/definition.ts";
import { AgentRuntimeRunner, inParallel } from "../../src/agents/runner.ts";
import { type BudgetStop, budgetGranted, budgetStopOf, grantBudget } from "../../src/app/budgetStop.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import { AgenticExecutor, DeterministicExecutor } from "../../src/orchestration/executors.ts";
import { LocalWorkflowEngine } from "../../src/orchestration/runtime.ts";
import { BUILTIN_TOOLS } from "../../src/orchestration/tools/builtin.ts";
import { ACTOR, testRuntime, workflowOf } from "../helpers/engine.ts";
import {
  type CapturedRequest,
  completion,
  type FakeOpenAi,
  startFakeOpenAi,
  toolCallCompletion,
} from "../helpers/fakeOpenAi.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let server: FakeOpenAi;
let rt: Runtime | undefined;

const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

beforeEach(async () => {
  sb = sandbox();
  server = await startFakeOpenAi();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: sb.project, env: { ...process.env, ...gitEnv } });
  mkdirSync(join(sb.project, "src"), { recursive: true });
  writeFileSync(
    join(sb.project, "src", "onboarding.ts"),
    "export function canRestartOnboarding() {\n  return false;\n}\n",
  );
  sb.write(
    "project/.jarvis/knowledge/domain.md",
    "# Domain\nOnboarding = регистрация клиента. 'Повторная регистрация после отказа' → canRestartOnboarding().\n",
  );
  sb.write(
    "home/.jarvis/config.yaml",
    `version: 1
models:
  flash:
    provider: openai-compatible
    baseUrl: ${server.baseUrl}
    model: flash
    egress: private
    contextWindow: 32000
    maxOutput: 2000
    supports: { tools: true, jsonMode: true }
roles:
  research: { models: [flash] }
  implementation: { models: [flash] }
  review: { models: [flash] }
`,
  );
  execFileSync("git", ["add", "-A"], { cwd: sb.project });
  execFileSync("git", ["commit", "-q", "-m", "init"], {
    cwd: sb.project,
    env: { ...process.env, ...gitEnv },
  });
});

afterEach(async () => {
  await rt?.close();
  await server.close();
  sb.cleanup();
});

const RESEARCH_DOC = {
  summary: "The task touches onboarding restart.",
  findings: [
    { topic: "restart", detail: "canRestartOnboarding returns false", sources: ["src/onboarding.ts:2"] },
  ],
  affectedAreas: ["src/onboarding.ts"],
  existingImplementations: [],
  unknowns: [],
  sources: ["src/onboarding.ts"],
  reasons: [],
  outcome: "ok",
};

function engineWith(runtime: Runtime, workflow: ReturnType<typeof workflowOf>) {
  const registry = new AgentRegistry(BUILTIN_AGENTS, runtime.loaded.project?.root);
  return new LocalWorkflowEngine({
    runtime,
    workflows: new Map([[workflow.name, workflow]]),
    executors: {
      deterministic: new DeterministicExecutor(BUILTIN_TOOLS),
      agentic: new AgenticExecutor(new AgentRuntimeRunner(registry)),
    },
    leaseOptions: { heartbeatMs: 0 },
  });
}

function createRun(runtime: Runtime, workflow: string) {
  return runtime.runs.create({
    task: "ABC-1",
    workflow,
    owner: ACTOR,
    workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
    dataClass: "confidential",
  });
}

const researchOnly = workflowOf({
  name: "r",
  entry: "research",
  steps: [
    {
      id: "research",
      kind: "agentic",
      agent: "research",
      outputs: ["research"],
      transitions: { onSuccess: "DONE" },
    },
  ],
});

function lastUserContent(req: CapturedRequest): string {
  const messages = req.body.messages as Array<{ role: string; content: string | null }>;
  return [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
}

describe("inParallel", () => {
  it("runs at most `limit` at once and every item once", async () => {
    let now = 0;
    let peak = 0;
    const done: number[] = [];
    await inParallel([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      now += 1;
      peak = Math.max(peak, now);
      await new Promise((r) => setTimeout(r, 5 + (n % 3) * 5));
      now -= 1;
      done.push(n);
    });
    expect(peak).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("AgentRuntimeRunner", () => {
  it("builds layered context, runs the tool loop, finalizes a structured artifact", async () => {
    sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
    rt = await testRuntime(sb, { PATH: process.env.PATH ?? "" });
    server.respond((_req, i) => {
      if (i === 0) return toolCallCompletion("repo.search", { pattern: "canRestartOnboarding" });
      if (i === 1) return toolCallCompletion("repo.read", { path: "src/onboarding.ts" });
      if (i === 2) return completion("I have what I need.");
      return completion(JSON.stringify(RESEARCH_DOC));
    });
    const engine = engineWith(rt, researchOnly);
    const run = createRun(rt, "r");
    const result = await engine.execute(run.id, { owner: "cli:t" });
    expect(result.run.state).toBe("COMPLETED");

    const first = server.requests[0] as CapturedRequest;
    const messages = first.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("# Agent: research");
    expect(messages[0]?.content).toContain("- repo.search:");
    expect(messages[0]?.content).not.toContain("repo.write");
    expect(messages[1]?.content).toContain("# Task ABC-1");
    expect(messages[1]?.content).toContain("Knowledge domain.md");
    expect(messages[1]?.content).toContain("canRestartOnboarding()");
    expect(
      (first.body.tools as unknown[]).map((t) => (t as { function: { name: string } }).function.name),
    ).toEqual(expect.arrayContaining(["repo.read", "repo.search", "git.log"]));
    // System layer is byte-identical across the tool rounds (ADR-0013 §4).
    const systemTexts = server.requests
      .slice(0, 3)
      .map((r) => (r.body.messages as Array<{ content: string }>)[0]?.content);
    expect(new Set(systemTexts).size).toBe(1);

    const third = server.requests[2] as CapturedRequest;
    const toolMsgs = (third.body.messages as Array<{ role: string; content: string }>).filter(
      (m) => m.role === "tool",
    );
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0]?.content).toContain("[repo.search] ok");
    expect(toolMsgs[0]?.content).toContain("src/onboarding.ts:1:");
    expect(toolMsgs[1]?.content).toContain("export function canRestartOnboarding");

    const final = server.requests[3] as CapturedRequest;
    expect(lastUserContent(final)).toContain("Produce the result document");
    expect((final.body.response_format as { type: string }).type).toBe("json_object");

    const artifact = rt.artifacts.find(run.id, "research", "research.json");
    expect(artifact?.provenance).toMatchObject({ kind: "agent", agentId: "research" });
    expect(artifact?.sourceRefs).toEqual([
      "src/onboarding.ts",
      expect.stringMatching(/^knowledge:domain\.md#/),
    ]);
    expect(JSON.parse(rt.artifacts.text(artifact as NonNullable<typeof artifact>))).toMatchObject({
      summary: RESEARCH_DOC.summary,
    });
    const finish = rt.events.list({ kind: "agent.finish" })[0]?.payload;
    expect(finish).toMatchObject({ agent: "research", status: "success", toolCalls: 2, modelCalls: 4 });
  });

  it("takes the result document from the answer the tool loop ended with, without asking again (pilot)", async () => {
    sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
    rt = await testRuntime(sb, { PATH: process.env.PATH ?? "" });
    server.respond((_req, i) => {
      if (i === 0) return toolCallCompletion("repo.read", { path: "src/onboarding.ts" });
      // DeepSeek ended its loop with the document in a fence
      return completion(`Here it is:\n\`\`\`json\n${JSON.stringify(RESEARCH_DOC, null, 2)}\n\`\`\``);
    });
    const run = createRun(rt, "r");
    const result = await engineWith(rt, researchOnly).execute(run.id, { owner: "cli:t" });
    expect(result.run.state).toBe("COMPLETED");
    expect(server.requests).toHaveLength(2);
    const artifact = rt.artifacts.find(run.id, "research", "research.json");
    expect(JSON.parse(rt.artifacts.text(artifact as NonNullable<typeof artifact>))).toMatchObject({
      summary: RESEARCH_DOC.summary,
    });
    const finish = rt.events.list({ kind: "agent.finish" })[0]?.payload;
    expect(finish).toMatchObject({
      status: "success",
      modelCalls: 2,
      repairs: 0,
      finalizedFromLoop: true,
      endedWith: "document",
    });
  });

  it("DONE ends the loop with a short answer; the document is asked for right after, with what stays unknown", async () => {
    sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
    rt = await testRuntime(sb, { PATH: process.env.PATH ?? "" });
    server.respond((_req, i) => {
      if (i === 0) return toolCallCompletion("repo.read", { path: "src/onboarding.ts" });
      if (i === 1)
        return completion("DONE — whether the restart keeps the old answers is not in the sources.");
      return completion(JSON.stringify(RESEARCH_DOC));
    });
    const run = createRun(rt, "r");
    const result = await engineWith(rt, researchOnly).execute(run.id, { owner: "cli:t" });
    expect(result.run.state).toBe("COMPLETED");
    expect(server.requests).toHaveLength(3);
    // the system rule asks for it; the request for the document carries what the agent said is unknown
    const system =
      ((server.requests[0]?.body.messages ?? []) as Array<{ content: string }>)[0]?.content ?? "";
    expect(system).toContain("reply without tool calls with one line: DONE");
    const last = (server.requests[2]?.body.messages ?? []) as Array<{ role: string; content: string }>;
    expect(last.at(-2)).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("not in the sources"),
    });
    expect(last.at(-1)?.content).toContain('Produce the result document for artifact type "research" now.');
    expect(rt.events.list({ kind: "agent.finish" })[0]?.payload).toMatchObject({
      status: "success",
      finalizedFromLoop: false,
      endedWith: "done",
    });
  });

  it("asks to fix a loop answer that misses the schema, keeping that answer in the request", async () => {
    sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
    rt = await testRuntime(sb, { PATH: process.env.PATH ?? "" });
    const { summary: _missing, ...withoutSummary } = RESEARCH_DOC;
    server.respond((_req, i) => {
      if (i === 0) return completion(JSON.stringify(withoutSummary));
      return completion(JSON.stringify(RESEARCH_DOC));
    });
    const run = createRun(rt, "r");
    const result = await engineWith(rt, researchOnly).execute(run.id, { owner: "cli:t" });
    expect(result.run.state).toBe("COMPLETED");
    expect(server.requests).toHaveLength(2);
    const final = server.requests[1] as CapturedRequest;
    const messages = final.body.messages as Array<{ role: string; content: string }>;
    expect(messages.at(-2)).toMatchObject({ role: "assistant", content: JSON.stringify(withoutSummary) });
    expect(lastUserContent(final)).toContain("Produce the result document");
    expect(lastUserContent(final)).toContain("summary:");
    const finish = rt.events.list({ kind: "agent.finish" })[0]?.payload;
    expect(finish).toMatchObject({ status: "success", modelCalls: 2, finalizedFromLoop: false });
  });

  it("sizes the knowledge layer from the window capped by context.maxContext (pilot)", async () => {
    sb.write(
      "home/.jarvis/config.yaml",
      `version: 1
models:
  big:
    provider: openai-compatible
    baseUrl: ${server.baseUrl}
    model: big
    egress: private
    contextWindow: 1000000
    maxOutput: 2000
    supports: { tools: true, jsonMode: true }
roles:
  research: { models: [big] }
context: { maxContext: 8000 }
`,
    );
    sb.write("project/.jarvis/knowledge/huge.md", `# Huge\n${"fact ".repeat(4000)}\n`);
    sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
    rt = await testRuntime(sb, { PATH: process.env.PATH ?? "" });
    server.respond(() => completion(JSON.stringify(RESEARCH_DOC)));
    const run = createRun(rt, "r");
    expect((await engineWith(rt, researchOnly).execute(run.id, { owner: "cli:t" })).run.state).toBe(
      "COMPLETED",
    );
    const first = server.requests[0] as CapturedRequest;
    const task = (first.body.messages as Array<{ content: string }>)[1]?.content ?? "";
    // 8000 tokens of window leave about a thousand characters for knowledge, not the whole 20k document
    expect(task).toContain("huge.md");
    expect(task).not.toContain("fact ".repeat(1000));
  });

  it("feeds denied and malformed tool calls back to the model instead of failing", async () => {
    sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
    rt = await testRuntime(sb, { PATH: process.env.PATH ?? "" });
    server.respond((_req, i) => {
      if (i === 0) return toolCallCompletion("repo.write", { path: "x", content: "y" });
      if (i === 1)
        return {
          body: {
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    { id: "c", type: "function", function: { name: "repo.read", arguments: "{not json" } },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          },
        };
      if (i === 2) return completion("done");
      return completion(JSON.stringify(RESEARCH_DOC));
    });
    const engine = engineWith(rt, researchOnly);
    const run = createRun(rt, "r");
    const result = await engine.execute(run.id, { owner: "cli:t" });
    expect(result.run.state).toBe("COMPLETED");
    const third = server.requests[2] as CapturedRequest;
    const toolMsgs = (third.body.messages as Array<{ role: string; content: string }>).filter(
      (m) => m.role === "tool",
    );
    expect(toolMsgs[0]?.content).toContain("[repo.write] denied: not in the agent's capability set");
    expect(toolMsgs[1]?.content).toContain("[repo.read] error: arguments are not valid JSON");
    expect(rt.events.list({ kind: "tool.denied" })).toHaveLength(1);
  });

  it("checkpoints the transcript every N tool calls and resumes it after quota exhaustion", async () => {
    sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
    sb.write("project/.jarvis/agents/research.md", "Custom research instructions from the project.");
    rt = await testRuntime(sb, { PATH: process.env.PATH ?? "" });
    let phase = 0;
    server.respond((_req, i) => {
      if (phase === 0) {
        if (i < 5) return toolCallCompletion("repo.list", {});
        return { status: 429, body: { error: { message: "insufficient_quota" } } };
      }
      // Resumed process: the model asks for one more tool, then finishes.
      const n = i - 6;
      if (n === 0) return toolCallCompletion("repo.read", { path: "src/onboarding.ts" });
      if (n === 1) return completion("done");
      return completion(JSON.stringify(RESEARCH_DOC));
    });
    const engine = engineWith(rt, researchOnly);
    const run = createRun(rt, "r");
    const parked = await engine.execute(run.id, { owner: "cli:t" });
    expect(parked.run.state).toBe("WAITING_BUDGET");
    const ckp = rt.checkpoints.list(run.id).filter((c) => c.kind === "intra");
    expect(ckp.length).toBeGreaterThanOrEqual(1);
    expect(ckp[0]?.state).toMatchObject({ toolCalls: 5 });
    expect((server.requests[0] as CapturedRequest).body.messages as unknown[]).toBeDefined();
    expect(
      ((server.requests[0] as CapturedRequest).body.messages as Array<{ content: string }>)[0]?.content,
    ).toContain("Custom research instructions from the project.");

    phase = 1;
    const resumed = await engine.execute(run.id, { owner: "cli:t" });
    expect(resumed.run.state).toBe("COMPLETED");
    const firstAfterResume = server.requests[6] as CapturedRequest;
    const msgs = firstAfterResume.body.messages as Array<{ role: string }>;
    // 2 base + 5 × (assistant + tool) restored from the checkpointed transcript
    expect(msgs.filter((m) => m.role === "tool")).toHaveLength(5);
    const finish = rt.events.list({ kind: "agent.finish" })[0]?.payload;
    expect(finish).toMatchObject({ toolCalls: 6 });
  });

  it("stops the tool loop at the limit, maps outcomes and fails on undeclared ones", async () => {
    sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
    rt = await testRuntime(sb, { PATH: process.env.PATH ?? "" });
    const wf = workflowOf({
      name: "i",
      entry: "impact",
      steps: [
        {
          id: "impact",
          kind: "agentic",
          agent: "impact",
          outputs: ["impact"],
          transitions: {
            onSuccess: "DONE",
            onOutcome: { needs_research: { to: "research", maxIterations: 1 } },
          },
        },
        {
          id: "research",
          kind: "agentic",
          agent: "research",
          outputs: ["research"],
          transitions: { onSuccess: "impact" },
        },
      ],
    });
    const registry = new AgentRegistry(
      BUILTIN_AGENTS.map((a) =>
        a.id === "impact" ? { ...a, limits: { maxToolCalls: 2, maxModelCalls: 10, checkpointEvery: 10 } } : a,
      ),
    );
    const engine = new LocalWorkflowEngine({
      runtime: rt,
      workflows: new Map([[wf.name, wf]]),
      executors: {
        deterministic: new DeterministicExecutor(BUILTIN_TOOLS),
        agentic: new AgenticExecutor(new AgentRuntimeRunner(registry)),
      },
      leaseOptions: { heartbeatMs: 0 },
    });
    const impactDoc = (outcome: string) => ({
      summary: "s",
      affected: [{ path: "src/onboarding.ts", kind: "code", reason: "r" }],
      dependencies: [],
      risks: [],
      unknowns: ["billing"],
      sources: [],
      reasons: [{ kind: "unknown-area", summary: "billing module not researched", sourceRefs: [] }],
      outcome,
    });
    let calls = 0;
    server.respond((req, i) => {
      calls = i + 1;
      const system = (req.body.messages as Array<{ content: string }>)[0]?.content ?? "";
      if (system.includes("# Agent: impact")) {
        const tools = req.body.tools as unknown[] | undefined;
        if (tools) return toolCallCompletion("repo.list", {});
        const user = lastUserContent(req);
        if (
          user.includes("Produce the result document") ||
          user.includes("did not match the required schema")
        ) {
          const second =
            rt?.history.list(rt.runs.list()[0]?.id as string).filter((h) => h.stepId === "impact").length ===
            2;
          return completion(JSON.stringify(impactDoc(second ? "go_wild" : "needs_research")));
        }
        return completion("finishing");
      }
      if (lastUserContent(req).includes("Produce the result document"))
        return completion(JSON.stringify(RESEARCH_DOC));
      return completion("ok");
    });
    const run = createRun(rt, "i");
    const result = await engine.execute(run.id, { owner: "cli:t" });
    // impact#1: 2 tool calls → budget notice → finishes → needs_research → research#1 → impact#2 → outcome
    // outside the schema enum is rejected by validation and repair, then the step fails.
    expect(result.run.state).toBe("FAILED");
    expect(result.run.stateReason).toContain("structured output invalid");
    expect(rt.artifacts.listLatest(run.id, "invalid-output")).toHaveLength(1);
    expect(result.run.iterations).toEqual({ "impact->research#needs_research": 1 });
    const impact1 = rt.history.list(run.id).find((h) => h.stepId === "impact");
    expect(impact1).toMatchObject({ status: "success", outcome: "needs_research" });
    const budgetNotice = server.requests.find((r) =>
      lastUserContent(r).includes("tool budget for this step is used up"),
    );
    expect(budgetNotice).toBeDefined();
    expect(calls).toBeGreaterThan(5);
    const researchReq = server.requests.find((r) =>
      ((r.body.messages as Array<{ content: string }>)[0]?.content ?? "").includes("# Agent: research"),
    );
    expect(lastUserContent(researchReq as CapturedRequest)).toContain("billing module not researched");
  });

  it("marks a result cut short by a limit (agents.<id>.limits) and tells the next agent it is incomplete (pilot)", async () => {
    sb.write(
      "project/.jarvis/project.yaml",
      "version: 1\nworkspace: { mode: cwd }\nagents: { research: { limits: { maxToolCalls: 2 } } }\n",
    );
    rt = await testRuntime(sb, { PATH: process.env.PATH ?? "" });
    const wf = workflowOf({
      name: "rr",
      entry: "research",
      steps: [
        {
          id: "research",
          kind: "agentic",
          agent: "research",
          outputs: ["research"],
          transitions: { onSuccess: "requirements" },
        },
        {
          id: "requirements",
          kind: "agentic",
          agent: "requirements",
          inputs: ["research"],
          outputs: ["requirements"],
          transitions: { onSuccess: "DONE" },
        },
      ],
    });
    const engine = engineWith(rt, wf);
    server.respond((req) => {
      const system = (req.body.messages as Array<{ content: string }>)[0]?.content ?? "";
      if (system.includes("# Agent: research")) {
        // keeps exploring while it may, three calls an answer: only the limit stops it
        if (req.body.tools) {
          const reply = toolCallCompletion("repo.list", {});
          const message = (reply.body as { choices: Array<{ message: { tool_calls: unknown[] } }> })
            .choices[0]?.message;
          if (message)
            message.tool_calls = ["a", "b", "c"].map((id) => ({
              id: `call_${id}`,
              type: "function",
              function: { name: "repo.list", arguments: "{}" },
            }));
          return reply;
        }
        return completion(JSON.stringify(RESEARCH_DOC));
      }
      return completion("not a document");
    });
    const run = createRun(rt, "rr");
    await engine.execute(run.id, { owner: "cli:t" });

    const research = rt.artifacts.listLatest(run.id, "research")[0];
    expect(research?.provenance).toMatchObject({
      kind: "agent",
      agentId: "research",
      budgetExhausted: "tools",
    });
    const finish = rt.events
      .list({ runId: run.id })
      .find((e) => e.kind === "agent.finish" && e.stepId === "research");
    // two allowed, the third call of the same answer is skipped, not run (pilot: 41/40)
    expect(finish?.payload).toMatchObject({ toolCalls: 2, budgetExhausted: "tools" });
    expect(rt.events.list({ runId: run.id }).filter((e) => e.kind === "tool.call")).toHaveLength(2);
    expect(
      server.requests.some((r) =>
        JSON.stringify(r.body.messages).includes(
          "[repo.list] skipped: the tool budget for this step is used up",
        ),
      ),
    ).toBe(true);
    const start = rt.events.list({ runId: run.id }).find((e) => e.kind === "agent.start");
    expect(start?.payload).toMatchObject({ maxToolCalls: 2 });
    // the requirements agent reads research as incomplete
    const next = server.requests.find((r) =>
      ((r.body.messages as Array<{ content: string }>)[0]?.content ?? "").includes("# Agent: requirements"),
    );
    const text = JSON.stringify(next?.body.messages);
    expect(text).toMatch(
      /INCOMPLETE: agent research ran out of tool calls|incomplete: its agent ran out of budget/,
    );
  });

  it("a file read again unchanged gets a pointer to its text above, not the text (pilot: 62 reads)", async () => {
    sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
    rt = await testRuntime(sb, { PATH: process.env.PATH ?? "" });
    let turn = 0;
    server.respond((req) => {
      if (!req.body.tools) return completion(JSON.stringify(RESEARCH_DOC));
      turn += 1;
      return turn <= 2
        ? toolCallCompletion("repo.read", { path: "src/onboarding.ts" })
        : completion(JSON.stringify(RESEARCH_DOC));
    });
    const run = createRun(rt, "r");
    await engineWith(rt, researchOnly).execute(run.id, { owner: "cli:t" });
    const third = server.requests.filter((r) => r.body.tools)[2];
    const results = ((third?.body.messages ?? []) as Array<{ role: string; content: string }>).filter(
      (m) => m.role === "tool",
    );
    expect(results[0]?.content).toContain("canRestartOnboarding");
    expect(results[1]?.content).toContain("(unchanged:");
    expect(results[1]?.content).not.toContain("return false");
    expect(rt.events.list({ runId: run.id, kind: "tool.reread" })[0]?.payload).toMatchObject({
      path: "src/onboarding.ts",
      kind: "unchanged",
    });
  });

  it("the calls of one answer: reads side by side, a batch on the record, answers in the order asked", async () => {
    sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
    sb.write("project/src/billing.ts", "export const invoiceTotal = 1;\n");
    rt = await testRuntime(sb, { PATH: process.env.PATH ?? "" });
    let turn = 0;
    const calls = [
      ["repo.read", { path: "src/onboarding.ts" }],
      ["repo.search", { pattern: "invoiceTotal" }],
      ["repo.read", { path: "src/billing.ts" }],
    ] as const;
    server.respond((req) => {
      if (!req.body.tools) return completion(JSON.stringify(RESEARCH_DOC));
      turn += 1;
      if (turn > 1) return completion(JSON.stringify(RESEARCH_DOC));
      return {
        body: {
          id: "chatcmpl-3",
          model: "fake-model",
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: calls.map(([name, args], i) => ({
                  id: `call_${i}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                })),
              },
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 5 },
        },
      };
    });
    const run = createRun(rt, "r");
    await engineWith(rt, researchOnly).execute(run.id, { owner: "cli:t" });
    const batch = rt.events.list({ runId: run.id, kind: "tool.batch" });
    expect(batch).toHaveLength(1);
    expect(batch[0]?.payload).toMatchObject({ modelCall: 1, size: 3, parallel: true });
    expect(
      ((batch[0]?.payload?.calls ?? []) as Array<{ capability: string }>).map((c) => c.capability),
    ).toEqual(["repo.read", "repo.search", "repo.read"]);
    const recorded = rt.events.list({ runId: run.id, kind: "tool.call" }).map((e) => e.payload);
    expect(recorded.map((p) => [p?.batch, p?.slot]).sort()).toEqual([
      [1, 0],
      [1, 1],
      [1, 2],
    ]);
    // the model gets its answers in the order it asked, whatever order they finished in
    const second = server.requests.filter((r) => r.body.tools)[1];
    const answers = (
      (second?.body.messages ?? []) as Array<{ role: string; tool_call_id?: string; content: string }>
    )
      .filter((m) => m.role === "tool")
      .map((m) => m.tool_call_id);
    expect(answers).toEqual(["call_0", "call_1", "call_2"]);
  });

  it("in the pool's unlimited hours the agent's limits grow unlimitedScale times", async () => {
    const home = join(sb.root, "home", ".jarvis", "config.yaml");
    writeFileSync(
      home,
      `${readFileSync(home, "utf8").replace("    maxOutput: 2000\n", "    maxOutput: 2000\n    quotaPool: night\n")}quotaPools:\n  night:\n    window: { minutes: 20 }\n    unlimited: [{ days: [mon, tue, wed, thu, fri, sat, sun] }]\n    unlimitedScale: 3\n`,
    );
    sb.write(
      "project/.jarvis/project.yaml",
      "version: 1\nworkspace: { mode: cwd }\nagents: { research: { limits: { maxToolCalls: 2, maxModelCalls: 4 } } }\n",
    );
    rt = await testRuntime(sb, { PATH: process.env.PATH ?? "" });
    server.respond((req) =>
      req.body.tools ? toolCallCompletion("repo.list", {}) : completion(JSON.stringify(RESEARCH_DOC)),
    );
    const run = createRun(rt, "r");
    await engineWith(rt, researchOnly).execute(run.id, { owner: "cli:t" });
    const start = rt.events.list({ runId: run.id }).find((e) => e.kind === "agent.start");
    expect(start?.payload).toMatchObject({ maxToolCalls: 6, maxModelCalls: 12 });
    expect(rt.events.list({ runId: run.id }).filter((e) => e.kind === "tool.call")).toHaveLength(6);
  });

  it("onLimit: ask — the run waits at the limit with the conversation kept; more goes on, finish ends it", async () => {
    sb.write(
      "project/.jarvis/project.yaml",
      "version: 1\nworkspace: { mode: cwd }\nagents: { research: { limits: { maxToolCalls: 2 }, onLimit: ask } }\n",
    );
    rt = await testRuntime(sb, { PATH: process.env.PATH ?? "" });
    const wf = workflowOf({
      name: "ra",
      entry: "research",
      steps: [
        {
          id: "research",
          kind: "agentic",
          agent: "research",
          outputs: ["research"],
          transitions: { onSuccess: "DONE" },
        },
      ],
    });
    const engine = engineWith(rt, wf);
    // one tool call an answer, while tools are offered
    server.respond((req) =>
      req.body.tools ? toolCallCompletion("repo.list", {}) : completion(JSON.stringify(RESEARCH_DOC)),
    );
    const run = createRun(rt, "ra");
    const first = await engine.execute(run.id, { owner: "cli:t" });
    expect(first.run.state).toBe("WAITING_HUMAN");
    expect(first.run.waitingFor).toMatchObject({ kind: "budget", detail: "agent toolCalls" });
    const stop = budgetStopOf(rt, first.run);
    expect(stop).toMatchObject({
      scope: "agent",
      dimension: "toolCalls",
      used: 2,
      cap: 2,
      stepId: "research",
      agent: "research",
    });
    expect(rt.events.list({ runId: run.id, kind: "tool.call" })).toHaveLength(2);
    expect(rt.artifacts.listLatest(run.id, "research")).toHaveLength(0);

    // more: two calls on, from the same conversation — the first two are not run again
    grantBudget(rt, first.run, stop as BudgetStop, ACTOR, { more: 2 }, "cli");
    expect(budgetGranted(rt, run.id)).toMatchObject({ finish: false, amount: 2, channel: "cli" });
    const sentBefore = server.requests.length;
    const second = await engine.execute(run.id, { owner: "cli:t" });
    expect(second.run.state).toBe("WAITING_HUMAN");
    expect(budgetStopOf(rt, second.run)).toMatchObject({ used: 4, cap: 4 });
    expect(rt.events.list({ runId: run.id, kind: "tool.call" })).toHaveLength(4);
    const resumedWith = JSON.stringify(server.requests[sentBefore]?.body.messages);
    expect(resumedWith.match(/\[repo\.list\] ok/g)?.length).toBe(2);

    // finish: the result document from what it has, marked incomplete
    grantBudget(rt, second.run, budgetStopOf(rt, second.run) as BudgetStop, ACTOR, { finish: true }, "ui");
    const done = await engine.execute(run.id, { owner: "cli:t" });
    expect(done.run.state).toBe("COMPLETED");
    expect(rt.events.list({ runId: run.id, kind: "tool.call" })).toHaveLength(4);
    expect(rt.artifacts.listLatest(run.id, "research")[0]?.provenance).toMatchObject({
      budgetExhausted: "tools",
    });
  });

  it("onLimit: ask does not wait where nobody answers (interactive: false): it finishes as before", async () => {
    sb.write(
      "project/.jarvis/project.yaml",
      "version: 1\nworkspace: { mode: cwd }\nagents: { research: { limits: { maxToolCalls: 1 }, onLimit: ask } }\nprofiles: { ci: { interactive: false } }\n",
    );
    rt = await testRuntime(sb, { PATH: process.env.PATH ?? "", JARVIS_PROFILE: "ci" });
    const wf = workflowOf({
      name: "rb",
      entry: "research",
      steps: [
        {
          id: "research",
          kind: "agentic",
          agent: "research",
          outputs: ["research"],
          transitions: { onSuccess: "DONE" },
        },
      ],
    });
    server.respond((req) =>
      req.body.tools ? toolCallCompletion("repo.list", {}) : completion(JSON.stringify(RESEARCH_DOC)),
    );
    const run = createRun(rt, "rb");
    const result = await engineWith(rt, wf).execute(run.id, { owner: "cli:t" });
    expect(result.run.state).toBe("COMPLETED");
    expect(rt.artifacts.listLatest(run.id, "research")[0]?.provenance).toMatchObject({
      budgetExhausted: "tools",
    });
  });

  it("gives an agent sent back by a human its previous version and the review (pilot: a dead loop)", async () => {
    sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
    rt = await testRuntime(sb, { PATH: process.env.PATH ?? "" });
    const wf = workflowOf({
      name: "s",
      entry: "spec",
      steps: [
        {
          id: "spec",
          kind: "agentic",
          agent: "specification",
          outputs: ["spec"],
          transitions: { onSuccess: "approve" },
        },
        {
          id: "approve",
          kind: "approval",
          artifactType: "spec",
          transitions: {
            onSuccess: "DONE",
            onOutcome: { request_changes: { to: "spec", maxIterations: 3 } },
          },
        },
      ],
    });
    const engine = engineWith(rt, wf);
    const doc = (title: string, openQuestions: string[]) => ({
      summary: "Hide the delivery fields in compact mode.",
      title,
      goals: ["Hide them"],
      requirements: [{ id: "R1", text: "Hide", acceptance: ["not rendered"] }],
      openQuestions,
      outcome: "ok",
    });
    let round = 0;
    server.respond(() => {
      round += 1;
      return completion(
        JSON.stringify(round === 1 ? doc("First draft", ["Ever show them?"]) : doc("Second draft", [])),
      );
    });
    const run = createRun(rt, "s");
    const parked = await engine.execute(run.id, { owner: "cli:t" });
    expect(parked.run.state).toBe("WAITING_HUMAN");
    const v1 = rt.artifacts.listLatest(run.id, "spec")[0];
    rt.artifacts.approve({
      runId: run.id,
      stepId: "approve",
      artifactId: v1?.artifactId as string,
      version: 1,
      actor: ACTOR,
      decision: "request_changes",
      comment: "Answers to the open questions:\n1) Ever show them?\n   → never",
    });
    await engine.execute(run.id, { owner: "cli:t" });

    const first = JSON.stringify(server.requests[0]?.body.messages);
    expect(first).not.toContain("Human review");
    const second = JSON.stringify(server.requests.at(-1)?.body.messages);
    expect(second).toContain("# Human review of your previous version spec/spec.json@1 (binding)");
    expect(second).toContain("→ never");
    expect(second).toContain("## Your previous version spec/spec.json@1 (sent back)");
    expect(second).toContain("First draft");
    expect(second).toContain("never ask it again");
    expect(rt.artifacts.listLatest(run.id, "spec")[0]?.version).toBe(2);
  });

  it("gives the next agent the code earlier steps read, as it is now (pilot: the same file re-read by four agents)", async () => {
    sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
    rt = await testRuntime(sb, { PATH: process.env.PATH ?? "" });
    const wf = workflowOf({
      name: "rr2",
      entry: "research",
      steps: [
        {
          id: "research",
          kind: "agentic",
          agent: "research",
          outputs: ["research"],
          transitions: { onSuccess: "requirements" },
        },
        {
          id: "requirements",
          kind: "agentic",
          agent: "requirements",
          inputs: ["research"],
          outputs: ["requirements"],
          transitions: { onSuccess: "DONE" },
        },
      ],
    });
    const engine = engineWith(rt, wf);
    let readOnce = false;
    server.respond((req) => {
      const system = (req.body.messages as Array<{ content: string }>)[0]?.content ?? "";
      if (system.includes("# Agent: research")) {
        if (!readOnce) {
          readOnce = true;
          return toolCallCompletion("repo.read", { path: "src/onboarding.ts" });
        }
        return completion(JSON.stringify(RESEARCH_DOC));
      }
      return completion("not a document");
    });
    const run = createRun(rt, "rr2");
    await engine.execute(run.id, { owner: "cli:t" });
    const research = server.requests.find((r) =>
      ((r.body.messages as Array<{ content: string }>)[0]?.content ?? "").includes("# Agent: research"),
    );
    expect(JSON.stringify(research?.body.messages)).not.toContain("Code already read in this run");
    const next = server.requests.find((r) =>
      ((r.body.messages as Array<{ content: string }>)[0]?.content ?? "").includes("# Agent: requirements"),
    );
    const messages = (next?.body.messages ?? []) as Array<{ content: string }>;
    const text = messages[1]?.content ?? "";
    expect(text).toContain("## Code already read in this run (current content)");
    expect(text).toContain("### src/onboarding.ts (read 1 time by research)");
    expect(text).toContain("    1  export function canRestartOnboarding() {");
  });

  it("stores invalid structured output as an artifact and fails the step", async () => {
    sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
    rt = await testRuntime(sb, { PATH: process.env.PATH ?? "" });
    server.respond(() => completion("not json at all"));
    const engine = engineWith(rt, researchOnly);
    const run = createRun(rt, "r");
    const result = await engine.execute(run.id, { owner: "cli:t" });
    expect(result.run.state).toBe("FAILED");
    expect(result.run.stateReason).toContain("structured output invalid");
    expect(rt.artifacts.listLatest(run.id, "invalid-output")).toHaveLength(1);
  });
});
