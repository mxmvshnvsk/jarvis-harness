import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.ts";
import { logFiles, readLogs } from "../../src/telemetry/log.ts";
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
const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const logsDir = () => join(sb.home, ".jarvis", "logs");

function put(rel: string, content: string) {
  const path = join(sb.project, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function jarvis(args: string[], env: Record<string, string> = {}) {
  let out = "";
  let err = "";
  const code = await run(["node", "jarvis", ...args], {
    streams: {
      out: new Writable({
        write(c, _e, cb) {
          out += String(c);
          cb();
        },
      }),
      err: new Writable({
        write(c, _e, cb) {
          err += String(c);
          cb();
        },
      }),
    },
    context: {
      cwd: sb.project,
      homeDir: sb.home,
      env: { PATH: process.env.PATH ?? "", ...gitEnv, ...env },
    },
  });
  return { code, out, err };
}

beforeEach(async () => {
  sb = sandbox();
  server = await startFakeOpenAi();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: sb.project, env: { ...process.env, ...gitEnv } });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: sb.project,
    env: { ...process.env, ...gitEnv },
  });
  // JARVIS_HOME is not set: the home is <homeDir>/.jarvis
  mkdirSync(join(sb.home, ".jarvis"), { recursive: true });
  writeFileSync(
    join(sb.home, ".jarvis", "config.yaml"),
    `version: 1
actor: { id: me@corp }
models:
  flash:
    provider: openai-compatible
    baseUrl: ${server.baseUrl}
    model: flash
    egress: private
    contextWindow: 32000
    maxOutput: 4000
    supports: { tools: true, jsonMode: true }
roles:
  research: { models: [flash] }
`,
  );
  put(".jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\ntools:\n  local: { check: 'true' }\n");
  put(
    ".jarvis/knowledge/hooks.md",
    "# Hooks\n\n## Dependencies\n\nPass dependencies into hooks as arguments.\n",
  );
});
afterEach(async () => {
  await server.close();
  sb.cleanup();
});

function wantsResult(req: CapturedRequest): boolean {
  const messages = req.body.messages as Array<{ role: string; content: string | null }>;
  const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  return !req.body.tools && /Produce the result document|did not match/.test(last);
}
function toolCount(req: CapturedRequest): number {
  return ((req.body.messages as Array<{ role: string }>) ?? []).filter((m) => m.role === "tool").length;
}

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz123456";

function answering() {
  server.respond((req) => {
    if (wantsResult(req))
      return completion(
        JSON.stringify({
          summary: `Pass them as arguments (key ${SECRET})`,
          sources: [],
          reasons: [],
          found: true,
          answer: "Pass dependencies as arguments.",
          citations: [{ ref: "knowledge:hooks.md", quote: "Pass dependencies into hooks as arguments." }],
          gaps: [],
          outcome: "ok",
        }),
      );
    if (toolCount(req) === 0) return toolCallCompletion("knowledge.read", { ref: "knowledge:hooks.md" });
    return completion("done");
  });
}

const QUESTION = ["ask", "how", "are", "dependencies", "passed", "into", "hooks"];

describe("technical log", () => {
  it("at info mirrors the events and records the invocation, without bodies", async () => {
    answering();
    const r = await jarvis(QUESTION);
    expect(r.code).toBe(0);
    const records = readLogs(logsDir(), { level: "debug" });
    const events = records.map((x) => x.event);
    expect(events).toContain("cli.invoke");
    expect(events).toContain("cli.exit");
    expect(events).toContain("run.created");
    expect(events).toContain("model.call");
    expect(events).toContain("tool.call");
    expect(events).not.toContain("model.request");
    expect(events).not.toContain("tool.result");
    const invoke = records.find((x) => x.event === "cli.invoke");
    expect(invoke?.args).toEqual(QUESTION);
    expect(records.find((x) => x.event === "cli.exit")).toMatchObject({ code: 0 });
  });

  it("at debug keeps prompts as deltas, replies, and tool arguments and results — redacted", async () => {
    answering();
    const r = await jarvis(QUESTION, { JARVIS_LOG: "debug" });
    expect(r.code).toBe(0);
    const records = readLogs(logsDir(), { level: "debug" });

    const requests = records.filter((x) => x.event === "model.request");
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[0]).toMatchObject({ messagesFrom: 0, agentId: "knowledge-answerer" });
    expect(requests[0]?.messages as unknown[]).toHaveLength(Number(requests[0]?.messageCount));
    // the next call of the same step only adds what is new
    const next = requests[1];
    expect(Number(next?.messagesFrom)).toBeGreaterThan(0);
    expect(next?.messages as unknown[]).toHaveLength(Number(next?.messageCount) - Number(next?.messagesFrom));
    expect(JSON.stringify(requests[0]?.messages)).toContain(
      "Question: how are dependencies passed into hooks",
    );

    const responses = records.filter((x) => x.event === "model.response");
    expect(JSON.stringify(responses[0]?.toolCalls)).toContain("knowledge.read");

    const tool = records.find((x) => x.event === "tool.result");
    expect(tool).toMatchObject({ capability: "knowledge.read", ok: true });
    expect(String(tool?.text)).toContain("Pass dependencies into hooks as arguments.");
    expect(JSON.stringify(tool?.args)).toContain("knowledge:hooks.md");

    // the event itself now names the call
    const call = records.find((x) => x.event === "tool.call");
    expect(String((call?.payload as { args?: string } | undefined)?.args)).toContain("knowledge:hooks.md");

    // the secret in the model's reply never reaches the file
    const raw = logFiles(logsDir())
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain("[REDACTED");
    for (const line of raw.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("JARVIS_LOG=off writes nothing", async () => {
    answering();
    const r = await jarvis(QUESTION, { JARVIS_LOG: "off" });
    expect(r.code).toBe(0);
    expect(existsSync(logsDir())).toBe(false);
  });

  it("keeps the provider's message of a failed call, with the stack in the log", async () => {
    server.respond(() => ({
      status: 400,
      body: { error: { message: "context length exceeded: 40000 > 32000" } },
    }));
    const r = await jarvis(QUESTION);
    expect(r.code).toBe(0);
    const errors = readLogs(logsDir(), { level: "error" });
    const event = errors.find((x) => x.event === "model.error");
    expect(String((event?.payload as { message?: string } | undefined)?.message)).toContain(
      "context length exceeded",
    );
    expect((event?.payload as { status?: number } | undefined)?.status).toBe(400);
    const detail = errors.find((x) => x.event === "model.error.detail");
    expect(String(detail?.message)).toContain("context length exceeded");
    expect(String(detail?.stack)).toContain("ModelError");
  });
});

describe("jarvis logs", () => {
  it("shows a run's records, filters by level, event and age, and points at the directory", async () => {
    answering();
    await jarvis(QUESTION, { JARVIS_LOG: "debug" });
    const runId = readLogs(logsDir(), { level: "debug" }).find((x) => x.event === "run.created")
      ?.runId as string;
    expect(runId).toMatch(/^run_/);

    const all = await jarvis(["logs", runId.slice(0, 12), "--tail", "200"]);
    expect(all.code).toBe(0);
    expect(all.out).toContain("run.created");
    expect(all.out).toContain("model.call");
    expect(all.out).not.toContain("model.request");

    const debug = await jarvis(["logs", runId, "--level", "debug", "--event", "tool.result"]);
    expect(debug.out).toContain("tool.result");
    expect(debug.out).toContain("knowledge.read");

    const json = await jarvis(["--json", "logs", runId, "--level", "debug", "--event", "model.request"]);
    const doc = JSON.parse(json.out) as { records: Array<{ event: string }> };
    expect(doc.records.every((x) => x.event === "model.request")).toBe(true);

    const none = await jarvis(["logs", runId, "--level", "error"]);
    expect(none.out).toContain("no records match");
    expect(none.out).toContain("JARVIS_LOG=debug");

    const recent = await jarvis(["logs", "--since", "1h", "--tail", "5"]);
    expect(recent.out.trim().split("\n").length).toBeLessThanOrEqual(5);

    const where = await jarvis(["logs", "--path"]);
    expect(where.out.trim()).toBe(logsDir());
  });

  it("rejects an unknown level and an unreadable age, and says when there is nothing yet", async () => {
    expect((await jarvis(["logs", "--level", "loud"])).code).not.toBe(0);
    expect((await jarvis(["logs", "--since", "yesterday"])).code).not.toBe(0);
    // a home that has never logged
    sb.cleanup();
    sb = sandbox();
    const fresh = await jarvis(["logs"], { JARVIS_LOG: "off" });
    expect(fresh.code).toBe(0);
    expect(fresh.out).toContain("no log files");
  });

  it("is mentioned by doctor", async () => {
    const r = await jarvis(["--json", "doctor"]);
    const doc = JSON.parse(r.out) as { checks: Array<{ id: string; detail: string }> };
    expect(doc.checks.find((c) => c.id === "logs")?.detail).toContain("level info");
    const off = await jarvis(["--json", "doctor"], { JARVIS_LOG: "off" });
    const status = (JSON.parse(off.out) as { checks: Array<{ id: string; status: string }> }).checks.find(
      (c) => c.id === "logs",
    )?.status;
    expect(status).toBe("warn");
  });
});
