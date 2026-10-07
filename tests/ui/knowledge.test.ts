import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../../src/app/engine.ts";
import { createRuntime, type Runtime } from "../../src/app/runtime.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import type { Launch, Launcher } from "../../src/ui/launcher.ts";
import { startUiServer, type UiServer } from "../../src/ui/server.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** Knowledge pages: overview, documents, standards, skills, glossary — and adding a term. */
let sb: Sandbox;
let rt: Runtime;
let ui: UiServer;
const DEV = { kind: "user" as const, id: "dev@example.com", verified: false };
const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const started: Array<{ module: string; note?: string }> = [];
const adopted: string[] = [];

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: sb.project, encoding: "utf8", env: { ...process.env, ...gitEnv } });

/** A launcher that only notes what the page asked for. */
function stubLauncher(): Launcher {
  const launches: Launch[] = [];
  return {
    start: () => {
      throw new Error("not here");
    },
    continueRun: () => {
      throw new Error("not here");
    },
    startModule(input) {
      started.push({ module: input.module, ...(input.note ? { note: input.note } : {}) });
      const l: Launch = {
        id: `l${launches.length}`,
        task: `module ${input.module}`,
        workflow: "onboard-module",
        module: input.module,
        repoRoot: input.repoRoot,
        startedAt: new Date().toISOString(),
        log: "/dev/null",
        exitCode: null,
        queued: launches.some((x) => !x.queued),
      };
      launches.unshift(l);
      return l;
    },
    unqueue: (id) => {
      const at = launches.findIndex((l) => l.id === id && l.queued);
      if (at >= 0) launches.splice(at, 1);
      return at >= 0;
    },
    list: () => launches,
    get: (id) => launches.find((l) => l.id === id),
    drives: () => false,
    resume: () => false,
    adopt: (run) => {
      adopted.push(run.id);
      return true;
    },
    tend: () => {},
    tail: () => "",
  };
}

beforeEach(async () => {
  sb = sandbox();
  started.length = 0;
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: dev@example.com }\n");
  sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
  sb.write("project/src/orders/order.ts", "export class Order {}\n");
  sb.write("project/src/orders/form/step.ts", "export const step = 1;\n");
  sb.write("project/src/orders/OrderService.ts", "export class OrderService {}\n");
  sb.write(
    "project/.jarvis/knowledge/orders.md",
    '---\npaths: ["src/orders/**"]\n---\n# Orders\n\n## Totals\n\nTotals are rounded once.\n',
  );
  sb.write(
    "project/.jarvis/knowledge/architecture.md",
    "---\ntags: [architecture]\n---\n# Architecture\n\nLayers.\n",
  );
  sb.write(
    "project/.jarvis/knowledge/glossary.md",
    "| термин | синонимы | символы/модули | источники | обновлено | определение |\n| --- | --- | --- | --- | --- | --- |\n| заказ | order | `OrderService` | | 2026-10-01 | Покупка |\n",
  );
  sb.write(
    "project/.jarvis/standards/orders-no-fetch.md",
    '---\nid: orders-no-fetch\ntitle: No fetch in orders\nseverity: required\nverification:\n  kind: deterministic\n  check:\n    pattern: { glob: "src/orders/**", mustNot: "fetch\\\\(" }\n---\nCall the API client, not fetch.\n',
  );
  git("init", "-q", "-b", "main");
  // the page commits as the repository's git config says, like a commit made by hand
  git("config", "user.name", "t");
  git("config", "user.email", "t@t");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
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
    actor: async () => DEV,
    launcher: stubLauncher(),
    open: () => "VS Code",
  });
});
afterEach(async () => {
  await ui.close();
  await rt.close();
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

function postPage(path: string, fields: Array<[string, string]>): Promise<string> {
  return fetch(`http://127.0.0.1:${ui.port}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: cookie(),
      origin: `http://127.0.0.1:${ui.port}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams([["t", ui.token], ...fields]).toString(),
  }).then((r) => r.text());
}

describe("Knowledge pages", () => {
  it("every tab renders from the files, with counts", async () => {
    const overview = await page("/knowledge");
    expect(overview).toContain("Would an agent find it?");
    expect(overview).toContain('>Documents <span class="muted">2</span>');
    expect(overview).toContain('Glossary <span class="muted">1</span>');
    const docs = await page("/knowledge/docs?doc=.jarvis%2Fknowledge%2Forders.md");
    expect(docs).toContain("Totals are rounded once.");
    expect(docs).toContain("How the index cuts it");
    expect(docs).toContain("Open in editor");
    expect(await page("/knowledge/docs?doc=.jarvis%2Fknowledge%2Farchitecture.md")).toContain(
      'aria-current="page">Architecture',
    );
    const std = await page("/knowledge/standards");
    expect(std).toContain("orders-no-fetch");
    expect(std).toContain("Call the API client, not fetch.");
    const skills = await page("/knowledge/skills");
    expect(skills).toContain("sdd-implementation");
    const glossary = await page("/knowledge/glossary?term=%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7");
    expect(glossary).toContain("src/orders/OrderService.ts:1");
  });

  it("a term: checked against the code first; a symbol not found asks for «Add anyway»; then a draft", async () => {
    const check = await postPage("/knowledge/glossary", [
      ["term", "форма"],
      ["synonyms", "form"],
      ["symbols", "OrderService, FormFieldX"],
      ["do", "add"],
    ]);
    expect(check).toContain("FormFieldX</code> — not in the code");
    expect(check).toContain("Add anyway");
    expect(readFileSync(join(sb.project, ".jarvis/knowledge/glossary.md"), "utf8")).not.toContain("форма");

    const added = await post("/knowledge/glossary", [
      ["term", "форма"],
      ["synonyms", "form"],
      ["symbols", "OrderService, FormFieldX"],
      ["do", "add-anyway"],
    ]);
    expect(added.location).toContain("notice=term-added");
    expect(readFileSync(join(sb.project, ".jarvis/knowledge/glossary.md"), "utf8")).toContain(
      "| форма | form | `OrderService`, `FormFieldX` |",
    );
    const again = await postPage("/knowledge/glossary", [
      ["term", "Форма"],
      ["do", "add"],
    ]);
    expect(again).toContain("is in the glossary already");
    // the draft is committed from any Knowledge page, and the page comes back
    const c = await post("/knowledge/commit", [["back", "/knowledge/glossary"]]);
    expect(c.location).toMatch(/^\/knowledge\/glossary\?notice=committed/);
  });

  it("opens a knowledge file in the editor, nothing else", async () => {
    expect(
      (
        await post("/knowledge/open", [
          ["file", ".jarvis/knowledge/orders.md"],
          ["back", "/knowledge/docs"],
        ])
      ).location,
    ).toContain("/knowledge/docs?notice=opened");
    expect(
      (
        await post("/knowledge/open", [
          ["file", "src/orders/order.ts"],
          ["back", "/knowledge/docs"],
        ])
      ).location,
    ).toContain("notice=no-file");
    expect((await post("/knowledge/open", [["file", ".jarvis/../../etc/passwd"]])).location).toContain(
      "notice=no-file",
    );
  });
});
