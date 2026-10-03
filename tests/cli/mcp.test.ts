import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

const FIXTURE = join(import.meta.dirname, "..", "helpers", "fakeMcpServer.ts");
let sb: Sandbox;
const ENV = { PATH: process.env.PATH ?? "", JARVIS_KEYCHAIN_BACKEND: "file" };

beforeEach(() => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
  sb.write(
    "project/.jarvis/project.yaml",
    `version: 1
dataClass: internal
workspace: { mode: cwd }
mcp:
  servers:
    jira:
      transport: stdio
      command: node
      args: ["${FIXTURE}"]
      env: { JIRA_TOKEN: "keychain:jira" }
      profile: atlassian
      deny: [jira.transition]
    raw:
      transport: stdio
      command: node
      args: ["${FIXTURE}"]
    broken:
      transport: stdio
      command: node
      args: ["-e", "process.exit(2)"]
      readOnly: true
`,
  );
});

afterEach(() => {
  sb.cleanup();
});

async function jarvis(args: string[], stdin?: string, env: NodeJS.ProcessEnv = {}) {
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
    ...(stdin !== undefined ? { stdin: Readable.from([stdin]) } : {}),
    context: { cwd: sb.project, homeDir: sb.home, env: { ...ENV, ...env } },
  });
  return { code, out, err };
}

describe("jarvis auth", () => {
  it("stores, reports and removes credentials without printing values", async () => {
    const status0 = await jarvis(["--json", "auth", "status"]);
    expect(status0.code).toBe(0);
    const s0 = JSON.parse(status0.out) as { rows: Array<{ ref: string; set: boolean }>; backend: string };
    expect(s0.backend).toBe("file");
    expect(s0.rows).toEqual([
      { ref: "keychain:jira", kind: "keychain", set: false, usedBy: ["mcp.servers.jira.env.JIRA_TOKEN"] },
    ]);

    const set = await jarvis(["auth", "set", "jira"], "very-secret-token-value\n");
    expect(set.code).toBe(0);
    expect(set.out).toContain("stored keychain:jira for me@corp (file)");
    expect(set.out).not.toContain("very-secret");
    const file = join(sb.home, ".jarvis", "credentials.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "me@corp/jira": "very-secret-token-value" });

    const status1 = await jarvis(["auth", "status"]);
    expect(status1.out).toContain("keychain:jira  set");
    expect(status1.out).not.toContain("very-secret");

    const removed = await jarvis(["auth", "remove", "jira"]);
    expect(removed.code).toBe(0);
    const again = await jarvis(["auth", "remove", "jira"]);
    expect(again.code).toBe(1);
  });

  it("rejects an empty value", async () => {
    const set = await jarvis(["auth", "set", "jira"], "");
    expect(set.code).toBe(1);
    expect(set.err).toContain("empty value");
  });
});

describe("jarvis mcp list", () => {
  it("shows servers from config, then discovery results after --refresh", async () => {
    const before = await jarvis(["--json", "mcp", "list"]);
    expect(before.code).toBe(0);
    const b = JSON.parse(before.out) as { servers: Array<Record<string, unknown>> };
    expect(b.servers.map((s) => s.id)).toEqual(["broken", "jira", "raw"]);
    const jira = b.servers.find((s) => s.id === "jira") as Record<string, unknown>;
    expect(jira.profile).toBe("atlassian");
    expect(jira.discovered).toBeUndefined();
    expect(jira.exposed).toEqual([
      "confluence.create",
      "confluence.get",
      "confluence.search",
      "jira.comment",
      "jira.get",
      "jira.search",
    ]);

    await jarvis(["auth", "set", "jira"], "tok-tok-tok-tok\n");
    const after = await jarvis(["--json", "mcp", "list", "--refresh"]);
    expect(after.code).toBe(1); // `broken` is unavailable
    const a = JSON.parse(after.out) as { servers: Array<Record<string, unknown>> };
    const jira2 = a.servers.find((s) => s.id === "jira") as {
      discovered: { count: number };
      exposed: string[];
      unmapped: string[];
    };
    expect(jira2.discovered.count).toBe(5);
    expect(jira2.exposed).toEqual(["jira.comment", "jira.get", "jira.search"]);
    expect(jira2.unmapped).toEqual(["confluence.create", "confluence.get", "confluence.search"]);
    const raw = a.servers.find((s) => s.id === "raw") as { notAllowed: string[]; exposed: string[] };
    expect(raw.exposed).toEqual([]);
    expect(raw.notAllowed).toEqual([
      "mcp.raw.addCommentToJiraIssue",
      "mcp.raw.echo",
      "mcp.raw.getJiraIssue",
      "mcp.raw.searchJiraIssuesUsingJql",
      "mcp.raw.whoami",
    ]);
    const broken = a.servers.find((s) => s.id === "broken") as { live: { ok: boolean; error: string } };
    expect(broken.live.ok).toBe(false);

    const text = await jarvis(["mcp", "list"]);
    expect(text.out).toContain("discovered, not allowed (add to allow): mcp.raw.addCommentToJiraIssue");
    expect(text.out).toContain("auth: keychain:jira");
  });

  it("doctor reports missing credentials, undiscovered servers and unknown profiles", async () => {
    sb.write(
      "project/.jarvis/project.yaml",
      `version: 1
mcp:
  servers:
    jira:
      transport: http
      url: https://mcp.corp.local/atlassian
      auth: { type: bearer, token: keychain:atlassian }
      profile: atlassian
    odd:
      transport: http
      url: https://mcp.corp.local/odd
      profile: nope
`,
    );
    const doctor = await jarvis(["--json", "doctor"]);
    const report = JSON.parse(doctor.out) as {
      checks: Array<{ id: string; status: string; detail: string }>;
    };
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId["secret:keychain:atlassian"]?.status).toBe("warn");
    expect(byId["secret:keychain:atlassian"]?.detail).toContain("not in the keychain (file)");
    expect(byId["mcp:jira"]?.status).toBe("ok");
    expect(byId["mcp:jira"]?.detail).toContain("never discovered");
    expect(byId["mcp:odd"]?.status).toBe("fail");
    expect(byId["mcp:odd"]?.detail).toContain('unknown MCP profile "nope"');
    expect(byId.keychain?.status).toBe("warn");
  });
});

describe("jarvis work preflight", () => {
  it("refuses to create a run when a required server is unavailable", async () => {
    // The research agent reaches jira.*; its credential is missing → preflight fails before any run exists.
    sb.write(
      "home/.jarvis/config.yaml",
      `version: 1
actor: { id: me@corp }
models:
  flash: { provider: openai-compatible, baseUrl: "http://127.0.0.1:9", model: flash, egress: private, contextWindow: 32000, maxOutput: 2000, supports: { tools: true, jsonMode: true } }
roles: { research: { models: [flash] }, implementation: { models: [flash] }, review: { models: [flash] } }
`,
    );
    const work = await jarvis(["work", "ABC-1", "--no-run"]);
    expect(work.code).toBe(1);
    expect(work.err).toContain('mcp server "jira" is required by workflow sdd but unavailable');
    expect(work.err).toContain("keychain:jira is not set");
    const status = await jarvis(["--json", "status", "--all"]);
    expect(JSON.parse(status.out)).toMatchObject({ runs: [] });
  });
});
