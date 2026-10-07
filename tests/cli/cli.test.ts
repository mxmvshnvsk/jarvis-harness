import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.ts";
import { PROJECT_CONFIG, type Sandbox, sandbox, USER_CONFIG } from "../helpers/tmp.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => {
  sb.cleanup();
});

function capture() {
  let out = "";
  let err = "";
  const streams = {
    out: new Writable({
      write(chunk, _enc, cb) {
        out += String(chunk);
        cb();
      },
    }),
    err: new Writable({
      write(chunk, _enc, cb) {
        err += String(chunk);
        cb();
      },
    }),
  };
  return { streams, out: () => out, err: () => err };
}

async function jarvis(args: string[], env: NodeJS.ProcessEnv = {}) {
  const c = capture();
  const code = await run(["node", "jarvis", ...args], {
    streams: c.streams,
    context: { cwd: sb.project, homeDir: sb.home, env: { PATH: process.env.PATH ?? "", ...env } },
  });
  return { code, out: c.out(), err: c.err() };
}

describe("jarvis init", () => {
  it("creates the user home, the database and the project skeleton", async () => {
    const r = await jarvis(["init"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(sb.home, ".jarvis", "config.yaml"))).toBe(true);
    expect(existsSync(join(sb.home, ".jarvis", "jarvis.db"))).toBe(true);
    expect(existsSync(join(sb.project, ".jarvis", "project.yaml"))).toBe(true);
    expect(existsSync(join(sb.project, ".jarvis", "knowledge", "README.md"))).toBe(true);
    expect(readFileSync(join(sb.project, ".gitignore"), "utf8")).toContain(".jarvis/runs/");
    expect(r.out).toContain("schema v5");
  });

  it("is idempotent and reports existing files", async () => {
    await jarvis(["init"]);
    const r = await jarvis(["--json", "init"]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as { created: string[]; skipped: string[] };
    expect(report.created).toEqual([]);
    expect(report.skipped.length).toBeGreaterThan(5);
  });
});

describe("jarvis doctor", () => {
  it("passes on a fresh init with warnings about missing models", async () => {
    await jarvis(["init"]);
    const r = await jarvis(["doctor"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("OK    node");
    expect(r.out).toContain("0 model(s)");
    expect(r.out).toContain("egress: dataClass=confidential");
  });

  it("fails with exit 1 and names the file on a literal secret", async () => {
    sb.write("home/.jarvis/config.yaml", USER_CONFIG.replace("env:CORP_LLM_TOKEN", "sk-literal"));
    sb.write("project/.jarvis/project.yaml", PROJECT_CONFIG);
    const r = await jarvis(["doctor"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL  config");
    expect(r.out).toContain("literal secrets are not allowed");
    expect(r.out).toMatch(/\[user:.*config\.yaml\]/);
  });

  it("reports secrets, egress and the profile in --json", async () => {
    sb.write("home/.jarvis/config.yaml", USER_CONFIG);
    sb.write("project/.jarvis/project.yaml", PROJECT_CONFIG);
    const r = await jarvis(["--json", "--profile", "ci", "doctor"], { CORP_LLM_TOKEN: "x" });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as {
      checks: { id: string; status: string; detail: string }[];
      egress: string;
    };
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId["secret:env:CORP_LLM_TOKEN"]?.status).toBe("ok");
    expect(byId["secret:keychain:anthropic"]?.status).toBe("warn");
    expect(byId["egress:model:claude"]?.status).toBe("warn");
    expect(byId.config?.detail).toContain("profile ci");
    expect(report.egress).toContain("dataClass=internal");
    expect(report.egress).toContain("1 of 2 allowed");
  });
});

describe("jarvis config show", () => {
  it("prints values with sources", async () => {
    sb.write("home/.jarvis/config.yaml", USER_CONFIG);
    sb.write("project/.jarvis/project.yaml", PROJECT_CONFIG);
    const r = await jarvis(["config", "show", "--sources"], {
      JARVIS_MODELS__DEEPSEEK_FLASH__MAXOUTPUT: "4096",
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/dataClass\s+= "internal"\s+\[project:/);
    expect(r.out).toMatch(
      /models\.deepseek-flash\.maxOutput\s+= 4096\s+\[env:JARVIS_MODELS__DEEPSEEK_FLASH__MAXOUTPUT\]/,
    );
    expect(r.out).toMatch(/humanGate\s+= "artifact"\s+\[default\]/);
  });

  it("emits JSON with config and sources", async () => {
    sb.write("project/.jarvis/project.yaml", "version: 1\n");
    const r = await jarvis(["--json", "config", "show"]);
    const parsed = JSON.parse(r.out) as { config: { dataClass: string }; sources: Record<string, string> };
    expect(parsed.config.dataClass).toBe("confidential");
    expect(parsed.sources.version).toBe("default");
  });

  it("returns exit 1 with the issue list on invalid configuration", async () => {
    sb.write("project/.jarvis/project.yaml", "version: 1\ndataClass: top-secret\n");
    const r = await jarvis(["config", "show"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("dataClass");
  });
});

describe("jarvis db", () => {
  it("reports status and migrates", async () => {
    const before = await jarvis(["--json", "db", "status"]);
    expect(JSON.parse(before.out)).toMatchObject({
      exists: false,
      schemaVersion: 0,
      pending: [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }],
    });
    const migrate = await jarvis(["--json", "db", "migrate"]);
    expect(JSON.parse(migrate.out)).toMatchObject({
      schemaVersion: 5,
      applied: ["1-init", "2-interactions", "3-project_graph", "4-retrieval", "5-run_options"],
    });
    const after = await jarvis(["--json", "db", "status"]);
    expect(JSON.parse(after.out)).toMatchObject({ exists: true, schemaVersion: 5, pending: [] });
  });
});
