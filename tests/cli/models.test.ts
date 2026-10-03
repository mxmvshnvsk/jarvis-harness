import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.ts";
import { completion, type FakeOpenAi, startFakeOpenAi, toolCallCompletion } from "../helpers/fakeOpenAi.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let server: FakeOpenAi;

beforeEach(async () => {
  sb = sandbox();
  server = await startFakeOpenAi();
  sb.write(
    "home/.jarvis/config.yaml",
    `version: 1
quotaPools:
  corp: { window: { minutes: 20 }, limits: { outputTokens: 1000, requests: 50 } }
models:
  flash:
    provider: openai-compatible
    baseUrl: ${server.baseUrl}
    model: flash-1
    auth: { type: bearer, token: env:TOK }
    egress: private
    quotaPool: corp
    contextWindow: 128000
    maxOutput: 8192
    supports: { tools: true, jsonMode: true, jsonSchema: true }
  cloud:
    provider: openai
    baseUrl: ${server.baseUrl}
    model: cloud-1
    egress: cloud
    contextWindow: 200000
    maxOutput: 4096
roles:
  research: { models: [flash] }
`,
  );
  sb.write("project/.jarvis/project.yaml", "version: 1\n");
});

afterEach(async () => {
  await server.close();
  sb.cleanup();
});

async function jarvis(args: string[], env: NodeJS.ProcessEnv = {}) {
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
    context: { cwd: sb.project, homeDir: sb.home, env: { PATH: process.env.PATH ?? "", TOK: "t", ...env } },
  });
  return { code, out, err };
}

describe("jarvis models", () => {
  it("lists models with egress, pools and probe state", async () => {
    const r = await jarvis(["models", "list"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/flash\s+openai-compatible\s+private\s+corp/);
    expect(r.out).toContain("cloud✗");
    expect(r.out).toContain("probe: never");
  });

  it("probes a model, stores the result and reports drift; doctor and list pick it up", async () => {
    server.respond((req) => {
      const body = req.body as { response_format?: { type: string }; tools?: unknown[] };
      if (body.tools) return toolCallCompletion("ping", { echo: "hi" });
      if (body.response_format?.type === "json_schema") return { status: 400, body: "unsupported" };
      if (body.response_format?.type === "json_object") return completion('{"ok":true}');
      return completion("PONG");
    });
    const probe = await jarvis(["--json", "models", "probe", "flash"]);
    expect(probe.code).toBe(0);
    const parsed = JSON.parse(probe.out) as { supports: Record<string, boolean>; drift: unknown[] };
    expect(parsed.supports).toEqual({ tools: true, jsonMode: true, jsonSchema: false, systemRole: true });
    expect(parsed.drift).toEqual([{ capability: "jsonSchema", configured: true, probed: false }]);

    const list = await jarvis(["models", "list"]);
    expect(list.out).toContain("DRIFT jsonSchema");
    expect(list.out).toMatch(/window: 19\/1000 output tokens, 3\/50 requests/);

    const doctor = await jarvis(["--json", "doctor"]);
    const report = JSON.parse(doctor.out) as { checks: { id: string; status: string; detail: string }[] };
    const flash = report.checks.find((c) => c.id === "probe:flash");
    expect(flash?.status).toBe("warn");
    expect(flash?.detail).toContain("jsonSchema");
  });

  it("refuses to probe a cloud model in a confidential project", async () => {
    const r = await jarvis(["models", "probe", "cloud"]);
    expect(r.code).toBe(12);
    expect(r.err).toContain("not allowed");
    expect(server.requests).toHaveLength(0);
  });

  it("returns exit 11 when the probe hits quota exhaustion", async () => {
    server.respond(() => ({ status: 429, body: { error: { message: "insufficient_quota" } } }));
    const r = await jarvis(["models", "probe", "flash"]);
    expect(r.code).toBe(11);
  });
});
