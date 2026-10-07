import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../../src/app/engine.ts";
import { createRuntime, type Runtime } from "../../src/app/runtime.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { startUiServer, type UiServer } from "../../src/ui/server.ts";
import {
  type CapturedRequest,
  completion,
  type FakeOpenAi,
  startFakeOpenAi,
  toolCallCompletion,
} from "../helpers/fakeOpenAi.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** Knowledge → Ask: `jarvis ask` in the page — the search at once, the answer as a run, its excerpts checked. */
let sb: Sandbox;
let rt: Runtime;
let ui: UiServer;
let server: FakeOpenAi;
const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

beforeEach(async () => {
  sb = sandbox();
  server = await startFakeOpenAi();
  sb.write(
    "home/.jarvis/config.yaml",
    `version: 1
actor: { id: dev@example.com }
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
  sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
  sb.write(
    "project/.jarvis/knowledge/delivery.md",
    "# Delivery\n\nThe delivery date on the order card comes from logistics-api through the BFF route logistics.dates.\n",
  );
  sb.write(
    "project/.jarvis/knowledge/glossary.md",
    "| термин | синонимы | символы/модули | источники | обновлено | определение |\n| --- | --- | --- | --- | --- | --- |\n| доставка | delivery | `deliveryDate` | delivery.md | 2026-10-01 | Доставка карты клиенту |\n",
  );
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: sb.project, env: { ...process.env, ...gitEnv } });
  execFileSync("git", ["add", "-A"], { cwd: sb.project });
  execFileSync("git", ["commit", "-q", "-m", "init"], {
    cwd: sb.project,
    env: { ...process.env, ...gitEnv },
  });
  const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
  rt = createRuntime(loaded, { env: {} });
  ui = await startUiServer({
    runtime: rt,
    engine: createEngine(rt),
    port: 0,
    homeDir: sb.home,
    projectRoot: sb.project,
    pollMs: 30,
    mcpCheckEveryMs: 0,
    actor: async () => ({ kind: "user" as const, id: "dev@example.com", verified: false }),
  });
});
afterEach(async () => {
  await ui.close();
  await rt.close();
  await server.close();
  sb.cleanup();
});

const cookie = () => `jarvis_ui_${ui.port}=${encodeURIComponent(ui.token)}`;
const page = async (path: string) =>
  (await fetch(`http://127.0.0.1:${ui.port}${path}`, { headers: { cookie: cookie() } })).text();
function post(path: string, fields: Array<[string, string]>): Promise<{ status: number; location?: string }> {
  const body = new URLSearchParams([["t", ui.token], ...fields]).toString();
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: ui.port,
        path,
        method: "POST",
        headers: {
          host: `127.0.0.1:${ui.port}`,
          origin: `http://127.0.0.1:${ui.port}`,
          cookie: cookie(),
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            ...(res.headers.location ? { location: res.headers.location } : {}),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const wantsResult = (req: CapturedRequest) => !req.body.tools;
const tools = (req: CapturedRequest) =>
  ((req.body.messages as Array<{ role: string }>) ?? []).filter((m) => m.role === "tool").length;

describe("Knowledge → Ask", () => {
  it("sources only: the search at once, no model, no run; the glossary's terms of the question", async () => {
    const r = await post("/knowledge/ask", [
      ["q", "доставка delivery date"],
      ["mode", "sources"],
    ]);
    expect(r.location).toBe(`/knowledge/ask?q=${encodeURIComponent("доставка delivery date")}&mode=sources`);
    const body = await page(r.location as string);
    expect(body).toContain('aria-current="page">Ask</a>');
    expect(body).toMatch(/Found · \d/);
    expect(body).toContain("delivery.md");
    expect(body).toContain("<b>доставка</b> — Доставка карты клиенту");
    expect(server.requests).toHaveLength(0);
    expect(rt.runs.list({ includeTerminal: true }).filter((x) => x.workflow === "ask")).toHaveLength(0);
  });

  it("nothing in the knowledge and no general knowledge asked for: no model, the search says so", async () => {
    const r = await post("/knowledge/ask", [
      ["q", "zzqx unknown thing"],
      ["mode", "answer"],
    ]);
    expect(r.location).toContain("mode=sources");
    expect(await page(r.location as string)).toContain("Nothing in the knowledge for «zzqx unknown thing»");
    expect(server.requests).toHaveLength(0);
  });

  it("an answer: a run of its own, followed on the page; excerpts checked, the unconfirmed one named", async () => {
    server.respond((req) => {
      if (wantsResult(req))
        return completion(
          JSON.stringify({
            summary: "s",
            sources: [],
            reasons: [],
            outcome: "ok",
            found: true,
            answer: "Дата доставки приходит из **logistics-api** через ручку BFF.",
            citations: [
              {
                ref: "knowledge:delivery.md",
                quote: "comes from logistics-api through the BFF route logistics.dates",
              },
              { ref: "knowledge:delivery.md", quote: "is recalculated on every address change" },
            ],
            gaps: ["Пересчитывается ли дата при смене адреса"],
          }),
        );
      return tools(req) === 0
        ? toolCallCompletion("knowledge.read", { ref: "knowledge:delivery.md" })
        : completion("DONE");
    });
    const r = await post("/knowledge/ask", [
      ["q", "where does the delivery date come from"],
      ["mode", "answer"],
    ]);
    expect(r.location).toMatch(/^\/knowledge\/ask\?run=[0-9a-f]{8}$/);
    const run = rt.runs.list({ includeTerminal: true }).find((x) => x.workflow === "ask");
    expect(run).toBeDefined();
    for (let i = 0; i < 200 && rt.runs.require(run?.id as string).state !== "COMPLETED"; i++)
      await new Promise((res) => setTimeout(res, 25));
    const body = await page(r.location as string);
    expect(body).toContain("«where does the delivery date come from» · run");
    expect(body).toContain("<strong>logistics-api</strong>");
    expect(body).toContain("<q>comes from logistics-api through the BFF route logistics.dates</q>");
    expect(body).toContain("✓ 1 excerpt found in their sources");
    expect(body).toContain("1 not in the source: knowledge:delivery.md");
    expect(body).toContain("<li>Пересчитывается ли дата при смене адреса</li>");
    expect(body).toContain('<span class="pill ok">cited</span>');
    expect(body).toContain("general knowledge: not allowed");
    // in the list of questions, and in Runs as any run
    expect(body).toMatch(
      /aria-current="page">where does the delivery date come from<span>today \d\d:\d\d · answered · 1 source<\/span>/,
    );
    expect(await page("/?repo=")).toContain("ask");
  });
});
