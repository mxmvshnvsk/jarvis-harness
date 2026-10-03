import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preflightMcp, workflowCapabilities } from "../../src/app/preflight.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import { resolveProfile, UnknownProfileError } from "../../src/mcp/profiles/index.ts";
import { filterBySchema, serversNeeded } from "../../src/mcp/provider.ts";
import { HeldLease } from "../../src/orchestration/lease.ts";
import { effectKey, effectMarker } from "../../src/storage/effects.ts";
import { loadWorkflows } from "../../src/workflows/load.ts";
import { createRun, testRuntime } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

const FIXTURE = join(import.meta.dirname, "..", "helpers", "fakeMcpServer.ts");
let sb: Sandbox;
let rt: Runtime | undefined;
let lease: HeldLease | undefined;

const ENV = { PATH: process.env.PATH ?? "", JARVIS_KEYCHAIN_BACKEND: "file" };

function serverYaml(id: string, extra: string, env: Record<string, string> = {}): string {
  const envYaml = Object.entries(env)
    .map(([k, v]) => `        ${k}: "${v}"`)
    .join("\n");
  return `    ${id}:
      transport: stdio
      command: node
      args: ["${FIXTURE}"]
      env:
${envYaml || "        {}"}
${extra}`;
}

async function setup(servers: string, dataClass = "internal", extraEnv: Record<string, string> = {}) {
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
  sb.write(
    "project/.jarvis/project.yaml",
    `version: 1\ndataClass: ${dataClass}\nworkspace: { mode: cwd }\nmcp:\n  servers:\n${servers}\n`,
  );
  rt = await testRuntime(sb, { ...ENV, ...extraEnv });
  const run = createRun(rt, "smoke");
  rt.runs.transition(run.id, "RUNNING");
  const held = HeldLease.acquire(rt.runs, run.id, "cli:test", { heartbeatMs: 0 });
  if (!held) throw new Error("lease");
  lease = held;
  const bind = (caps: string[] = ["*"]) =>
    (rt as Runtime).tools.bind({
      run: (rt as Runtime).runs.require(run.id),
      stepId: "research",
      iteration: 1,
      lease: held,
      workspacePath: sb.project,
      agentCapabilities: caps,
      env: ENV,
    });
  return { run, bind };
}

beforeEach(() => {
  sb = sandbox();
});
afterEach(async () => {
  lease?.release();
  await rt?.close();
  rt = undefined;
  sb.cleanup();
});

describe("profiles", () => {
  it("resolves built-ins, extends with pure entries only, rejects unknown names", () => {
    const base = resolveProfile({
      transport: "http",
      url: "https://x",
      auth: { type: "none" },
      profile: "atlassian",
      allow: [],
      deny: [],
      readOnly: false,
    });
    expect(base?.map["jira.comment"]?.effect).toBe(true);
    const extended = resolveProfile({
      transport: "http",
      url: "https://x",
      auth: { type: "none" },
      profile: { base: "atlassian", map: { "jira.worklog": "getWorklog", "jira.comment": "hack" } },
      allow: [],
      deny: [],
      readOnly: false,
    });
    expect(extended?.map["jira.worklog"]).toMatchObject({
      tools: ["getWorklog"],
      effect: false,
      access: "read",
    });
    expect(extended?.map["jira.comment"]?.tools).toContain("addCommentToJiraIssue");
    expect(() =>
      resolveProfile({
        transport: "http",
        url: "https://x",
        auth: { type: "none" },
        profile: "nope",
        allow: [],
        deny: [],
        readOnly: false,
      }),
    ).toThrow(UnknownProfileError);
  });

  it("filterBySchema drops synonyms the tool does not declare", () => {
    expect(
      filterBySchema({ issueKey: "A-1", issue_key: "A-1", x: undefined }, { properties: { issueKey: {} } }),
    ).toEqual({ issueKey: "A-1" });
    expect(filterBySchema({ a: 1, b: undefined }, undefined)).toEqual({ a: 1 });
  });
});

describe("profiled server", () => {
  it("exposes profile capabilities before discovery and reports unmapped ones after", async () => {
    await setup(serverYaml("jira", "      profile: atlassian\n      deny: [jira.transition]"));
    const before = (rt as Runtime).mcp.provider.report("jira");
    expect(before.discovered).toBeUndefined();
    expect(before.exposed).toContain("jira.comment");
    expect(before.denied).toEqual(["jira.transition"]);
    expect(before.network).toBe("intranet"); // profile default

    const entry = await (rt as Runtime).mcp.pool.discover("jira");
    expect(entry.tools.map((t) => t.name)).toContain("getJiraIssue");
    expect(existsSync(join(sb.home, ".jarvis", "cache", "mcp", "jira.json"))).toBe(true);
    const after = (rt as Runtime).mcp.provider.report("jira");
    expect(after.discovered?.count).toBe(5);
    expect(after.exposed).toEqual(["jira.comment", "jira.get", "jira.search"]);
    expect(after.unmapped).toEqual(["confluence.create", "confluence.get", "confluence.search"]);
  });

  it("routes a read through the policy and the normalized name", async () => {
    const { bind } = await setup(serverYaml("jira", "      profile: atlassian"));
    const tools = bind(["jira.*"]);
    const result = await tools.invoke("jira.get", { key: "ABC-42" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Allow onboarding restart");
    const denied = await tools.invoke("mcp.jira.echo", {});
    expect(denied.denied).toContain("unknown capability");
  });

  it("refuses intranet servers for confidential data when network is internet", async () => {
    const { bind } = await setup(
      serverYaml("jira", "      profile: atlassian\n      network: internet"),
      "confidential",
    );
    const result = await bind(["jira.*"]).invoke("jira.get", { key: "ABC-42" });
    expect(result.denied).toContain("not allowed for dataClass");
  });

  it("journals an effect with a marker and verifies an unknown outcome by the marker", async () => {
    const state = join(sb.root, "jira-state.txt");
    const { run, bind } = await setup(
      serverYaml("jira", "      profile: atlassian", { FAKE_MCP_STATE: state }),
    );
    const tools = bind(["jira.*"]);
    const args = { key: "ABC-42", body: "Spec approved" };
    const first = await tools.invoke("jira.comment", args);
    expect(first.error ?? first.denied).toBeUndefined();
    expect(first.ok).toBe(true);
    expect(first.source).toBe("executed");
    const lines = readFileSync(state, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Spec approved");
    expect(lines[0]).toMatch(/\[jarvis:run=.* effect=[0-9a-f]{12}\]/);
    const done = (rt as Runtime).effects.byRun(run.id);
    expect(done.map((e) => e.status)).toEqual(["done"]);

    // Same step, same args, same seq after a resume: replayed from the journal, never re-sent.
    const replay = await bind(["jira.*"]).invoke("jira.comment", args);
    expect(replay.source).toBe("journal");
    expect(readFileSync(state, "utf8").trim().split("\n")).toHaveLength(1);

    // A record left `intended` by a crashed process whose comment did land: verified by marker.
    const args2 = { key: "ABC-42", body: "Plan approved" };
    const input = {
      runId: run.id,
      stepId: "research",
      iteration: 1,
      capability: "jira.comment",
      args: args2,
      seq: 0,
    };
    const key = effectKey(input);
    (rt as Runtime).effects.begin({ ...input, leaseEpoch: lease?.epoch ?? 1 });
    writeFileSync(state, `ABC-42: Plan approved [${effectMarker(run.id, key)}]\n`);
    const second = await bind(["jira.*"]).invoke("jira.comment", args2);
    expect(second.ok).toBe(true);
    expect(second.source).toBe("verified");
    expect(readFileSync(state, "utf8").trim().split("\n")).toHaveLength(1);

    // Intended but never landed: verify says not-found, so it executes.
    const args3 = { key: "ABC-42", body: "Tests green" };
    const input3 = { ...input, args: args3 };
    (rt as Runtime).effects.begin({ ...input3, leaseEpoch: lease?.epoch ?? 1 });
    const third = await bind(["jira.*"]).invoke("jira.comment", args3);
    expect(third.source).toBe("executed");
    expect(readFileSync(state, "utf8").trim().split("\n")).toHaveLength(2);
  });
});

describe("unprofiled server", () => {
  it("exposes nothing until discovered and allowed; readOnly makes tools pure", async () => {
    await setup(`${serverYaml("raw", "      allow: []")}\n${serverYaml("ro", "      readOnly: true")}`);
    const runtime = rt as Runtime;
    expect(runtime.mcp.provider.report("raw").exposed).toEqual([]);
    await runtime.mcp.pool.discover("raw");
    await runtime.mcp.pool.discover("ro");
    runtime.registry.replace(runtime.mcp.provider);
    const raw = runtime.mcp.provider.report("raw");
    expect(raw.exposed).toEqual([]);
    expect(raw.notAllowed).toContain("mcp.raw.echo");
    const ro = runtime.mcp.provider.report("ro");
    expect(ro.exposed).toContain("mcp.ro.echo");
    const cap = runtime.registry.get("mcp.ro.echo");
    expect(cap).toMatchObject({ access: "read", effect: false, network: "internet" });
  });

  it("allowed tools without a profile are effects without verification", async () => {
    const { bind } = await setup(serverYaml("raw", "      allow: ['mcp.raw.echo']"));
    const runtime = rt as Runtime;
    await runtime.mcp.pool.discover("raw");
    runtime.registry.replace(runtime.mcp.provider);
    expect(runtime.registry.get("mcp.raw.echo")).toMatchObject({ access: "write", effect: true });
    const result = await bind(["mcp.raw.*"]).invoke("mcp.raw.echo", { text: "hi" });
    expect(result.error ?? result.denied).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.text).toBe("hi");
    expect(result.source).toBe("executed");
  });

  it("injects keychain credentials into the server env and redacts them from outputs", async () => {
    sb.write("home/.jarvis/credentials.json", JSON.stringify({ "me@corp/jira": "s3cr3t-token-value-123" }));
    const { bind } = await setup(serverYaml("ro", "      readOnly: true", { JIRA_TOKEN: "keychain:jira" }));
    const runtime = rt as Runtime;
    await runtime.mcp.pool.discover("ro");
    runtime.registry.replace(runtime.mcp.provider);
    const result = await bind(["mcp.ro.*"]).invoke("mcp.ro.whoami", {});
    expect(result.ok).toBe(true);
    expect(result.text).not.toContain("s3cr3t-token-value-123");
    expect(result.text).toMatch(/token=\[REDACTED:literal:[0-9a-f]+\]/);
  });

  it("fails clearly when a referenced credential is missing", async () => {
    await setup(serverYaml("ro", "      readOnly: true", { JIRA_TOKEN: "keychain:missing" }));
    await expect((rt as Runtime).mcp.pool.discover("ro")).rejects.toThrow(/keychain:missing is not set/);
  });
});

describe("preflight", () => {
  it("connects to the servers the workflow's agents may reach and refreshes the registry", async () => {
    await setup(
      `${serverYaml("jira", "      profile: atlassian")}\n${serverYaml("bb", "      profile: bitbucket")}`,
    );
    const runtime = rt as Runtime;
    const sdd = loadWorkflows(undefined).get("sdd");
    if (!sdd) throw new Error("sdd");
    const caps = workflowCapabilities(runtime, sdd);
    expect(caps).toContain("jira.get");
    expect(serversNeeded(runtime.loaded.config, caps)).toEqual(["jira"]);
    const result = await preflightMcp(runtime, sdd);
    expect(result).toEqual({ ok: true, servers: [{ id: "jira", ok: true, tools: 5 }] });
    expect(runtime.mcp.provider.report("jira").discovered).toBeDefined();
    expect(runtime.mcp.provider.report("bb").discovered).toBeUndefined();
  });
});
