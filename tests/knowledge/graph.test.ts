import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TypeScriptExtractor } from "../../src/adapters/typescript/extractor.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import { run } from "../../src/cli/main.ts";
import { impactOf, repoIdOf, updateGraph, verifyGraph } from "../../src/knowledge/graph/update.ts";
import { HeldLease } from "../../src/orchestration/lease.ts";
import { createRun, testRuntime } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let rt: Runtime | undefined;
const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
function git(args: string[], cwd = sb.project): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } });
}

function write(rel: string, content: string) {
  mkdirSync(join(sb.project, rel, ".."), { recursive: true });
  writeFileSync(join(sb.project, rel), content);
}

beforeEach(() => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
  sb.write(
    "project/.jarvis/project.yaml",
    "version: 1\nworkspace: { mode: cwd }\ntools: { local: { test: 'true' } }\n",
  );
  writeFileSync(join(sb.project, "tsconfig.json"), "{}");
  write(
    "src/util/money.ts",
    "export function format(n: number) { return String(n); }\nexport const ZERO = 0;\n",
  );
  write(
    "src/orders/order.ts",
    "import { format } from '../util/money';\nexport class Order { total() { return format(1); } }\nexport type OrderId = string;\n",
  );
  write(
    "src/orders/api.ts",
    "import { Order } from './order';\nexport const createOrder = () => new Order();\n",
  );
  write(
    "src/orders/order.test.ts",
    "import { Order } from './order';\nimport { describe } from 'vitest';\ndescribe('order', () => new Order());\n",
  );
  write(
    "src/index.ts",
    "export * from './orders/api';\nimport lodash from 'lodash';\nexport const l = lodash;\n",
  );
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});
afterEach(async () => {
  await rt?.close();
  rt = undefined;
  sb.cleanup();
});

describe("TypeScriptExtractor", () => {
  it("extracts modules, symbols, imports and test relations deterministically", async () => {
    const x = new TypeScriptExtractor();
    const a = await x.extract(
      "src/orders/order.ts",
      "import { format } from '../util/money';\nexport class Order {}\nexport type OrderId = string;\nconst local = () => 1;\n",
    );
    expect(a.nodes.map((n) => [n.id, n.kind])).toEqual([
      ["src/orders/order.ts", "Module"],
      ["src/orders/order.ts#local", "Function"],
      ["src/orders/order.ts#Order", "Type"],
      ["src/orders/order.ts#OrderId", "Type"],
    ]);
    expect(a.nodes[2]?.metadata).toMatchObject({ exported: true, line: 2 });
    expect(a.edges).toEqual([
      { from: "src/orders/order.ts", to: "spec:../util/money", relation: "DEPENDS_ON" },
    ]);
    const t = await x.extract(
      "src/a.test.ts",
      "import { a } from './a'; const x = require('./b'); export {};",
    );
    expect(t.nodes[0]?.kind).toBe("Test");
    expect(t.edges.map((e) => `${e.relation} ${e.to}`)).toEqual(["TESTED_BY spec:./a", "TESTED_BY spec:./b"]);
    const again = await x.extract(
      "src/orders/order.ts",
      "import { format } from '../util/money';\nexport class Order {}\nexport type OrderId = string;\nconst local = () => 1;\n",
    );
    expect(JSON.stringify(again)).toBe(JSON.stringify(a));
  });
});

describe("incremental graph (ADR-0008)", () => {
  it("builds, reuses per tree, serves facts from the cache across branches and verifies determinism", async () => {
    rt = await testRuntime(sb);
    const extractors = rt.capabilities
      .list()
      .map((a) => a.graphExtractor?.())
      .filter((e) => e !== undefined);
    const base = {
      workspace: sb.project,
      repoId: repoIdOf(sb.project),
      cacheRoot: rt.loaded.home.cacheDir,
      extractors,
      store: rt.graph,
    };
    const first = await updateGraph(base);
    expect(first.reused).toBe(false);
    expect(first.extracted).toBe(5);
    expect(first.cacheHits).toBe(0);
    const s = first.snapshot;
    expect(s.edges).toEqual(
      expect.arrayContaining([
        { from: "src/orders/order.ts", to: "src/util/money.ts", relation: "DEPENDS_ON" },
        { from: "src/orders/api.ts", to: "src/orders/order.ts", relation: "DEPENDS_ON" },
        { from: "src/index.ts", to: "src/orders/api.ts", relation: "DEPENDS_ON" },
        { from: "src/index.ts", to: "pkg:lodash", relation: "DEPENDS_ON" },
        { from: "src/orders/order.ts", to: "src/orders/order.test.ts", relation: "TESTED_BY" },
        { from: "pkg:vitest", to: "src/orders/order.test.ts", relation: "TESTED_BY" },
      ]),
    );
    const cacheDir = join(rt.loaded.home.cacheDir, "graph", repoIdOf(sb.project), "blobs");
    expect(readdirSync(cacheDir)).toHaveLength(5);

    // same tree → the stored snapshot is reused without touching files
    const second = await updateGraph(base);
    expect(second.reused).toBe(true);
    expect(second.snapshot.id).toBe(s.id);

    // a branch that changes one file: 4 facts from the cache, 1 extracted; edges recomputed
    git(["checkout", "-q", "-b", "feature"]);
    write(
      "src/util/money.ts",
      "export function format(n: number) { return n.toFixed(2); }\nexport const ZERO = 0;\nexport const ONE = 1;\n",
    );
    git(["commit", "-qam", "change money"]);
    const third = await updateGraph(base);
    expect(third.reused).toBe(false);
    expect(third.extracted).toBe(1);
    expect(third.cacheHits).toBe(4);
    expect(third.snapshot.branch).toBe("feature");
    expect(third.snapshot.nodes.some((n) => n.id === "src/util/money.ts#ONE")).toBe(true);
    // back on main: every blob is known → zero extraction
    git(["checkout", "-q", "main"]);
    const fourth = await updateGraph({ ...base, force: true });
    expect(fourth.extracted).toBe(0);
    expect(fourth.cacheHits).toBe(5);
    expect(fourth.snapshot.contentHash).toBe(s.contentHash);

    const verify = await verifyGraph(base);
    expect(verify.ok).toBe(true);
    expect(rt.graph.latest(repoIdOf(sb.project))?.contentHash).toBe(s.contentHash);
  });

  it("impact traversal finds dependents by distance and covering tests", async () => {
    rt = await testRuntime(sb);
    const extractors = rt.capabilities
      .list()
      .map((a) => a.graphExtractor?.())
      .filter((e) => e !== undefined);
    const { snapshot } = await updateGraph({
      workspace: sb.project,
      repoId: repoIdOf(sb.project),
      cacheRoot: rt.loaded.home.cacheDir,
      extractors,
      store: rt.graph,
    });
    const impact = impactOf(snapshot, ["src/util/money.ts"]);
    expect(impact.dependents).toEqual([
      { file: "src/orders/order.ts", distance: 1 },
      { file: "src/orders/api.ts", distance: 2 },
      { file: "src/index.ts", distance: 3 },
    ]);
    expect(impact.tests).toEqual(["src/orders/order.test.ts"]);
    expect(impactOf(snapshot, ["src/util/money.ts"], 1).dependents).toEqual([
      { file: "src/orders/order.ts", distance: 1 },
    ]);
  });

  it("exposes graph.impact to agents and reports a missing snapshot honestly", async () => {
    rt = await testRuntime(sb);
    const runRec = createRun(rt, "smoke");
    rt.runs.transition(runRec.id, "RUNNING");
    const lease = HeldLease.acquire(rt.runs, runRec.id, "cli:test", { heartbeatMs: 0 });
    if (!lease) throw new Error("lease");
    try {
      const tools = rt.tools.bind({
        run: rt.runs.require(runRec.id),
        stepId: "impact",
        iteration: 1,
        lease,
        workspacePath: sb.project,
        agentCapabilities: ["graph.*"],
        env: {},
      });
      const before = await tools.invoke("graph.impact", { files: ["src/util/money.ts"] });
      expect(before.ok).toBe(false);
      expect(before.error).toContain("jarvis knowledge update");
      const extractors = rt.capabilities
        .list()
        .map((a) => a.graphExtractor?.())
        .filter((e) => e !== undefined);
      await updateGraph({
        workspace: sb.project,
        repoId: repoIdOf(sb.project),
        cacheRoot: rt.loaded.home.cacheDir,
        extractors,
        store: rt.graph,
      });
      const after = await tools.invoke("graph.impact", { files: ["src/util/money.ts"] });
      expect(after.ok).toBe(true);
      expect(after.text).toContain("src/orders/order.ts (distance 1)");
      expect(after.text).toContain("tests (1):\n  src/orders/order.test.ts");
      const neighbors = await tools.invoke("graph.neighbors", { file: "src/orders/order.ts" });
      expect(neighbors.text).toContain("imports: src/util/money.ts");
      expect(neighbors.text).toContain("symbols: Order, OrderId");
    } finally {
      lease.release();
    }
  });
});

describe("monorepo resolution (pilot: a yarn workspace)", () => {
  it("resolves tsconfig path aliases per package and workspace packages back to their sources", async () => {
    write(
      "package.json",
      JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*", "packages/*"] }),
    );
    // the library: exports into its build output, an alias `#/*` in a tsconfig with comments and `extends`
    write(
      "packages/lib/package.json",
      JSON.stringify({
        name: "@acme/lib",
        exports: { ".": "./.publish/index.js", "./*": "./.publish/*.js" },
      }),
    );
    write("packages/lib/tsconfig.json", '{ "extends": "./tsconfig.lib.json", "include": ["src"] }');
    write(
      "packages/lib/tsconfig.lib.json",
      '{\n  // build into .publish\n  "compilerOptions": { "outDir": ".publish", "baseUrl": "./", "paths": { "#/*": ["./*"] }, },\n}\n',
    );
    write("packages/lib/src/redux/state.ts", "export type State = { a: number };\n");
    write(
      "packages/lib/src/billing/index.ts",
      "import type { State } from '#/src/redux/state';\nimport isEqual from 'lodash/isEqual';\nexport const track = (s: State) => isEqual(s, s);\n",
    );
    write("packages/lib/src/index.ts", "export * from './billing';\n");
    // an app: a deep import of the library, its own alias, and the bare package
    write(
      "apps/web/tsconfig.json",
      '{ "compilerOptions": { "baseUrl": "./", "paths": { "Components/*": ["src/components/*"] } } }',
    );
    write("apps/web/package.json", JSON.stringify({ name: "web" }));
    write("apps/web/src/components/button.tsx", "export const Button = () => null;\n");
    write(
      "apps/web/src/page.tsx",
      "import { track } from '@acme/lib/billing';\nimport { Button } from 'Components/button';\nimport * as lib from '@acme/lib';\nexport const page = () => [track, Button, lib];\n",
    );
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "monorepo"]);

    rt = await testRuntime(sb);
    const extractors = rt.capabilities
      .list()
      .map((a) => a.graphExtractor?.())
      .filter((e) => e !== undefined);
    const { snapshot } = await updateGraph({
      workspace: sb.project,
      repoId: repoIdOf(sb.project),
      cacheRoot: rt.loaded.home.cacheDir,
      extractors,
      store: rt.graph,
    });
    expect(snapshot.edges).toEqual(
      expect.arrayContaining([
        {
          from: "packages/lib/src/billing/index.ts",
          to: "packages/lib/src/redux/state.ts",
          relation: "DEPENDS_ON",
        },
        { from: "packages/lib/src/billing/index.ts", to: "pkg:lodash/isEqual", relation: "DEPENDS_ON" },
        { from: "apps/web/src/page.tsx", to: "packages/lib/src/billing/index.ts", relation: "DEPENDS_ON" },
        { from: "apps/web/src/page.tsx", to: "apps/web/src/components/button.tsx", relation: "DEPENDS_ON" },
        { from: "apps/web/src/page.tsx", to: "packages/lib/src/index.ts", relation: "DEPENDS_ON" },
      ]),
    );
    expect(snapshot.edges.some((e) => e.to.startsWith("pkg:#") || e.to.startsWith("pkg:@acme"))).toBe(false);
    // a change in the library reaches the app
    const impact = impactOf(snapshot, ["packages/lib/src/redux/state.ts"]);
    expect(impact.dependents.map((d) => d.file)).toContain("apps/web/src/page.tsx");
  });
});

describe("the discover step keeps the graph current", () => {
  it("builds the snapshot of the run's tree before any agent asks for impact", async () => {
    sb.write(
      "project/.jarvis/workflows/disc.yaml",
      "name: disc\nversion: 1\nentry: discover\nsteps:\n  - { id: discover, kind: deterministic, tool: project.discover, transitions: { onSuccess: DONE } }\n",
    );
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "workflow"]);
    rt = await testRuntime(sb);
    expect(rt.graph.latest(repoIdOf(sb.project))).toBeUndefined();
    let out = "";
    const code = await run(["node", "jarvis", "work", "T-1", "--workflow", "disc"], {
      streams: {
        out: new Writable({
          write(c, _e, cb) {
            out += String(c);
            cb();
          },
        }),
        err: new Writable({
          write(_c, _e, cb) {
            cb();
          },
        }),
      },
      context: { cwd: sb.project, homeDir: sb.home, env: { PATH: process.env.PATH ?? "", ...gitEnv } },
    });
    expect(code, out).toBe(0);
    const latest = rt.graph.latest(repoIdOf(sb.project));
    expect(latest).toBeDefined();
    expect(rt.graph.load((latest as { id: string }).id)?.nodes.length).toBeGreaterThan(0);
  });
});

describe("graph lookup from a run's worktree", () => {
  it("finds the snapshot built for the project when the agent works in a linked worktree", async () => {
    rt = await testRuntime(sb);
    const extractors = rt.capabilities
      .list()
      .map((a) => a.graphExtractor?.())
      .filter((e) => e !== undefined);
    await updateGraph({
      workspace: sb.project,
      repoId: repoIdOf(sb.project),
      cacheRoot: rt.loaded.home.cacheDir,
      extractors,
      store: rt.graph,
    });
    const wt = join(sb.root, "wt");
    git(["worktree", "add", "-q", "-b", "jarvis/x", wt]);
    expect(repoIdOf(wt)).toBe(repoIdOf(sb.project));
    const runRec = createRun(rt, "smoke");
    rt.runs.transition(runRec.id, "RUNNING");
    const lease = HeldLease.acquire(rt.runs, runRec.id, "cli:test", { heartbeatMs: 0 });
    if (!lease) throw new Error("lease");
    try {
      const tools = rt.tools.bind({
        run: rt.runs.require(runRec.id),
        stepId: "impact",
        iteration: 1,
        lease,
        workspacePath: wt,
        agentCapabilities: ["graph.*"],
        env: {},
      });
      const result = await tools.invoke("graph.impact", { files: ["src/util/money.ts"] });
      expect(result.ok).toBe(true);
      expect(result.text).toContain("src/orders/order.ts (distance 1)");
    } finally {
      lease.release();
    }
  });
});

describe("jarvis knowledge", () => {
  async function jarvis(args: string[]) {
    let out = "";
    const code = await run(["node", "jarvis", ...args], {
      streams: {
        out: new Writable({
          write(c, _e, cb) {
            out += String(c);
            cb();
          },
        }),
        err: new Writable({
          write(_c, _e, cb) {
            cb();
          },
        }),
      },
      context: { cwd: sb.project, homeDir: sb.home, env: { PATH: process.env.PATH ?? "" } },
    });
    return { code, out };
  }

  it("update / status / --verify, and the TypeScript project reaches level FULL", async () => {
    const empty = await jarvis(["knowledge", "status"]);
    expect(empty.out).toContain("no graph snapshot yet");
    const update = await jarvis(["--json", "knowledge", "update"]);
    expect(update.code).toBe(0);
    const u = JSON.parse(update.out) as { reused: boolean; extracted: number; nodes: number; edges: number };
    expect(u).toMatchObject({ reused: false, extracted: 5 });
    expect(u.nodes).toBeGreaterThan(5);
    const again = JSON.parse((await jarvis(["--json", "knowledge", "update"])).out) as { reused: boolean };
    expect(again.reused).toBe(true);
    const status = await jarvis(["knowledge", "status", "--verify"]);
    expect(status.code).toBe(0);
    expect(status.out).toContain("verify: deterministic");

    const work = await jarvis(["--json", "work", "ABC-70", "--no-run"]);
    expect(work.code).toBe(0);
    const runId = JSON.parse(work.out) as { id?: string; run?: { id: string } };
    const resumed = await jarvis(["--json", "resume", runId.run?.id ?? (runId.id as string)]);
    const detail = JSON.parse(resumed.out) as {
      capabilities?: { level: string; adapters: Array<{ id: string }> };
    };
    expect(detail.capabilities?.level).toBe("FULL");
    expect(detail.capabilities?.adapters.map((a) => a.id)).toEqual(["typescript"]);
  });
});
