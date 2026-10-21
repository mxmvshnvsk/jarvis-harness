import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../../src/app/engine.ts";
import { createRuntime, type Runtime } from "../../src/app/runtime.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { shortRunId } from "../../src/storage/runStore.ts";
import { startUiServer, type UiServer } from "../../src/ui/server.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** «Report a problem»: a GitHub issue filled in from the page, nothing sent by Jarvis itself. */
let sb: Sandbox;
let rt: Runtime;
let ui: UiServer;
const DEV = { kind: "user" as const, id: "dev@example.com", verified: false };

async function start(projectYaml = "version: 1\nworkspace: { mode: cwd }\n") {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: dev@example.com }\n");
  sb.write("project/.jarvis/project.yaml", projectYaml);
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
  });
}
afterEach(async () => {
  await ui.close();
  await rt.close();
  sb.cleanup();
});

function get(path: string): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: ui.port,
        path,
        headers: {
          host: `127.0.0.1:${ui.port}`,
          cookie: `jarvis_ui_${ui.port}=${encodeURIComponent(ui.token)}`,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            ...(typeof res.headers.location === "string" ? { location: res.headers.location } : {}),
            body,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function seedRun() {
  const run = rt.runs.create({
    task: "ABC-42 order totals; token sk-live-0123456789abcdef0123456789abcdef",
    workflow: "sdd",
    owner: DEV,
    workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
    dataClass: "internal",
  });
  rt.events.emit({
    kind: "model.error",
    runId: run.id,
    stepId: "implementation",
    payload: { modelId: "coder", message: "gateway 502 after 3 attempts" },
  });
  return run;
}

const query = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

describe("Report a problem", () => {
  beforeEach(() => start());

  it("is in the top bar, with the run when opened from its page", async () => {
    const run = seedRun();
    const short = shortRunId(run.id);
    expect((await get("/")).body).toContain('href="/report"');
    expect((await get(`/runs/${short}`)).body).toContain(`href="/report?run=${short}"`);
    const form = (await get(`/report?run=${short}`)).body;
    expect(form).toContain("mxmvshnvsk/jarvis-harness");
    expect(form).toContain('action="/report/github" target="_blank"');
    // the task's text is not ticked: it may be the company's
    expect(form).toContain('name="errors" value="1" checked');
    expect(form).toContain('name="task" value="1">');
  });

  it("opens GitHub's new-issue form filled in; the task only when ticked, secrets masked", async () => {
    const run = seedRun();
    const fields = {
      run: shortRunId(run.id),
      title: "Checks loop on the same failure",
      happened: "The second round failed as the first; no card.",
      expected: "The run stops and asks.",
      steps: "",
      env: "1",
      withRun: "1",
      errors: "1",
    };
    const res = await get(`/report/github?${query(fields)}`);
    expect(res.status).toBe(303);
    const url = new URL(res.location as string);
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/mxmvshnvsk/jarvis-harness/issues/new");
    expect(url.searchParams.get("title")).toBe("Checks loop on the same failure");
    expect(url.searchParams.get("labels")).toBe("bug");
    const body = url.searchParams.get("body") as string;
    expect(body).toContain("### What happened\nThe second round failed as the first; no card.");
    expect(body).toContain("### Environment\n- Jarvis ");
    expect(body).toContain("- workflow: sdd");
    expect(body).toContain("model.error coder implementation: gateway 502 after 3 attempts");
    expect(body).not.toContain("How to repeat");
    expect(body).not.toContain("ABC-42");

    const withTask = new URL(
      (await get(`/report/github?${query({ ...fields, task: "1" })}`)).location as string,
    ).searchParams.get("body") as string;
    expect(withTask).toContain("ABC-42 order totals");
    expect(withTask).not.toContain("sk-live-0123456789abcdef0123456789abcdef");
  });

  it("shows the text to copy, and shortens what does not fit in one address", async () => {
    const shown = (await get(`/report?${query({ title: "Long", happened: "ж".repeat(1500), show: "1" })}`))
      .body;
    expect(shown).toContain("The issue&#39;s text");
    expect(shown).toContain("Too long for one address");
    expect(shown).toContain('href="https://github.com/mxmvshnvsk/jarvis-harness/issues/new?');
  });
});

describe("Report a problem, configured", () => {
  it("goes to the repository and host set, and is off with repo: false", async () => {
    await start(
      "version: 1\nworkspace: { mode: cwd }\nfeedback: { repo: acme/jarvis-fork, host: https://git.example.com }\n",
    );
    const res = await get(`/report/github?${query({ title: "x", happened: "y" })}`);
    expect(res.location).toMatch(/^https:\/\/git\.example\.com\/acme\/jarvis-fork\/issues\/new\?/);
    await ui.close();
    await rt.close();
    sb.cleanup();
    await start("version: 1\nworkspace: { mode: cwd }\nfeedback: { repo: false }\n");
    expect((await get("/")).body).not.toContain('href="/report"');
    expect((await get("/report")).status).toBe(404);
  });
});
