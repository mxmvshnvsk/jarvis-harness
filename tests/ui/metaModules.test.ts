import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../../src/app/engine.ts";
import { createRuntime, type Runtime } from "../../src/app/runtime.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import type { Launcher } from "../../src/ui/launcher.ts";
import { startUiServer, type UiServer } from "../../src/ui/server.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** Knowledge → Modules in `jarvis ui` of a knowledge repository: its services' modules, not its own folders. */
let sb: Sandbox;
let rt: Runtime;
let ui: UiServer;
const execs: Array<{ args: readonly string[]; cwd: string }> = [];
const starts: Array<{ workflow: string; repoRoot: string }> = [];
const modules: Array<{ module: string; repoRoot: string }> = [];
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
    startModule: (o) => {
      modules.push({ module: o.module, repoRoot: o.repoRoot });
      return {
        id: "l1",
        task: `module ${o.module}`,
        workflow: "onboard-module",
        module: o.module,
        repoRoot: o.repoRoot,
        startedAt: new Date().toISOString(),
        exitCode: null,
        log: "",
      } as unknown as ReturnType<Launcher["startModule"]>;
    },
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
  modules.length = 0;
  // orders-api is cloned here, with code; notifications-worker is not
  for (const f of ["src/order/OrderService.java", "src/order/dto/OrderDto.java", "src/billing/Invoice.java"])
    sb.write(`orders-api/${f}`, "package shop;\nclass A {\n  int a;\n}\n");
  const g = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: join(sb.root, "orders-api"),
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  g("init", "-q", "-b", "main");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
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

describe("Modules of a knowledge repository", () => {
  it("lists the services: a cloned one over its own modules, the other as not on this machine", async () => {
    const r = await page("/knowledge/modules");
    expect(r.status).toBe(200);
    expect(r.text).toContain("<b>orders-api</b>");
    expect(r.text).toContain(
      '<b>notifications-worker</b><span class="hint mrepo">not on this machine</span>',
    );
    // the clone's modules, under the service's name; not the knowledge repository's own folders
    expect(r.text).toContain("/knowledge/modules?path=orders-api%2Fsrc");
    expect(r.text).not.toContain("path=knowledge%2Fservices");
  });

  it("a folder of a service is researched in its clone, as its own module", async () => {
    const r = await page("/knowledge/modules?path=orders-api/src/order");
    expect(r.text).toContain("Runs in <code>");
    expect(r.text).toContain("<code>jarvis onboard --module src/order</code>");
    expect(r.text).toContain("<code>knowledge/services/orders-api/</code>");
    const sent = await post("/knowledge/modules/research", [["path", "orders-api/src/order"]]);
    expect(sent.location).toContain("path=orders-api%2Fsrc%2Forder");
    expect(modules).toEqual([{ module: "src/order", repoRoot: join(sb.root, "orders-api") }]);
  });

  it("a service not cloned: what the map says and how its modules appear, no research", async () => {
    const r = await page("/knowledge/modules?path=notifications-worker");
    expect(r.text).toContain("Its code is not on this machine");
    expect(r.text).toContain("<code>repos.notifications-worker</code>");
    expect(r.text).not.toContain("Start research");
    const sent = await post("/knowledge/modules/research", [["path", "notifications-worker"]]);
    expect(sent.location).toContain("notice=no-path");
    expect(modules).toEqual([]);
  });
});
