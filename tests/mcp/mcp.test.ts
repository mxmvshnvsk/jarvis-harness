import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preflightMcp, workflowCapabilities } from "../../src/app/preflight.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import { run } from "../../src/cli/main.ts";
import { embeddedLinks } from "../../src/mcp/profiles/atlassian.ts";
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
  lease = undefined;
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

  it("filterBySchema turns a numeric string into the number a tool declares", () => {
    const schema = {
      properties: { id: { type: "number" }, n: { type: "integer" }, key: { type: "string" } },
    };
    expect(filterBySchema({ id: "42", n: " 7 ", key: "12" }, schema)).toEqual({ id: 42, n: 7, key: "12" });
    expect(filterBySchema({ id: "PR-1" }, schema)).toEqual({ id: "PR-1" });
  });
});

describe("Bitbucket Server (@nexus2520/bitbucket-mcp-server)", () => {
  // their tools and parameters as the server declares them (3.0)
  const NUM = { type: "number" };
  const BB: Record<string, Record<string, unknown>> = {
    "bitbucket.pr.get": {
      tool: "get_pull_request",
      schema: { workspace: {}, repository: {}, pull_request_id: NUM, include_comments: {} },
    },
    "bitbucket.pr.list": { tool: "list_pull_requests", schema: { workspace: {}, repository: {}, state: {} } },
    "bitbucket.pr.diff": {
      tool: "get_pull_request_diff",
      schema: { workspace: {}, repository: {}, pull_request_id: NUM, context_lines: {} },
    },
    "bitbucket.pr.create": {
      tool: "create_pull_request",
      schema: {
        workspace: {},
        repository: {},
        title: {},
        source_branch: {},
        destination_branch: {},
        description: {},
      },
    },
    "bitbucket.pr.comment": {
      tool: "add_comment",
      schema: { workspace: {}, repository: {}, pull_request_id: NUM, comment_text: {} },
    },
  };
  const call = (cap: string, args: Record<string, unknown>) => {
    const entry = resolveProfile({ profile: "bitbucket" } as never)?.map[cap];
    expect(entry?.tools).toContain(BB[cap]?.tool);
    return filterBySchema(entry?.args?.(args) ?? args, {
      properties: BB[cap]?.schema as Record<string, unknown>,
    });
  };

  it("maps every capability onto their tools and parameter names", () => {
    const pr = { workspace: "WEB", repo: "web-app", id: "17" };
    const at = { workspace: "WEB", repository: "web-app", pull_request_id: 17 };
    expect(call("bitbucket.pr.get", pr)).toEqual(at);
    expect(call("bitbucket.pr.diff", pr)).toEqual(at);
    expect(call("bitbucket.pr.list", { workspace: "WEB", repo: "web-app" })).toEqual({
      workspace: "WEB",
      repository: "web-app",
      state: "OPEN",
    });
    expect(call("bitbucket.pr.comment", { ...pr, content: "looks good" })).toEqual({
      ...at,
      comment_text: "looks good",
    });
    expect(
      call("bitbucket.pr.create", {
        workspace: "WEB",
        repo: "web-app",
        title: "Fix",
        source: "fix/a",
        target: "main",
      }),
    ).toEqual({
      workspace: "WEB",
      repository: "web-app",
      title: "Fix",
      source_branch: "fix/a",
      destination_branch: "main",
    });
  });
});

describe("Data Center servers (@atlassian-dc-mcp/jira, …/confluence)", () => {
  // their tools and parameters as the servers declare them (0.35)
  const DC: Record<string, Record<string, unknown>> = {
    "jira.get": { tool: "jira_getIssue", schema: { issueKey: {}, expand: {}, fields: {} } },
    "jira.search": { tool: "jira_searchIssues", schema: { jql: {}, maxResults: {}, startAt: {} } },
    "jira.comment": { tool: "jira_postIssueComment", schema: { issueKey: {}, comment: {} } },
    "jira.transition": { tool: "jira_transitionIssue", schema: { issueKey: {}, transitionId: {} } },
    "confluence.get": { tool: "confluence_getContent", schema: { contentId: {}, bodyMode: {}, expand: {} } },
    "confluence.search": { tool: "confluence_searchContent", schema: { cql: {}, limit: {}, excerpt: {} } },
    "confluence.create": {
      tool: "confluence_createContent",
      schema: { title: {}, spaceKey: {}, content: {} },
    },
  };
  const call = (cap: string, args: Record<string, unknown>) => {
    const profile = resolveProfile({ profile: "atlassian" } as never);
    const entry = profile?.map[cap];
    expect(entry?.tools).toContain(DC[cap]?.tool);
    return filterBySchema(entry?.args?.(args) ?? args, {
      properties: DC[cap]?.schema as Record<string, unknown>,
    });
  };

  it("maps every capability onto their tools and parameter names", () => {
    expect(call("jira.get", { key: "ABC-42" })).toEqual({ issueKey: "ABC-42" });
    expect(call("jira.search", { jql: "project = ABC", limit: 5 })).toEqual({
      jql: "project = ABC",
      maxResults: 5,
    });
    expect(call("jira.comment", { key: "ABC-42", body: "done" })).toEqual({
      issueKey: "ABC-42",
      comment: "done",
    });
    expect(call("jira.transition", { key: "ABC-42", transition: "31" })).toEqual({
      issueKey: "ABC-42",
      transitionId: "31",
    });
    expect(call("confluence.get", { id: "1234" })).toEqual({ contentId: "1234", bodyMode: "text" });
    expect(call("confluence.create", { space: "BILL", title: "Rounding", body: "<p>x</p>" })).toEqual({
      title: "Rounding",
      spaceKey: "BILL",
      content: "<p>x</p>",
    });
  });

  it("free text becomes CQL for a server that takes only CQL", () => {
    expect(call("confluence.search", { query: 'invoice "total"' })).toEqual({
      cql: 'text ~ "invoice  total "',
      limit: 10,
      excerpt: "highlight",
    });
    expect(call("confluence.search", { cql: "space = BILL" })).toMatchObject({ cql: "space = BILL" });
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
    expect(after.discovered?.count).toBe(6);
    expect(after.exposed).toEqual(["confluence.get", "jira.comment", "jira.get", "jira.search"]);
    expect(after.unmapped).toEqual(["confluence.create", "confluence.search"]);
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

describe("embeddedLinks", () => {
  it("finds the addresses macros keep in attributes and parameters, plain or JSON-escaped", () => {
    const storage = [
      '<ac:structured-macro ac:name="widget"><ac:parameter ac:name="url"><ri:url ri:value="https://www.figma.com/design/K1/Form?node-id=1-2&amp;t=a" /></ac:parameter></ac:structured-macro>',
      '<ac:structured-macro ac:name="figma"><ac:parameter ac:name="url">https://www.figma.com/file/K2/Old?node-id=3%3A4</ac:parameter></ac:structured-macro>',
      '<iframe width="800" src="https://embed.example.com/frame/9"></iframe>',
      '<a href="https://docs.example.com/plain">a plain link</a>',
    ].join("");
    const links = [
      "https://www.figma.com/design/K1/Form?node-id=1-2&t=a",
      "https://www.figma.com/file/K2/Old?node-id=3%3A4",
      "https://embed.example.com/frame/9",
    ];
    expect(embeddedLinks(storage)).toEqual(links);
    expect(embeddedLinks(JSON.stringify({ content: { value: storage + storage } }))).toEqual(links);
    expect(embeddedLinks("<p>nothing embedded</p>")).toEqual([]);
  });
});

describe("jarvis mcp call", () => {
  async function cli(args: string[]) {
    let out = "";
    let err = "";
    const sink = (f: (s: string) => void) =>
      new Writable({
        write(c, _e, cb) {
          f(String(c));
          cb();
        },
      });
    const code = await run(["node", "jarvis", ...args], {
      streams: {
        out: sink((s) => {
          out += s;
        }),
        err: sink((s) => {
          err += s;
        }),
      },
      context: { cwd: sb.project, homeDir: sb.home, env: ENV },
    });
    return { code, out, err };
  }

  it("calls one read capability as an agent would: the header on stderr, the answer alone on stdout", async () => {
    await setup(serverYaml("jira", "      profile: atlassian\n      deny: [jira.transition]"));
    const got = await cli(["mcp", "call", "jira.get", "--arg", "key=ABC-42"]);
    expect(got.code).toBe(0);
    expect(got.err).toMatch(/✓ jira\.get → jira · getJiraIssue · \d+ ms · \d+ bytes/);
    expect(got.err).toContain('sent {"issueKey":"ABC-42"}');
    expect(JSON.parse(got.out)).toMatchObject({ key: "ABC-42", summary: "Allow onboarding restart" });

    // raw: the page with its macros, where an embedded design's address is
    // the text loses the embedded frame; the profile adds its address from the page's macros
    const text = await cli(["mcp", "call", "confluence.get", "--arg", "id=77"]);
    expect(text.err).toContain('"convert_to_markdown":true');
    expect(text.out).toContain("The phone field gets a mask.");
    expect(text.out).toContain(
      "Embedded on the page (frames and macros the text above leaves out):\n- https://www.figma.com/design/AbC123xyz/Order-form?node-id=12-345&t=x",
    );
    const raw = await cli([
      "mcp",
      "call",
      "confluence.get",
      "--arg",
      "id=77",
      "--arg",
      "raw=true",
      "--out",
      "page.json",
    ]);
    expect(raw.err).toContain('"convert_to_markdown":false');
    expect(raw.out).toContain("figma.com/design/AbC123xyz");
    expect(readFileSync(join(sb.project, "page.json"), "utf8")).toContain("ri:url");
  });

  it("refuses effects, denied and unknown capabilities, with why", async () => {
    await setup(serverYaml("jira", "      profile: atlassian\n      deny: [jira.transition]"));
    const effect = await cli(["mcp", "call", "jira.comment", "--arg", "key=ABC-42", "--arg", "body=hi"]);
    expect(effect.code).toBe(1);
    expect(effect.err).toContain("jira.comment is an effect (write): only a run calls it");
    expect((await cli(["mcp", "call", "jira.transition", "--arg", "key=A-1"])).err).toContain(
      'jira.transition is denied on MCP server "jira"',
    );
    expect((await cli(["mcp", "call", "nope.get"])).err).toContain("no MCP server exposes nope.get");
    expect((await cli(["mcp", "call", "jira.get", "--arg", "key"])).err).toContain(
      "--arg key: expected key=value",
    );
  });
});

describe("probe", () => {
  it("a connection of its own: the tools listed, the cache refreshed, a dead server or a silent one an error", async () => {
    await setup(
      `${serverYaml("jira", "      profile: atlassian")}
    silent:
      transport: stdio
      command: node
      args: ["-e", "setInterval(() => {}, 1000)"]
      readOnly: true`,
    );
    const pool = (rt as Runtime).mcp.pool;
    const { entry, ms } = await pool.probe("jira");
    expect(entry.tools.length).toBeGreaterThan(0);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect((rt as Runtime).mcp.provider.report("jira").discovered?.count).toBe(entry.tools.length);
    await expect(pool.probe("silent", 300)).rejects.toThrow("no answer in 0 s");
    await expect(pool.probe("nope")).rejects.toThrow('unknown MCP server "nope"');
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
    expect(result).toEqual({ ok: true, servers: [{ id: "jira", ok: true, tools: 6 }] });
    expect(runtime.mcp.provider.report("jira").discovered).toBeDefined();
    expect(runtime.mcp.provider.report("bb").discovered).toBeUndefined();
  });
});
