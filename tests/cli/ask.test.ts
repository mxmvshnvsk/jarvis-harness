import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.ts";
import { matchTerms, parseGlossary } from "../../src/knowledge/retrieval/glossary.ts";
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

function put(rel: string, content: string) {
  const path = join(sb.project, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function jarvis(args: string[]) {
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
    context: { cwd: sb.project, homeDir: sb.home, env: { PATH: process.env.PATH ?? "", ...gitEnv } },
  });
  return { code, out, err };
}

const HOOKS_DOC = `# React hooks

## Dependencies

Dependencies are passed into hooks through the arguments, never read from module state.
A hook that needs a service takes it as a parameter so tests can substitute it.

## Effects

Effects list every value they read in the dependency array.
`;

beforeEach(async () => {
  sb = sandbox();
  server = await startFakeOpenAi();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: sb.project, env: { ...process.env, ...gitEnv } });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: sb.project,
    env: { ...process.env, ...gitEnv },
  });
  sb.write(
    "home/.jarvis/config.yaml",
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
  put(".jarvis/knowledge/hooks.md", HOOKS_DOC);
  put(
    ".jarvis/knowledge/glossary.md",
    `| термин | синонимы | символы/модули | источники | обновлено | определение |
|---|---|---|---|---|---|
| RTL | React Testing Library | render, screen | hooks.md | 2026-10-01 | Библиотека тестов компонентов через DOM |
| заявка | application | Application | | | |
`,
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
function answerer(doc: unknown) {
  server.respond((req) => {
    if (wantsResult(req)) return completion(JSON.stringify(doc));
    if (toolCount(req) === 0) return toolCallCompletion("knowledge.read", { ref: "knowledge:hooks.md" });
    return completion("done");
  });
}

const base = { summary: "s", sources: [], reasons: [] as unknown[], outcome: "ok" };

describe("glossary", () => {
  it("reads the optional definition column and matches whole words only", () => {
    const entries = parseGlossary(
      "| термин | синонимы | символы | источники | обновлено | определение |\n|---|---|---|---|---|---|\n| RTL | React Testing Library | render | | | Тесты через DOM |\n| заявка | application | | | | |\n",
    );
    expect(entries[0]).toMatchObject({ term: "RTL", definition: "Тесты через DOM" });
    expect(entries[1]?.definition).toBeUndefined();
    expect(matchTerms("what is RTL?", entries).map((e) => e.term)).toEqual(["RTL"]);
    expect(matchTerms("a PARTLY unrelated sentence", entries)).toEqual([]);
    expect(matchTerms("про React Testing Library", entries).map((e) => e.term)).toEqual(["RTL"]);
    expect(matchTerms("что с заявкой", entries)).toEqual([]);
  });
});

describe("jarvis ask", () => {
  it("decodes a glossary term without calling a model", async () => {
    const r = await jarvis(["ask", "RTL"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("RTL — Библиотека тестов компонентов через DOM");
    expect(r.out).toContain("also: React Testing Library");
    expect(r.out).toContain("in code: render, screen");
    expect(server.requests.length).toBe(0);
  });

  it("answers from the knowledge base and shows only confirmed citations", async () => {
    answerer({
      ...base,
      found: true,
      answer: "Pass dependencies as hook arguments; do not read them from module state.",
      citations: [
        { ref: "knowledge:hooks.md", quote: "Dependencies are passed into hooks through the arguments" },
        { ref: "knowledge:hooks.md", quote: "this sentence is not in the document" },
      ],
      gaps: ["nothing about context providers"],
    });
    const r = await jarvis(["--json", "ask", "how", "are", "dependencies", "passed", "into", "hooks"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(doc.found).toBe(true);
    expect(doc.answer).toContain("hook arguments");
    expect(doc.citations).toHaveLength(1);
    expect(doc.rejectedCitations).toHaveLength(1);
    expect(doc.gaps).toEqual(["nothing about context providers"]);
    expect(doc.sources.map((s: { ref: string }) => s.ref)).toContain("knowledge:hooks.md");

    const human = await jarvis(["ask", "how are dependencies passed into hooks"]);
    expect(human.out).toContain("Answer (from the knowledge base)");
    expect(human.out).toContain(
      'knowledge:hooks.md — "Dependencies are passed into hooks through the arguments"',
    );
  });

  it("discards an answer whose citations are not in the sources", async () => {
    answerer({
      ...base,
      found: true,
      answer: "Use a global store for everything.",
      citations: [{ ref: "knowledge:hooks.md", quote: "always use a global store" }],
      gaps: [],
    });
    const r = await jarvis(["--json", "ask", "how are dependencies passed into hooks"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(doc.found).toBe(false);
    expect(doc.answer).toBe("");
    const human = await jarvis(["ask", "how are dependencies passed into hooks"]);
    expect(human.out).toContain("no confirmed answer");
    expect(human.out).not.toContain("global store");
    expect(human.out).toContain("Closest sources");
  });

  it("does not call the model when the base has nothing, unless --general", async () => {
    const r = await jarvis(["ask", "kubernetes ingress annotations"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Nothing in the knowledge base");
    expect(server.requests.length).toBe(0);

    answerer({
      ...base,
      found: false,
      answer: "",
      citations: [],
      gaps: ["not covered"],
      general: "Ingress annotations configure the controller.",
    });
    const g = await jarvis(["ask", "--general", "kubernetes ingress annotations"]);
    expect(g.code).toBe(0);
    expect(server.requests.length).toBeGreaterThan(0);
    expect(g.out).toContain("NOT from the knowledge base");
    expect(g.out).toContain("Ingress annotations configure the controller.");
    expect(g.out).not.toContain("Answer (from the knowledge base)");
  });

  it("--no-llm lists the closest sources", async () => {
    const r = await jarvis(["ask", "--no-llm", "how are dependencies passed into hooks"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Closest sources");
    expect(r.out).toContain("knowledge:hooks.md");
    expect(server.requests.length).toBe(0);
  });

  it("falls back to sources when the model is not available", async () => {
    sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
    const r = await jarvis(["ask", "how are dependencies passed into hooks"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("model unavailable");
    expect(r.out).toContain("Closest sources");
  });

  it("needs a question", async () => {
    const r = await jarvis(["ask", " "]);
    expect(r.code).not.toBe(0);
  });
});
