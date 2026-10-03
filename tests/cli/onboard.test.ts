import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.ts";
import { ONBOARD_MARKER } from "../../src/onboarding/render.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: sb.project, encoding: "utf8", env: { ...process.env, ...gitEnv } });
}

function put(rel: string, content: string) {
  const path = join(sb.project, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const read = (rel: string) => readFileSync(join(sb.project, rel), "utf8");

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

function commit(message: string) {
  git(["add", "-A"]);
  git(["commit", "-q", "-m", message]);
}

beforeEach(() => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
  put(".jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\ntools:\n  local: {}\n");
  put(
    "package.json",
    JSON.stringify({
      name: "shop",
      scripts: { test: "vitest run", typecheck: "tsc --noEmit", lint: "biome check .", build: "tsc" },
    }),
  );
  put("pnpm-lock.yaml", "lockfileVersion: 9\n");
  put("tsconfig.json", "{}");
  put("biome.json", "{}");
  put(".github/workflows/ci.yml", "name: ci\non: push\n");
  put("README.md", "# Shop\n");
  put("docs/adr/0001-use-sqlite.md", "# ADR 1\n");
  put("src/util/money.ts", "export function format(n: number) { return String(n); }\n");
  put(
    "src/orders/order.ts",
    "import { format } from '../util/money';\nexport class Order { total() { return format(1); } }\n",
  );
  put("src/orders/order.test.ts", "import { Order } from './order';\nnew Order();\n");
  put(".env", "TOKEN=abc\n");
  git(["init", "-q", "-b", "main"]);
  commit("feat(orders): add order");
  put(
    "src/orders/order.ts",
    "import { format } from '../util/money';\nexport class Order { total() { return format(2); } }\n",
  );
  commit("fix(orders): total");
});
afterEach(() => sb.cleanup());

describe("jarvis onboard", () => {
  it("scans without a model and writes factual skeletons", async () => {
    const r = await jarvis(["onboard", "--json"]);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.out);
    expect(json.packageManager).toBe("pnpm");
    expect(json.commands.map((c: { name: string; command: string }) => [c.name, c.command])).toEqual(
      expect.arrayContaining([
        ["tests", "pnpm test"],
        ["typecheck", "pnpm typecheck"],
        ["lint", "pnpm lint"],
      ]),
    );
    const modules = json.modules.map((m: { path: string }) => m.path);
    expect(modules).toEqual(expect.arrayContaining(["src/orders", "src/util"]));
    const orders = json.modules.find((m: { path: string }) => m.path === "src/orders");
    expect(orders.dependsOn).toContain("src/util");
    const util = json.modules.find((m: { path: string }) => m.path === "src/util");
    expect(util.usedBy).toContain("src/orders");
    expect(json.graph.available).toBe(true);
    expect(json.tests.layout).toBe("colocated");
    expect(json.tooling.ci.length).toBeGreaterThan(0);
    expect(json.tooling.linters.map((l: { tool: string }) => l.tool)).toContain("biome");
    expect(json.docs.map((d: { path: string }) => d.path)).toEqual(
      expect.arrayContaining(["README.md", "docs/adr/0001-use-sqlite.md"]),
    );
    expect(json.commits.conventional).toBe(2);
    expect(json.commits.scopes).toContain("orders");
    expect(json.sensitivePaths).toContain(".env");

    const architecture = read(".jarvis/knowledge/architecture.md");
    expect(architecture).toContain(ONBOARD_MARKER);
    expect(architecture).toContain("src/orders");
    expect(read(".jarvis/knowledge/conventions.md")).toContain("pnpm test");
    // the config is only suggested unless asked
    expect(read(".jarvis/project.yaml")).toContain("local: {}");
  });

  it("keeps files a human edited, and refreshes only generated ones with --refresh", async () => {
    await jarvis(["onboard"]);
    writeFileSync(
      join(sb.project, ".jarvis/knowledge/architecture.md"),
      "# Architecture\nOrders own pricing.\n",
    );
    put("src/billing/invoice.ts", "export const invoice = 1;\n");
    commit("feat(billing): invoice");

    const r = await jarvis(["onboard", "--refresh", "--no-graph", "--json"]);
    expect(r.code).toBe(0);
    const files = JSON.parse(r.out).files as Array<{ path: string; action: string }>;
    expect(files.find((f) => f.path.endsWith("architecture.md"))?.action).toBe("kept (edited by a human)");
    expect(files.find((f) => f.path.endsWith("conventions.md"))?.action).toBe("refreshed");
    expect(read(".jarvis/knowledge/architecture.md")).toContain("Orders own pricing.");
    expect(read(".jarvis/knowledge/architecture.md")).not.toContain("src/billing");

    // without --refresh nothing is regenerated
    const again = await jarvis(["onboard", "--no-graph", "--json"]);
    const actions = (JSON.parse(again.out).files as Array<{ action: string }>).map((f) => f.action);
    expect(actions).toEqual(["kept (edited by a human)", "kept (edited by a human)"]);
  });

  it("--dry-run writes nothing", async () => {
    const r = await jarvis(["onboard", "--dry-run", "--apply-config", "--json"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(sb.project, ".jarvis/knowledge/architecture.md"))).toBe(false);
    expect(read(".jarvis/project.yaml")).toContain("local: {}");
    const files = JSON.parse(r.out).files as Array<{ action: string }>;
    expect(files.map((f) => f.action)).toEqual(["would create", "would create"]);
  });

  it("--apply-config fills an empty tools.local and leaves a populated one alone", async () => {
    const r = await jarvis(["onboard", "--apply-config", "--no-graph", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).configApplied).toBe(true);
    const yaml = read(".jarvis/project.yaml");
    expect(yaml).toContain('tests: "pnpm test"');
    expect(yaml).not.toContain("local: {}");

    const edited = yaml.replace('tests: "pnpm test"', 'tests: "make test"');
    put(".jarvis/project.yaml", edited);
    const second = await jarvis(["onboard", "--apply-config", "--no-graph", "--json"]);
    expect(JSON.parse(second.out).configApplied).toBe(false);
    expect(read(".jarvis/project.yaml")).toBe(edited);

    // the result is still a valid project config
    const status = await jarvis(["config", "show", "--json"]);
    expect(status.code).toBe(0);
  });

  it("works with --no-graph and reports why the graph is missing", async () => {
    const r = await jarvis(["onboard", "--no-graph", "--json"]);
    const json = JSON.parse(r.out);
    expect(json.graph.available).toBe(false);
    expect(json.graph.reason).toContain("--no-graph");
    const orders = json.modules.find((m: { path: string }) => m.path === "src/orders");
    expect(orders.dependsOn).toEqual([]);
  });

  it("prints a human report", async () => {
    const r = await jarvis(["onboard", "--no-graph"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("suggested tools.local");
    expect(r.out).toContain("pnpm test");
    expect(r.out).toContain("deniedPaths");
    expect(r.out).toContain("created");
  });

  it("refuses outside a git repository", async () => {
    sb.cleanup();
    sb = sandbox();
    sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
    put(".jarvis/project.yaml", "version: 1\ntools:\n  local: {}\n");
    const r = await jarvis(["onboard"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("git repository");
  });
});
