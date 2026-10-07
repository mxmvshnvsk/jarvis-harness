import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_AGENTS } from "../../src/agents/builtin/index.ts";
import { AgentRegistry } from "../../src/agents/definition.ts";
import { AgentRuntimeRunner } from "../../src/agents/runner.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import {
  compactTranscript,
  DEFAULT_THRESHOLDS,
  effectiveWindow,
  isSourceResult,
  levelOf,
  resolveThresholds,
  splitBlocks,
  TRIMMED_MARKER,
  trimToolResults,
} from "../../src/context/index.ts";
import type { Message } from "../../src/models/types.ts";
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

describe("pressure (ADR-0013 §1–2)", () => {
  it("subtracts the output reserve and a safety margin from the window, honouring maxContext", () => {
    expect(effectiveWindow({ contextWindow: 128_000, maxOutput: 8_000 })).toBe(113_600);
    expect(effectiveWindow({ contextWindow: 128_000, maxOutput: 8_000, maxContext: 64_000 })).toBe(52_800);
    expect(effectiveWindow({ contextWindow: 128_000, maxOutput: 8_000, roleMaxOutput: 2_000 })).toBe(119_600);
    expect(effectiveWindow({ contextWindow: 1000, maxOutput: 900 })).toBe(1024);
  });

  it("resolves thresholds byPhase over byModel over default and keeps the ladder ordered", () => {
    const cfg = {
      thresholds: {
        default: { compact: 0.5 },
        byModel: { qwen: { compact: 0.55, reset: 0.9 } },
        byPhase: { implementation: { compact: 0.45 }, research: { watch: 0.7 } },
      },
      compactTarget: 0.35,
    };
    expect(resolveThresholds(undefined, "x")).toEqual(DEFAULT_THRESHOLDS);
    expect(resolveThresholds(cfg, "other")).toEqual({ ...DEFAULT_THRESHOLDS, compact: 0.5 });
    expect(resolveThresholds(cfg, "qwen")).toEqual({
      watch: 0.4,
      compact: 0.55,
      aggressive: 0.75,
      reset: 0.9,
    });
    expect(resolveThresholds(cfg, "qwen", "implementation").compact).toBe(0.45);
    // a raised watch must not invert the ladder
    expect(resolveThresholds(cfg, "qwen", "research")).toEqual({
      watch: 0.7,
      compact: 0.7,
      aggressive: 0.75,
      reset: 0.9,
    });
    expect(levelOf(0.39, DEFAULT_THRESHOLDS)).toBe("healthy");
    expect(levelOf(0.4, DEFAULT_THRESHOLDS)).toBe("watch");
    expect(levelOf(0.6, DEFAULT_THRESHOLDS)).toBe("compact");
    expect(levelOf(0.75, DEFAULT_THRESHOLDS)).toBe("aggressive");
    expect(levelOf(0.9, DEFAULT_THRESHOLDS)).toBe("reset");
  });
});

function block(i: number, size = 2000): Message[] {
  return [
    {
      role: "assistant",
      content: `step ${i}`,
      toolCalls: [{ id: `c${i}`, name: "repo.read", arguments: `{"path":"f${i}.ts"}` }],
    },
    { role: "tool", toolCallId: `c${i}`, content: `[repo.read] ok\n${"x".repeat(size)}` },
  ];
}

describe("transcript trimming and compaction", () => {
  it("keeps tool calls and results together as blocks", () => {
    const blocks = splitBlocks([...block(1), ...block(2), { role: "user", content: "note" }]);
    expect(blocks.map((b) => b.length)).toEqual([2, 2, 1]);
  });

  it("trims old tool results to a head and a blob pointer, leaves recent ones, and is idempotent", () => {
    const stored: string[] = [];
    const store = (text: string) => {
      stored.push(text);
      return `ref${stored.length}`;
    };
    const transcript = [...block(1), ...block(2), ...block(3)];
    const r = trimToolResults(transcript, { keepRecent: 1, store });
    expect(r.trimmed).toBe(2);
    expect(stored).toHaveLength(2);
    const tools = r.transcript.filter((m) => m.role === "tool");
    expect(tools[0]?.content).toContain("[repo.read] ok");
    expect(tools[0]?.content).toContain(`${TRIMMED_MARKER} `);
    expect(tools[0]?.content).toContain("original: blob:ref1");
    expect(tools[0]?.content.length).toBeLessThan(500);
    expect(tools[2]?.content).toContain("x".repeat(2000)); // the newest is untouched
    expect(r.savedChars).toBeGreaterThan(3000);
    expect(trimToolResults(r.transcript, { keepRecent: 1, store }).trimmed).toBe(0);
  });

  it("leaves the task's own sources — the issue, its pages, its frames — when asked to (light pressure)", () => {
    const store = () => "ref";
    const tool = (text: string, id: string): Message[] => [
      { role: "assistant", content: "", toolCalls: [{ id, name: "x", arguments: "{}" }] },
      { role: "tool", toolCallId: id, content: text },
    ];
    const big = "y".repeat(2000);
    const transcript = [
      ...tool(`[jira.get] ok\n${big}`, "a"),
      ...tool(`[confluence.get] ok\n${big}`, "b"),
      ...tool(`[knowledge.read] ok\n[figma.get] ok\n${big}`, "c"),
      ...tool(`[repo.read] ok\n${big}`, "d"),
      ...tool(`[repo.read] ok\n${big}`, "e"),
    ];
    expect(isSourceResult("[confluence.get] ok\n…")).toBe(true);
    expect(isSourceResult("[repo.read] ok\n…")).toBe(false);
    const kept = trimToolResults(transcript, { keepRecent: 1, store, keep: isSourceResult });
    expect(kept.trimmed).toBe(1); // only the older repo.read
    const contents = kept.transcript
      .filter((m) => m.role === "tool")
      .map((m) => m.content.includes(TRIMMED_MARKER));
    expect(contents).toEqual([false, false, false, true, false]);
    // under heavy pressure they go too
    expect(trimToolResults(transcript, { keepRecent: 1, store }).trimmed).toBe(4);
  });

  it("compacts older blocks into one handoff, keeps the tail verbatim and the originals referenced", async () => {
    const stored: string[] = [];
    const summaries: Array<{ rendered: string; previous?: string }> = [];
    const options = {
      keepBlocks: 1,
      kind: "compact" as const,
      estimate: (ms: readonly Message[]) => ms.reduce((n, m) => n + m.content.length / 4, 0),
      store: (json: string) => {
        stored.push(json);
        return `orig${stored.length}`;
      },
      summarize: async (rendered: string, previous?: string) => {
        summaries.push({ rendered, ...(previous ? { previous } : {}) });
        return "## Goal\n- keep going";
      },
    };
    const first = await compactTranscript([...block(1), ...block(2), ...block(3)], options);
    expect(first?.compactedBlocks).toBe(2);
    expect(first?.transcript).toHaveLength(3); // handoff + the last block (2 messages)
    expect(first?.transcript[0]?.role).toBe("user");
    expect(first?.transcript[0]?.content).toContain("## Context handoff (compacted)");
    expect(first?.transcript[0]?.content).toContain("Originals: blob:orig1");
    expect(first?.transcript[1]?.content).toBe("step 3");
    expect(JSON.parse(stored[0] as string)).toHaveLength(4);
    expect(summaries[0]?.rendered).toContain("→ repo.read");
    expect(summaries[0]?.rendered).toContain("[515 more chars]"); // long results shortened for the summarizer only

    // a second compaction carries the earlier handoff and its references forward
    const second = await compactTranscript([...(first?.transcript ?? []), ...block(4), ...block(5)], options);
    expect(second?.transcript[0]?.content).toContain("Originals: blob:orig1, blob:orig2");
    expect(summaries[1]?.previous).toContain("## Context handoff");
    expect(summaries[1]?.rendered).not.toContain("## Context handoff");

    // nothing older than the kept tail → nothing to do
    expect(await compactTranscript(block(1), options)).toBeUndefined();
    // a reset keeps nothing
    const reset = await compactTranscript([...block(1), ...block(2)], {
      ...options,
      keepBlocks: 0,
      kind: "reset",
    });
    expect(reset?.transcript).toHaveLength(1);
    expect(reset?.transcript[0]?.content).toContain("(reset)");
  });
});

/* ------------------------------------------------------------------------------------------------
 * The agent loop under pressure
 * ---------------------------------------------------------------------------------------------- */

let sb: Sandbox;
let server: FakeOpenAi;
let rt: Runtime | undefined;
const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

const RESEARCH_DOC = {
  summary: "done",
  findings: [{ topic: "restart", detail: "returns false", sources: ["src/big.ts:1"] }],
  affectedAreas: ["src/big.ts"],
  existingImplementations: [],
  unknowns: [],
  sources: ["src/big.ts"],
  reasons: [],
  outcome: "ok",
};

beforeEach(async () => {
  sb = sandbox();
  server = await startFakeOpenAi();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: sb.project, env: { ...process.env, ...gitEnv } });
  mkdirSync(join(sb.project, "src"), { recursive: true });
  writeFileSync(
    join(sb.project, "src", "big.ts"),
    Array.from({ length: 400 }, (_, i) => `export const value${i} = ${i}; // line ${i}`).join("\n"),
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

function configure(thresholds: string, extraRoles = "") {
  sb.write(
    "home/.jarvis/config.yaml",
    `version: 1
models:
  flash:
    provider: openai-compatible
    baseUrl: ${server.baseUrl}
    model: flash
    egress: private
    contextWindow: 16000
    maxOutput: 1000
    supports: { tools: true, jsonMode: true }
roles:
  research: { models: [flash] }
${extraRoles}`,
  );
  sb.write(
    "project/.jarvis/project.yaml",
    `version: 1\nworkspace: { mode: cwd }\ncontext:\n  thresholds:\n    default: ${thresholds}\n`,
  );
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

async function runResearch(): Promise<Runtime> {
  rt = await testRuntime(sb, { PATH: process.env.PATH ?? "" });
  const registry = new AgentRegistry(BUILTIN_AGENTS, rt.loaded.project?.root);
  const engine = new LocalWorkflowEngine({
    runtime: rt,
    workflows: new Map([[researchOnly.name, researchOnly]]),
    executors: {
      deterministic: new DeterministicExecutor(BUILTIN_TOOLS),
      agentic: new AgenticExecutor(new AgentRuntimeRunner(registry)),
    },
    leaseOptions: { heartbeatMs: 0 },
  });
  const run = rt.runs.create({
    task: "ABC-1",
    workflow: "r",
    owner: ACTOR,
    workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
    dataClass: "confidential",
  });
  const result = await engine.execute(run.id, { owner: "cli:t" });
  expect(result.run.state).toBe("COMPLETED");
  return rt;
}

const isSummarizer = (req: CapturedRequest) =>
  ((req.body.messages as Array<{ content: string }>)[0]?.content ?? "").startsWith("You compress");

/** A transcript sent to the model must never contain a tool message without its assistant tool call. */
function assertWellFormed(req: CapturedRequest) {
  const messages = req.body.messages as Array<{
    role: string;
    tool_calls?: Array<{ id: string }>;
    tool_call_id?: string;
  }>;
  const open = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant") for (const c of m.tool_calls ?? []) open.add(c.id);
    if (m.role === "tool") expect(open.has(m.tool_call_id as string)).toBe(true);
  }
}

describe("AgentRuntimeRunner under context pressure", () => {
  it("trims, compacts through the compaction role and keeps working from the handoff", async () => {
    configure(
      "{ watch: 0.2, compact: 0.4, aggressive: 0.9, reset: 0.95 }",
      "  compaction: { models: [flash] }\n",
    );
    let n = 0;
    server.respond((req) => {
      if (isSummarizer(req)) return completion("## Goal\n- read src/big.ts\n## Sources\n- src/big.ts:1-400");
      n += 1;
      if (n <= 4) return toolCallCompletion("repo.read", { path: "src/big.ts", startLine: n, endLine: 400 });
      if (n === 5) return completion("enough");
      return completion(JSON.stringify(RESEARCH_DOC));
    });
    const runtime = await runResearch();

    const summarizerCalls = server.requests.filter(isSummarizer);
    expect(summarizerCalls.length).toBeGreaterThanOrEqual(1);
    for (const req of server.requests) assertWellFormed(req);

    const trimmed = runtime.events.list({ kind: "context.trimmed" });
    const compacted = runtime.events.list({ kind: "context.compacted" });
    expect(trimmed).toHaveLength(0); // too few tool results to trim — compaction does the work
    expect(compacted.length).toBeGreaterThanOrEqual(1);
    const payload = compacted[0]?.payload as { before: number; after: number; originals: string[] };
    expect(payload.after).toBeLessThan(payload.before);

    // after compaction the agent sees the handoff, and the original is still readable by ref
    const later = server.requests.filter((r) => !isSummarizer(r)).at(-1) as CapturedRequest;
    const texts = (later.body.messages as Array<{ content: string | null }>).map((m) => m.content ?? "");
    expect(texts.some((t) => t.startsWith("## Context handoff (compacted)"))).toBe(true);
    const original = payload.originals[0] as string;
    expect(runtime.blobs.has(original)).toBe(true);
    expect(runtime.blobs.getText(original)).toContain("repo.read");

    const finish = runtime.events.list({ kind: "agent.finish" })[0]?.payload as {
      context: { compactions: number; trims: number; peakPressure: number };
    };
    expect(finish.context.compactions).toBeGreaterThanOrEqual(1);
    expect(finish.context.peakPressure).toBeGreaterThan(0.2);
    expect(
      runtime.artifacts.find(
        runtime.runs.list({ includeTerminal: true })[0]?.id as string,
        "research",
        "research.json",
      ),
    ).toBeDefined();
  });

  it("falls back to the agent's model when no compaction role is configured, and resets at the top level", async () => {
    configure("{ watch: 0.1, compact: 0.15, aggressive: 0.2, reset: 0.25 }");
    let n = 0;
    server.respond((req) => {
      if (isSummarizer(req)) return completion("## Goal\n- handoff");
      n += 1;
      if (n <= 4) return toolCallCompletion("repo.read", { path: "src/big.ts", startLine: n, endLine: 400 });
      return completion(n === 5 ? "ok" : JSON.stringify(RESEARCH_DOC));
    });
    const runtime = await runResearch();
    expect(runtime.events.list({ kind: "context.reset" }).length).toBeGreaterThanOrEqual(1);
    expect(runtime.events.list({ kind: "context.tightened" }).length).toBe(1);
    for (const req of server.requests) assertWellFormed(req);
  });

  it("only trims old tool results at the watch level and leaves the recent ones", async () => {
    configure("{ watch: 0.1, compact: 0.9, aggressive: 0.95, reset: 0.99 }");
    let n = 0;
    server.respond((req) => {
      if (isSummarizer(req)) return completion("unused");
      n += 1;
      if (n <= 9)
        return toolCallCompletion("repo.read", {
          path: "src/big.ts",
          startLine: n * 40,
          endLine: n * 40 + 39,
        });
      return completion(n === 10 ? "ok" : JSON.stringify(RESEARCH_DOC));
    });
    const runtime = await runResearch();
    expect(runtime.events.list({ kind: "context.trimmed" }).length).toBeGreaterThanOrEqual(1);
    expect(runtime.events.list({ kind: "context.compacted" })).toHaveLength(0);
    expect(server.requests.filter(isSummarizer)).toHaveLength(0);
    const last = server.requests.at(-2) as CapturedRequest;
    const tools = (last.body.messages as Array<{ role: string; content: string }>).filter(
      (m) => m.role === "tool",
    );
    expect(tools[0]?.content).toContain("[trimmed:");
    expect(tools.at(-1)?.content).not.toContain("[trimmed:");
    // the original of a trimmed result is a blob the agent can read back
    const ref = /original: blob:(\S+) /.exec(tools[0]?.content ?? "")?.[1] as string;
    expect(runtime.blobs.getText(ref)).toContain("[repo.read] ok");
  });

  it("does nothing while the prompt is healthy", async () => {
    configure("{ watch: 0.9, compact: 0.92, aggressive: 0.95, reset: 0.98 }");
    server.respond((_req, i) =>
      i === 0
        ? toolCallCompletion("repo.read", { path: "src/big.ts", startLine: 1, endLine: 5 })
        : i === 1
          ? completion("ok")
          : completion(JSON.stringify(RESEARCH_DOC)),
    );
    const runtime = await runResearch();
    expect(runtime.events.list({ kind: "context.pressure" })).toHaveLength(0);
    expect(server.requests.filter(isSummarizer)).toHaveLength(0);
  });

  it("survives a summarizer that fails by trimming harder instead of stalling", async () => {
    configure("{ watch: 0.1, compact: 0.2, aggressive: 0.9, reset: 0.95 }");
    let n = 0;
    server.respond((req) => {
      if (isSummarizer(req)) return { status: 400, body: { error: { message: "bad request" } } };
      n += 1;
      if (n <= 4) return toolCallCompletion("repo.read", { path: "src/big.ts", startLine: n, endLine: 400 });
      return completion(n === 5 ? "ok" : JSON.stringify(RESEARCH_DOC));
    });
    const runtime = await runResearch();
    expect(runtime.events.list({ kind: "context.compaction_failed" }).length).toBeGreaterThanOrEqual(1);
    for (const req of server.requests) assertWellFormed(req);
  });
});
