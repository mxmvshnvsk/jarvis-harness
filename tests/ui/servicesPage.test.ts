import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../../src/app/engine.ts";
import { createRuntime, type Runtime } from "../../src/app/runtime.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import type { Launcher } from "../../src/ui/launcher.ts";
import { startUiServer, type UiServer } from "../../src/ui/server.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** Knowledge → Services in `jarvis ui` of a knowledge repository: the map, a service, «Onboard». */
let sb: Sandbox;
let rt: Runtime;
let ui: UiServer;
const execs: Array<{ args: readonly string[]; cwd: string }> = [];
const starts: Array<{ workflow: string; repoRoot: string }> = [];
let exitCode = 0;
const meta = () => join(sb.root, "shop-knowledge");

function launcher(): Launcher {
  const no = () => {
    throw new Error("not here");
  };
  return {
    start: (o) => {
      starts.push({ workflow: o.workflow, repoRoot: o.repoRoot });
      return {
        id: "0123456789ab",
        task: o.task,
        workflow: o.workflow,
        repoRoot: o.repoRoot,
        startedAt: new Date().toISOString(),
        exitCode: null,
        log: "",
      } as unknown as ReturnType<Launcher["start"]>;
    },
    continueRun: no,
    restartRun: no,
    fixPr: no,
    startModule: no,
    unqueue: () => false,
    list: () => [],
    get: () => undefined,
    drives: () => false,
    resume: () => false,
    adopt: () => false,
    tend: () => {},
    tail: () => "",
    exec: async (args, cwd) => {
      execs.push({ args, cwd });
      return { code: exitCode, output: exitCode === 0 ? "ok" : "boom" };
    },
  };
}

beforeEach(async () => {
  sb = sandbox();
  execs.length = 0;
  starts.length = 0;
  exitCode = 0;
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: dev@example.com }\n");
  sb.write(
    "shop-knowledge/project.yaml",
    "version: 1\nservices:\n  orders-api:\n    kind: backend\n    tools:\n      local:\n        tests: ./gradlew test\n  notifications-worker: {}\n",
  );
  sb.write(
    "shop-knowledge/knowledge/services/orders-api/architecture.md",
    "# orders-api\n\nTakes and tracks orders.\n\n## Modules\n",
  );
  for (const s of ["orders-api", "notifications-worker"])
    mkdirSync(join(sb.root, s, ".git"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: meta() });
  const loaded = await loadConfig({ cwd: meta(), homeDir: sb.home, env: {} });
  rt = createRuntime(loaded, { env: {} });
  ui = await startUiServer({
    runtime: rt,
    engine: createEngine(rt),
    port: 0,
    homeDir: sb.home,
    projectRoot: meta(),
    pollMs: 30,
    mcpCheckEveryMs: 0,
    actor: async () => ({ kind: "user" as const, id: "dev@example.com", verified: false }),
    launcher: launcher(),
    open: () => "VS Code",
  });
});
afterEach(async () => {
  await ui.close();
  await rt.close();
  sb.cleanup();
});

const cookie = () => `jarvis_ui_${ui.port}=${encodeURIComponent(ui.token)}`;
const page = async (path: string) => {
  const res = await fetch(`http://127.0.0.1:${ui.port}${path}`, { headers: { cookie: cookie() } });
  return { status: res.status, text: await res.text() };
};
const post = async (path: string, fields: Array<[string, string]>) => {
  const res = await fetch(`http://127.0.0.1:${ui.port}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: cookie(),
      origin: `http://127.0.0.1:${ui.port}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams([["t", ui.token], ...fields]).toString(),
  });
  return { status: res.status, location: res.headers.get("location") ?? "" };
};

describe("Services in jarvis ui", () => {
  it("the tab, the map and a service's page", async () => {
    const overview = await page("/knowledge");
    expect(overview.text).toContain('href="/knowledge/services">Services <span class="muted">2</span>');
    const map = await page("/knowledge/services");
    expect(map.status).toBe(200);
    // the top bar: Services of the map, current here; Knowledge not
    expect(map.text).toContain(
      '<a href="/knowledge/services" aria-current="page">Services<span class="n">2</span></a>',
    );
    expect(map.text).toContain('<a href="/knowledge">Knowledge</a>');
    expect(map.text).toContain("from <code>project.yaml</code>");
    expect(map.text).toContain("Takes and tracks orders.");
    expect(map.text).toContain('href="/knowledge/services?name=notifications-worker"');
    const one = await page("/knowledge/services?name=orders-api");
    expect(one.text).toContain('<h2 class="sv-h1">orders-api</h2>');
    expect(one.text).toContain("<dt>tests</dt><dd><code>./gradlew test</code>");
    expect((await page("/knowledge/services?name=nope")).status).toBe(404);
  });

  it("«Onboard»: jarvis onboard --service for each, in the knowledge repository; a failure is said", async () => {
    const ok = await post("/knowledge/services/onboard", [
      ["service", "notifications-worker"],
      ["service", "orders-api"],
      ["service", "not-in-the-map"],
      ["back", "/knowledge/services"],
    ]);
    expect(ok.status).toBe(303);
    expect(ok.location).toBe("/knowledge/services?notice=onboarded&file=notifications-worker%2C+orders-api");
    expect(execs).toEqual([
      { args: ["onboard", "--service", "notifications-worker"], cwd: meta() },
      { args: ["onboard", "--service", "orders-api"], cwd: meta() },
    ]);
    exitCode = 1;
    const bad = await post("/knowledge/services/onboard", [
      ["service", "orders-api"],
      ["back", "/knowledge/services?name=orders-api"],
    ]);
    expect(bad.location).toBe("/knowledge/services?name=orders-api&notice=onboard-failed&file=orders-api");
    expect((await page(bad.location)).text).toContain("jarvis onboard failed for orders-api");
  });
});

describe("New task in a knowledge repository", () => {
  it("Where: all services first and chosen, then the services with their kind; Fix is disabled with why", async () => {
    const runs = (await page("/")).text;
    expect(runs).toMatch(new RegExp(`value="${meta()}" data-name="All services" data-across checked`));
    expect(runs).toContain('<span class="badge">knowledge repo</span>');
    expect(runs).toContain("· 2 services");
    expect(runs).toContain('<span class="nm">orders-api</span><span class="badge">backend</span>');
    expect(runs).toContain('<span class="nm">notifications-worker</span><span class="p">');
    expect(runs).toMatch(
      /title="In one service only — pick it in Where"><input[^>]*value="fix"[^>]* disabled>/,
    );
    expect(runs).toContain("data-go>Run</button>");
  });

  it("Fix is refused there; Implement there is the task across services", async () => {
    const r = await post("/runs/new", [
      ["task", "ABC-64"],
      ["workflow", "fix"],
      ["repo", meta()],
    ]);
    expect(r.location).toBe("/?notice=knowledge-no-code#new");
    expect((await page(r.location)).text).toContain("Fix a bug runs in one service: pick it in Where");
    const go = await post("/runs/new", [
      ["task", "Partial refunds"],
      ["workflow", "sdd"],
      ["repo", meta()],
    ]);
    expect(go.location).toBe("/launches/0123456789ab");
    expect(starts).toEqual([{ workflow: "sdd-cross", repoRoot: meta() }]);
    // sdd (cross-repos) in a service: refused, Where is to change
    const svc = join(sb.root, "orders-api");
    const elsewhere = await post("/runs/new", [
      ["task", "Partial refunds"],
      ["workflow", "sdd-cross"],
      ["repo", svc],
    ]);
    expect(elsewhere.location).toBe("/?notice=cross-elsewhere#new");
  });
});
