import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { candidatesOf } from "../../src/app/candidates.ts";
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
    restartRun: () => {
      throw new Error("not here");
    },
    fixPr: () => {
      throw new Error("not here");
    },
    exec: async () => {
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

  it("proposes a candidate from the overview, as `jarvis candidates add` does", async () => {
    const overview = await page("/knowledge");
    expect(overview).toContain("Propose a candidate");
    expect(overview).toContain('<option value="unit-testing">unit-testing</option>');

    const added = await post("/knowledge/candidates/add", [
      ["kind", "standard"],
      ["title", "Money in minor units"],
      ["text", "Amounts are integers in minor units."],
      ["paths", "src/payments/**, src/orders/**"],
      ["evidence", "src/orders/order.ts:1"],
    ]);
    expect(added.location).toBe("/knowledge?notice=candidate-added&file=money-in-minor-units");
    expect(await page(added.location as string)).toContain("jarvis candidates promote money-in-minor-units");
    const [c] = candidatesOf(rt);
    expect(c?.doc).toMatchObject({ kind: "standard", paths: ["src/payments/**", "src/orders/**"] });
    expect(c?.artifact.provenance).toMatchObject({ kind: "human", actor: { id: "dev@example.com" } });
    expect(await page("/knowledge")).toContain("1 open besides module maps");

    const noSkill = await post("/knowledge/candidates/add", [
      ["kind", "skill-improvement"],
      ["title", "Fixtures"],
      ["text", "5. Name the fixture after the case."],
    ]);
    expect(noSkill.location).toContain("notice=candidate-invalid");
    expect(await page(noSkill.location as string)).toContain(
      "Not proposed: a skill improvement needs --skill",
    );
    const skill = await post("/knowledge/candidates/add", [
      ["kind", "skill-improvement"],
      ["skill", "unit-testing"],
      ["title", "Fixtures"],
      ["text", "5. Name the fixture after the case."],
    ]);
    expect(skill.location).toContain("notice=candidate-added");
    expect(candidatesOf(rt).map((x) => x.doc.skill ?? x.doc.kind)).toEqual(["standard", "unit-testing"]);
  });

  it("decides candidates on the Candidates page, as `jarvis candidates promote|reject` does", async () => {
    const propose = (kind: string, title: string, text: string, skill?: string) =>
      post("/knowledge/candidates/add", [
        ["kind", kind],
        ["title", title],
        ["text", text],
        ...(skill ? [["skill", skill] as [string, string]] : []),
      ]);
    await propose("standard", "Money in minor units", "Amounts are integers in minor units.");
    await propose("knowledge", "Order states", "An order goes draft → placed → paid.");
    await propose("skill-improvement", "Fixtures", "5. Name the fixture after the case.", "unit-testing");
    const [money, states, fixtures] = candidatesOf(rt);
    const list = await page("/knowledge/candidates");
    expect(list).toContain('Candidates <span class="muted">3</span>');
    // newest first and shown: the skill improvement and what accepting it does
    expect(list).toContain("Accepting copies the built-in skill");
    expect(list).toContain("v1 → v2");
    expect(await page(`/knowledge/candidates?id=${money?.artifact.artifactId}`)).toContain(
      ".jarvis/standards/money-in-minor-units.md",
    );

    const accepted = await post(`/knowledge/candidates/${money?.artifact.artifactId}/accept`, [
      ["id", "money"],
    ]);
    expect(accepted.location).toContain("notice=accepted");
    expect(readFileSync(join(sb.project, ".jarvis/standards/money.md"), "utf8")).toContain(
      "Amounts are integers in minor units.",
    );
    expect(await page(accepted.location as string)).toContain(
      "Written to <code>.jarvis/standards/money.md</code>",
    );

    const skill = await post(`/knowledge/candidates/${fixtures?.artifact.artifactId}/accept`, []);
    expect(skill.location).toContain("notice=candidate-skill");
    expect(readFileSync(join(sb.project, ".jarvis/skills/unit-testing/instructions.md"), "utf8")).toContain(
      "5. Name the fixture after the case.",
    );

    const rejected = await post(`/knowledge/candidates/${states?.artifact.artifactId}/reject`, [
      ["comment", "already in orders.md"],
    ]);
    expect(rejected.location).toContain("notice=candidate-rejected");
    expect(rt.artifacts.approvalsFor(states?.artifact.artifactId as string, 1)[0]).toMatchObject({
      decision: "reject",
      comment: "already in orders.md",
    });
    // decided: gone from the open list, on the list with decided ones, and not decided twice
    const after = await page("/knowledge/candidates");
    expect(after).toContain("Nothing waits");
    expect(after).toContain("With decided (3)");
    const again = await post(`/knowledge/candidates/${states?.artifact.artifactId}/accept`, []);
    expect(again.location).toContain("notice=decided");
  });
});
