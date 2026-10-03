import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/core/config/index.ts";
import { PROJECT_CONFIG, type Sandbox, sandbox, USER_CONFIG } from "../helpers/tmp.ts";

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
});

afterEach(() => {
  sb.cleanup();
});

function load(extra: Parameters<typeof loadConfig>[0] = {}) {
  return loadConfig({ cwd: sb.project, homeDir: sb.home, env: {}, ...extra });
}

describe("loadConfig", () => {
  it("falls back to safe defaults when no files exist", async () => {
    const loaded = await load();
    expect(loaded.config.dataClass).toBe("confidential");
    expect(loaded.config.workspace.mode).toBe("worktree");
    expect(loaded.config.humanGate).toBe("artifact");
    expect(loaded.project?.root).toBe(sb.project);
    expect(loaded.warnings.some((w) => w.includes("jarvis init"))).toBe(true);
  });

  it("merges user and project files with project winning and tracks sources", async () => {
    sb.write("home/.jarvis/config.yaml", USER_CONFIG);
    sb.write("project/.jarvis/project.yaml", PROJECT_CONFIG);
    const loaded = await load();
    expect(loaded.config.dataClass).toBe("internal");
    expect(loaded.config.roles.review?.maxOutput).toBe(4096);
    expect(loaded.config.models["deepseek-flash"]?.supports.tools).toBe(true);
    expect(loaded.config.models["deepseek-flash"]?.supports.jsonSchema).toBe(false);
    expect(loaded.sources.dataClass).toMatch(/^project:/);
    expect(loaded.sources["models.deepseek-flash.baseUrl"]).toMatch(/^user:/);
    expect(loaded.sources["roles.research.models"]).toMatch(/^project:/);
    expect(loaded.config.mcp.servers.jira?.network).toBe("intranet");
  });

  it("applies env overrides with case-insensitive path resolution", async () => {
    sb.write("home/.jarvis/config.yaml", USER_CONFIG);
    sb.write("project/.jarvis/project.yaml", PROJECT_CONFIG);
    const loaded = await load({
      env: { JARVIS_MODELS__DEEPSEEK_FLASH__MAXOUTPUT: "4096", JARVIS_ACTOR: "me@corp.local" },
    });
    expect(loaded.config.models["deepseek-flash"]?.maxOutput).toBe(4096);
    expect(loaded.sources["models.deepseek-flash.maxOutput"]).toBe(
      "env:JARVIS_MODELS__DEEPSEEK_FLASH__MAXOUTPUT",
    );
    expect(loaded.config.actor.id).toBe("me@corp.local");
    expect(loaded.sources["actor.id"]).toBe("env:JARVIS_ACTOR");
  });

  it("lets CLI overrides win over everything", async () => {
    sb.write("home/.jarvis/config.yaml", USER_CONFIG);
    sb.write("project/.jarvis/project.yaml", PROJECT_CONFIG);
    const loaded = await load({
      env: { JARVIS_WORKSPACE__SETUP: "from-env" },
      cliOverrides: { workspace: { setup: "from-cli" } },
    });
    expect(loaded.config.workspace.setup).toBe("from-cli");
    expect(loaded.sources["workspace.setup"]).toBe("cli");
  });

  it("rejects literal secrets and names the file", async () => {
    sb.write(
      "home/.jarvis/config.yaml",
      USER_CONFIG.replace("token: env:CORP_LLM_TOKEN", "token: sk-literal-secret-value"),
    );
    await expect(load()).rejects.toMatchObject({
      name: "ConfigError",
      issues: [
        expect.objectContaining({
          path: "models.deepseek-flash.auth.token",
          message: expect.stringContaining("literal secrets are not allowed"),
          source: expect.stringMatching(/^user:/),
        }),
      ],
    });
  });

  it("rejects secret-looking stdio env literals", async () => {
    sb.write(
      "project/.jarvis/project.yaml",
      `version: 1
mcp:
  servers:
    bb:
      transport: stdio
      command: node
      env: { BB_TOKEN: abc123 }
`,
    );
    await expect(load()).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: "mcp.servers.bb.env.BB_TOKEN" })],
    });
  });

  it("rejects unknown keys (typos) strictly", async () => {
    sb.write("project/.jarvis/project.yaml", "version: 1\ndataclass: public\n");
    await expect(load()).rejects.toBeInstanceOf(ConfigError);
  });

  it("refuses a newer configuration version", async () => {
    sb.write("project/.jarvis/project.yaml", "version: 2\n");
    await expect(load()).rejects.toThrow(/newer than this jarvis supports/);
  });

  it("reports unknown models referenced by roles with the source", async () => {
    sb.write("project/.jarvis/project.yaml", "version: 1\nroles:\n  review: { models: [nope] }\n");
    await expect(load()).rejects.toMatchObject({
      issues: [
        expect.objectContaining({
          path: "roles.review.models[0]",
          source: expect.stringMatching(/^project:/),
        }),
      ],
    });
  });

  it("applies a narrowing profile and records it as a source", async () => {
    sb.write("home/.jarvis/config.yaml", USER_CONFIG);
    sb.write("project/.jarvis/project.yaml", PROJECT_CONFIG);
    const loaded = await load({ profile: "ci" });
    expect(loaded.config.profile).toBe("ci");
    expect(loaded.config.interactive).toBe(false);
    expect(loaded.config.workspace.mode).toBe("cwd");
    expect(loaded.config.workspace.allowWrites).toBe(false);
    expect(loaded.config.deniedCapabilities).toEqual(["*.comment", "*.transition"]);
    expect(loaded.sources["workspace.mode"]).toBe("profile:ci");
  });

  it("rejects a profile that lowers the data class", async () => {
    sb.write("home/.jarvis/config.yaml", USER_CONFIG);
    sb.write("project/.jarvis/project.yaml", PROJECT_CONFIG);
    await expect(load({ profile: "looser" })).rejects.toThrow(/may not lower dataClass/);
  });

  it("rejects an env override that lowers the data class", async () => {
    sb.write("home/.jarvis/config.yaml", USER_CONFIG);
    sb.write("project/.jarvis/project.yaml", PROJECT_CONFIG);
    await expect(load({ env: { JARVIS_DATACLASS: "public" } })).rejects.toThrow(/may not be lowered/);
    const raised = await load({ env: { JARVIS_DATACLASS: "confidential" } });
    expect(raised.config.dataClass).toBe("confidential");
  });

  it("picks the profile from JARVIS_PROFILE", async () => {
    sb.write("project/.jarvis/project.yaml", PROJECT_CONFIG);
    sb.write("home/.jarvis/config.yaml", USER_CONFIG);
    const loaded = await load({ env: { JARVIS_PROFILE: "ci" } });
    expect(loaded.config.profile).toBe("ci");
  });
});
