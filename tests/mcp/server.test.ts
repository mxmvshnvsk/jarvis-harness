import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app/runtime.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** ADR-0017 §7: `jarvis mcp serve` answers read-only questions over stdio. */
let sb: Sandbox;
let client: Client | undefined;
const MAIN = join(import.meta.dirname, "..", "..", "src", "cli", "main.ts");

beforeEach(async () => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
  sb.write("project/.jarvis/project.yaml", "version: 1\nstack: [typescript]\nworkspace: { mode: cwd }\n");
  sb.write(
    "project/.jarvis/knowledge/domain.md",
    "Orders are immutable after dispatch.\nRefunds go through the ledger.\n",
  );
  sb.write(
    "project/.jarvis/standards/no-console.md",
    "---\nid: no-console\ntitle: No console output\n---\nUse the logger, never console.\n",
  );
  // a run with a spec artifact, written straight into the store
  const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
  const rt = createRuntime(loaded, { env: {} });
  const run = rt.runs.create({
    task: "ABC-90",
    workflow: "sdd",
    owner: { kind: "user", id: "me@corp", verified: false },
    workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
    dataClass: "internal",
  });
  rt.artifacts.put({
    runId: run.id,
    type: "spec",
    name: "spec.json",
    content: JSON.stringify({ title: "Allow restart", requirements: [] }),
    mediaType: "application/json",
    provenance: { kind: "agent", agentId: "specification" },
    stepId: "spec",
    iteration: 1,
  });
  await rt.close();
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  sb.cleanup();
});

describe("jarvis mcp serve", () => {
  it("lists read-only tools and answers knowledge, spec, status and context questions", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MAIN, "--cwd", sb.project, "mcp", "serve"],
      env: { PATH: process.env.PATH ?? "", HOME: sb.home, JARVIS_HOME: join(sb.home, ".jarvis") },
      stderr: "ignore",
    });
    client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "context.inspect",
      "knowledge.search",
      "run.status",
      "spec.get",
    ]);

    const search = await client.callTool({ name: "knowledge.search", arguments: { query: "ledger" } });
    expect((search.content as Array<{ text: string }>)[0]?.text).toContain(
      "1. knowledge:domain.md  [knowledge] domain.md — Orders are immutable after dispatch. Refunds go through the [ledger].",
    );
    const std = await client.callTool({ name: "knowledge.search", arguments: { query: "console" } });
    expect((std.content as Array<{ text: string }>)[0]?.text).toContain("standard:no-console@1");

    const spec = await client.callTool({ name: "spec.get", arguments: { run: "ABC-90" } });
    expect((spec.content as Array<{ text: string }>)[0]?.text).toContain("# spec/spec.json@1");
    expect((spec.content as Array<{ text: string }>)[0]?.text).toContain("Allow restart");

    const status = await client.callTool({ name: "run.status", arguments: {} });
    expect((status.content as Array<{ text: string }>)[0]?.text).toContain("ABC-90  CREATED");
    const one = await client.callTool({ name: "run.status", arguments: { run: "ABC-90" } });
    expect((one.content as Array<{ text: string }>)[0]?.text).toContain("artifacts:\n  spec/spec.json@1");

    const context = await client.callTool({
      name: "context.inspect",
      arguments: { agent: "implementation" },
    });
    const text = (context.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toContain("stacks: typescript; agent: implementation");
    expect(text).toContain("## Skill sdd-implementation@1");
    expect(text).toContain("## Standard no-console@1");
    expect(text).toContain("## Knowledge domain.md");
  });
});
