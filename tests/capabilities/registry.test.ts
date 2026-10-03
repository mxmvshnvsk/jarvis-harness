import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../../src/capabilities/registry.ts";
import type { LanguageAdapter } from "../../src/core/capabilities/contracts.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\n");
});
afterEach(() => sb.cleanup());

const fakeTs: LanguageAdapter = {
  id: "typescript",
  languages: ["typescript"],
  async detect(path) {
    const has = (await import("node:fs")).existsSync(join(path, "tsconfig.json"));
    return { detected: has, stacks: has ? ["typescript"] : [], evidence: has ? ["tsconfig.json"] : [] };
  },
  capabilities: () => ["build", "test", "codeIntelligence", "graph"],
  defaultCommands: () => ({ build: "tsc --noEmit", test: "vitest run" }),
};

async function discover(projectYaml: string, adapters: LanguageAdapter[] = []) {
  sb.write("project/.jarvis/project.yaml", projectYaml);
  const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
  const registry = new CapabilityRegistry();
  for (const a of adapters) registry.register(a);
  return registry.discover(loaded.config, sb.project);
}

describe("CapabilityRegistry.discover (ADR-0021 §3, §7)", () => {
  it("is UNSUPPORTED without any project command or adapter", async () => {
    const caps = await discover("version: 1\n");
    expect(caps.level).toBe("UNSUPPORTED");
    expect(caps.capabilities).toMatchObject({
      build: "missing",
      test: "missing",
      codeIntelligence: "missing",
    });
  });

  it("is BASIC with project commands only; explicit stack wins over detection and disagreement is reported", async () => {
    writeFileSync(join(sb.project, "package.json"), "{}");
    const caps = await discover("version: 1\nstack: [csharp]\ntools: { local: { test: 'dotnet test' } }\n");
    expect(caps.level).toBe("BASIC");
    expect(caps.stacks).toEqual(["csharp"]);
    expect(caps.detected).toEqual(["node"]);
    expect(caps.capabilities.test).toBe("project");
    expect(caps.reasons.some((r) => r.includes("disagrees with detection"))).toBe(true);
  });

  it("is FULL with an adapter providing code intelligence and graph; project commands override adapter defaults", async () => {
    writeFileSync(join(sb.project, "tsconfig.json"), "{}");
    const caps = await discover("version: 1\ntools: { local: { test: 'pnpm test' } }\n", [fakeTs]);
    expect(caps.level).toBe("FULL");
    expect(caps.adapters).toEqual([
      {
        id: "typescript",
        capabilities: ["build", "test", "codeIntelligence", "graph"],
        evidence: ["tsconfig.json"],
      },
    ]);
    expect(caps.commands).toEqual({ test: "pnpm test", build: "tsc --noEmit" });
    expect(caps.capabilities).toMatchObject({
      test: "project",
      build: "adapter",
      codeIntelligence: "adapter",
      graph: "adapter",
    });
    expect(caps.reasons).toEqual([]);
  });
});

describe("polyglot scopes (ADR-0021 §9)", () => {
  it("detects per-directory stacks and resolves stacks by affected paths", async () => {
    const { detectStackScopes, stacksForPaths } = await import("../../src/capabilities/detector.ts");
    mkdirSync(join(sb.project, "frontend"), { recursive: true });
    mkdirSync(join(sb.project, "backend"), { recursive: true });
    writeFileSync(
      join(sb.project, "frontend", "package.json"),
      JSON.stringify({ dependencies: { react: "19" }, devDependencies: { typescript: "5" } }),
    );
    writeFileSync(join(sb.project, "backend", "Api.csproj"), "");
    const scopes = detectStackScopes(sb.project);
    expect(scopes).toEqual({
      "frontend/**": ["node", "react", "typescript"],
      "backend/**": ["csharp", "dotnet"],
    });
    expect(stacksForPaths(["backend/Api/Orders.cs"], scopes, ["typescript"])).toEqual(["csharp", "dotnet"]);
    expect(stacksForPaths(["backend/x.cs", "frontend/src/a.tsx"], scopes, [])).toEqual([
      "csharp",
      "dotnet",
      "node",
      "react",
      "typescript",
    ]);
    expect(stacksForPaths(["docs/readme.md"], scopes, ["typescript"])).toEqual(["typescript"]);
    expect(stacksForPaths([], scopes, ["typescript"])).toEqual(["typescript"]);
    expect(detectStackScopes(sb.project, { "svc/**": ["python"] })).toEqual({ "svc/**": ["python"] });

    const caps = await discover("version: 1\ntools: { local: { test: 'true' } }\n", [fakeTs]);
    expect(caps.scopes).toEqual(scopes);
    expect(caps.stacks).toEqual(["csharp", "dotnet", "node", "react", "typescript"]);
    expect(caps.adapters.map((a) => a.id)).toEqual(["typescript"]); // reached through the frontend scope
  });
});
