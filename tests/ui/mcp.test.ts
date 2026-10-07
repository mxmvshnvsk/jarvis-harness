import { request } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../../src/app/engine.ts";
import { createRuntime, type Runtime } from "../../src/app/runtime.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { startUiServer, type UiServer } from "../../src/ui/server.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** ADR-0023, ADR-0017: the header's `mcp` indicator — the servers, their checks, "Check now". */
const FIXTURE = join(import.meta.dirname, "..", "helpers", "fakeMcpServer.ts");
let sb: Sandbox;
let rt: Runtime;
let ui: UiServer;

beforeEach(async () => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: dev@example.com }\n");
  sb.write(
    "project/.jarvis/project.yaml",
    `version: 1
dataClass: internal
workspace: { mode: cwd }
mcp:
  servers:
    jira:
      transport: stdio
      command: node
      args: ["${FIXTURE}"]
      profile: atlassian
      allow: [jira.get, jira.search]
    broken:
      transport: stdio
      command: node
      args: ["${join(sb.project, "no-such-server.js")}"]
      readOnly: true
`,
  );
  const loaded = await loadConfig({
    cwd: sb.project,
    homeDir: sb.home,
    env: { PATH: process.env.PATH ?? "" },
  });
  rt = createRuntime(loaded, { env: { PATH: process.env.PATH ?? "" } });
  ui = await startUiServer({
    runtime: rt,
    engine: createEngine(rt),
    port: 0,
    homeDir: sb.home,
    projectRoot: sb.project,
    pollMs: 30,
  });
});
afterEach(async () => {
  await ui.close();
  await rt.close();
  sb.cleanup();
});

function call(
  path: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: ui.port,
        path,
        method: options.method ?? "GET",
        headers: {
          host: `127.0.0.1:${ui.port}`,
          cookie: `jarvis_ui_${ui.port}=${encodeURIComponent(ui.token)}`,
          ...(options.body !== undefined
            ? {
                origin: `http://127.0.0.1:${ui.port}`,
                "content-type": "application/x-www-form-urlencoded",
                "content-length": String(Buffer.byteLength(options.body)),
              }
            : {}),
          ...options.headers,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

type McpJson = { state: string; title: string; html: string; checking: boolean };
async function settled(): Promise<McpJson> {
  let data = JSON.parse((await call("/mcp.json")).body) as McpJson;
  for (let i = 0; i < 300 && (data.state === "pending" || data.checking); i++) {
    await new Promise((r) => setTimeout(r, 50));
    data = JSON.parse((await call("/mcp.json")).body) as McpJson;
  }
  return data;
}

describe("the mcp indicator", () => {
  it("sits in the header next to models, with a popover the page fills from /mcp.json", async () => {
    const page = await call("/");
    expect(page.body).toContain('aria-controls="mcp-pop"');
    expect(page.body).toContain(
      '<div id="mcp-pop" class="pop" role="dialog" aria-label="MCP servers" hidden>',
    );
    const js = (await call("/assets/app.js")).body;
    expect(js).toContain("indicator('mcp', '/mcp.json')");
    expect(js).toContain("fetch('/mcp/check'");
  });

  it("checks each server at start: one answers, one does not — the worst is the dot", async () => {
    const data = await settled();
    expect(data.state).toBe("down");
    expect(data.title).toMatch(/^MCP: down — broken: did not answer the check/);
    expect(data.html).toContain("jira");
    expect(data.html).toMatch(/answered \d\d:\d\d · \d+ tools/);
    expect(data.html).toContain("jira.get, jira.search");
    expect(data.html).toContain("profile atlassian");
    expect(data.html).toContain("no answer");
    expect(data.html).toContain("jarvis mcp list --refresh");
    // the check refreshed the tools cache, as `jarvis mcp list --refresh` would
    expect(rt.mcp.provider.report("jira").discovered?.count).toBeGreaterThan(0);
  });

  it("Check now: only with the page's token, from the page's origin", async () => {
    const data = await settled();
    const token = /data-mcp-check="([^"]+)"/.exec(data.html)?.[1];
    expect(token).toBe(ui.token);
    expect((await call("/mcp/check", { method: "POST", body: "t=wrong" })).status).toBe(403);
    expect(
      (
        await call("/mcp/check", {
          method: "POST",
          body: `t=${encodeURIComponent(ui.token)}`,
          headers: { origin: "http://evil.example" },
        })
      ).status,
    ).toBe(403);
    const res = await call("/mcp/check", { method: "POST", body: `t=${encodeURIComponent(ui.token)}` });
    expect(res.status).toBe(202);
    expect((await settled()).state).toBe("down");
  });
});
