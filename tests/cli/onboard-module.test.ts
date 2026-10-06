import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.ts";
import {
  type CapturedRequest,
  completion,
  type FakeOpenAi,
  startFakeOpenAi,
  toolCallCompletion,
} from "../helpers/fakeOpenAi.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let server: FakeOpenAi;
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

beforeEach(async () => {
  sb = sandbox();
  server = await startFakeOpenAi();
  put("tsconfig.json", "{}");
  put("src/util/money.ts", "export function format(n: number) { return String(n); }\n");
  put(
    "src/orders/order.ts",
    [
      "import { format } from '../util/money';",
      "export class Order {",
      "  // discounts are applied before tax",
      "  total() { return format(applyTax(applyDiscounts(1))); }",
      "}",
      "",
    ].join("\n"),
  );
  put("src/orders/order.test.ts", "import { Order } from './order';\nnew Order();\n");
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  sb.write(
    "home/.jarvis/config.yaml",
    `version: 1
actor: { id: me@corp }
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
  put(".jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\ntools:\n  local: { check: 'true' }\n");
});
afterEach(async () => {
  await server.close();
  sb.cleanup();
});

function agentOf(req: CapturedRequest): string {
  const system = (req.body.messages as Array<{ content: string }>)[0]?.content ?? "";
  return /# Agent: ([\w-]+)/.exec(system)?.[1] ?? "?";
}
function wantsResult(req: CapturedRequest): boolean {
  const messages = req.body.messages as Array<{ role: string; content: string | null }>;
  const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  return !req.body.tools && /Produce the result document|did not match/.test(last);
}
function toolCount(req: CapturedRequest): number {
  return ((req.body.messages as Array<{ role: string }>) ?? []).filter((m) => m.role === "tool").length;
}

function mapper(doc: unknown) {
  server.respond((req) => {
    expect(agentOf(req)).toBe("onboard-mapper");
    if (wantsResult(req)) return completion(JSON.stringify(doc));
    if (toolCount(req) === 0) return toolCallCompletion("repo.read", { path: "src/orders/order.ts" });
    return completion("done");
  });
}

const GOOD = {
  summary: "Orders",
  sources: ["src/orders/order.ts"],
  reasons: [],
  module: "src/orders",
  purpose: "Holds the order aggregate and prices it.",
  publicApi: [
    { symbol: "Order", file: "src/orders/order.ts", description: "the order aggregate" },
    { symbol: "Ghost", file: "src/orders/order.ts", description: "does not exist" },
  ],
  responsibilities: [],
  rules: [
    {
      statement: "Discounts are applied before tax.",
      evidence: [{ file: "src/orders/order.ts", line: 3, quote: "// discounts are applied before tax" }],
    },
    {
      statement: "Orders are cached per customer.",
      evidence: [{ file: "src/orders/order.ts", line: 9, quote: "cache.get(customerId)" }],
    },
  ],
  terms: [{ term: "order", synonyms: ["purchase"], symbols: ["Order"] }],
  unknowns: ["why totals are formatted here"],
  outcome: "ok",
};

describe("jarvis onboard --module", () => {
  it("maps a module, drops what the code does not support and waits as a candidate", async () => {
    mapper(GOOD);
    const r = await jarvis(["--json", "onboard", "--module", "src/orders", "--no-graph"]);
    expect(r.code).toBe(0);
    const result = JSON.parse(r.out) as {
      state: string;
      candidateId: string;
      claims: { proposed: number; kept: number };
      dropped: Array<{ what: string }>;
    };
    expect(result.state).toBe("COMPLETED");
    expect(result.claims).toEqual({ proposed: 5, kept: 3, sweeping: 0 });
    expect(result.dropped.map((d) => d.what).sort()).toEqual(["Ghost", "Orders are cached per customer."]);
    // nothing is written into the project by the agent
    expect(existsSync(join(sb.project, ".jarvis/knowledge/module-src-orders.md"))).toBe(false);

    const listed = await jarvis(["--json", "candidates", "list"]);
    const rows = (JSON.parse(listed.out) as { candidates: Array<{ id: string; title: string }> }).candidates;
    expect(rows.map((c) => c.title)).toContain("module src/orders");

    const promoted = await jarvis(["candidates", "promote", result.candidateId, "--id", "module-src-orders"]);
    expect(promoted.code).toBe(0);
    const text = readFileSync(join(sb.project, ".jarvis/knowledge/module-src-orders.md"), "utf8");
    expect(text).toMatch(/^---\nsource: \S+\n/);
    expect(text).toContain('paths: ["src/orders/**"]');
    expect(text).toContain("# Module src/orders");
    expect(text).toContain("Discounts are applied before tax.");
    expect(text).toContain("src/orders/order.ts:3");
    expect(text).not.toContain("cached per customer");
    expect(text).not.toContain("Ghost");

    // the promoted document is searchable like any other knowledge
    expect((await jarvis(["knowledge", "index"])).code).toBe(0);
    const found = await jarvis(["--json", "knowledge", "search", "discounts before tax"]);
    expect(found.code).toBe(0);
    expect(found.out).toContain("module-src-orders");
  });

  it("marks a generalisation its excerpt cannot prove, for the reviewer to read first (pilot)", async () => {
    mapper({
      ...GOOD,
      publicApi: [],
      terms: [],
      rules: [
        {
          statement: "Every order applies discounts before tax, never after.",
          evidence: [{ file: "src/orders/order.ts", line: 3, quote: "// discounts are applied before tax" }],
        },
        {
          statement: "Discounts are applied before tax.",
          evidence: [{ file: "src/orders/order.ts", line: 3, quote: "// discounts are applied before tax" }],
        },
      ],
    });
    const r = await jarvis(["onboard", "--module", "src/orders", "--no-graph"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("check before promoting — generalisations the excerpts cannot prove (1):");
    expect(r.out).toContain("  ? Every order applies discounts before tax, never after.");
    const id = /candidate (art_\w+)/.exec(r.out)?.[1] as string;
    expect((await jarvis(["candidates", "promote", id, "--id", "module-src-orders"])).code).toBe(0);
    const text = readFileSync(join(sb.project, ".jarvis/knowledge/module-src-orders.md"), "utf8");
    expect(text).toContain(
      "- Every order applies discounts before tax, never after. **[check: a generalisation; the excerpt shows one place]**",
    );
    expect(text).toContain("- Discounts are applied before tax.\n");
  });

  it("fails and creates no candidate when nothing survives verification", async () => {
    mapper({
      ...GOOD,
      publicApi: [],
      rules: [
        {
          statement: "invented",
          evidence: [{ file: "src/orders/order.ts", quote: "this text is nowhere" }],
        },
      ],
      terms: [],
    });
    const r = await jarvis(["--json", "onboard", "--module", "src/orders", "--no-graph"]);
    expect(r.code).not.toBe(0);
    const listed = await jarvis(["--json", "candidates", "list"]);
    expect((JSON.parse(listed.out) as { candidates: unknown[] }).candidates).toEqual([]);
  });

  it("--dry-run shows the task and calls no model", async () => {
    const r = await jarvis(["--json", "onboard", "--module", "src/orders", "--dry-run", "--no-graph"]);
    expect(r.code).toBe(0);
    expect(server.requests.length).toBe(0);
    expect(JSON.parse(r.out).task).toContain("src/orders");
  });

  it("rejects a path that is not a module", async () => {
    const r = await jarvis(["onboard", "--module", "src/nowhere", "--no-graph"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("not a module");
  });

  it("maps a directory inside a module, with dependencies at its own depth (pilot: a monorepo package)", async () => {
    put("packages/lib/src/observability/log.ts", "export function log(m: string) { return m; }\n");
    put(
      "packages/lib/src/billing/track.ts",
      "import { log } from '../observability/log';\nimport react from 'react';\nexport function track(e: string) { return log(e) && react; }\n",
    );
    put("packages/lib/src/billing/track.test.ts", "import { track } from './track';\ntrack('x');\n");
    put(
      "apps/web/src/page.ts",
      "import { track } from '../../../packages/lib/src/billing/track';\ntrack('open');\n",
    );
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "monorepo"]);

    const r = await jarvis(["--json", "onboard", "--module", "packages/lib/src/billing/", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(server.requests.length).toBe(0);
    const out = JSON.parse(r.out) as {
      module: string;
      task: string;
      facts: { files: number; dependsOn: string[]; usedBy: string[] };
    };
    expect(out.module).toBe("packages/lib/src/billing");
    expect(out.facts.files).toBe(2);
    // an external package is named as such, not as the module "(root)" (pilot)
    expect(out.facts.dependsOn).toEqual(["packages/lib/src/observability", "pkg:react"]);
    expect(out.facts.usedBy).toEqual(["apps/web"]);
    expect(out.task).toContain("Stay inside `packages/lib/src/billing`");

    const nowhere = await jarvis(["onboard", "--module", "packages/lib/src/nowhere", "--no-graph"]);
    expect(nowhere.code).not.toBe(0);
    expect(nowhere.err).toContain("not a module");
  });

  it("gives the mapper the team's documentation scoped to the module (knowledge.sources)", async () => {
    put("documentation/orders/overview.md", "# Orders\nTotals are formatted by util/money only.\n");
    put("documentation/orders/SKILL_orders.md", "# Changing orders\n1. Never round before tax.\n");
    put("documentation/billing/overview.md", "# Billing\nInvoices are monthly.\n");
    put(
      ".jarvis/project.yaml",
      [
        "version: 1",
        "workspace: { mode: cwd }",
        "knowledge:",
        "  sources:",
        "    - path: documentation",
        '      skills: ["SKILL_*.md"]',
        '      scopes: { "orders/**": ["src/orders/**"], "billing/**": ["src/billing/**"] }',
        "      agents: [onboard-mapper]",
        "",
      ].join("\n"),
    );
    mapper(GOOD);
    const r = await jarvis(["--json", "onboard", "--module", "src/orders", "--no-graph"]);
    expect(r.code).toBe(0);
    const first = server.requests[0] as CapturedRequest;
    const task = (first.body.messages as Array<{ role: string; content: string }>)[1]?.content ?? "";
    expect(task).toContain("## Skill orders@1 — Changing orders");
    expect(task).toContain("Never round before tax.");
    expect(task).toContain("## Knowledge documentation/orders/overview.md");
    expect(task).not.toContain("Invoices are monthly.");
  });
});
