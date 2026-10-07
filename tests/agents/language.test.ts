import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_AGENTS } from "../../src/agents/builtin/index.ts";
import { languageRule, systemLayer } from "../../src/agents/context.ts";
import { loadConfig } from "../../src/core/config/index.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => {
  sb.cleanup();
});

describe("the language agents write in for people (`language`)", () => {
  it("comes from the project over the user and the environment over both", async () => {
    sb.write("home/.jarvis/config.yaml", "version: 1\nlanguage: en\n");
    sb.write("project/.jarvis/project.yaml", "version: 1\nlanguage: ru\n");
    const load = (env: Record<string, string> = {}) => loadConfig({ cwd: sb.project, homeDir: sb.home, env });
    expect((await load()).config.language).toBe("ru");
    expect((await load({ JARVIS_LANGUAGE: "de" })).config.language).toBe("de");
  });

  it("is one rule of the system layer: texts for people in it, keys, code and quotes as they are", () => {
    const research = BUILTIN_AGENTS.find((a) => a.id === "research");
    if (!research) throw new Error("research");
    expect(systemLayer(research, [])).not.toContain("Write every text meant for people");
    const ru = systemLayer(research, [], "ru");
    expect(ru).toContain("Write every text meant for people in Russian");
    expect(ru).toContain("JSON keys and enum values of the output contract");
    expect(languageRule("Português")).toContain("in Português");
  });
});
