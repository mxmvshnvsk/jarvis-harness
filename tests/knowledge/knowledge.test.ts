import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectStacks } from "../../src/capabilities/detector.ts";
import { changedFiles, checkStandards } from "../../src/knowledge/check.ts";
import { globMatches, parseFrontMatter } from "../../src/knowledge/frontmatter.ts";
import { renderPackage } from "../../src/knowledge/package.ts";
import { readByRef, resolvePackage } from "../../src/knowledge/resolver.ts";
import { loadSkills, SkillLoadError } from "../../src/knowledge/skills.ts";
import { loadStandards, parseStandard, StandardLoadError } from "../../src/knowledge/standards.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
const CONFIG = {
  sources: [],
  maxSkills: 2,
  retrieval: { rankAbove: 4 },
  split: { skills: 0.4, standards: 0.35, knowledge: 0.25 },
};

beforeEach(() => {
  sb = sandbox();
});
afterEach(() => {
  sb.cleanup();
});

function std(id: string, extra = "", body = "rule text") {
  sb.write(
    `project/.jarvis/standards/${id}.md`,
    `---\nid: ${id}\ntitle: ${id} title\n${extra}\n---\n${body}\n`,
  );
}
function skill(id: string, yaml: string, instructions = `do ${id}`) {
  sb.write(`project/.jarvis/skills/${id}/skill.yaml`, `id: ${id}\n${yaml}\n`);
  sb.write(`project/.jarvis/skills/${id}/instructions.md`, instructions);
}

describe("front matter and globs", () => {
  it("parses front matter and leaves plain documents alone", () => {
    expect(parseFrontMatter("---\na: 1\n---\nbody")).toEqual({ data: { a: 1 }, body: "body" });
    expect(parseFrontMatter("# plain")).toEqual({ data: {}, body: "# plain" });
  });
  it("matches ** and * and {a,b}", () => {
    expect(globMatches("src/a/b.ts", ["src/**/*.ts"])).toBe(true);
    expect(globMatches("src/b.ts", ["src/**/*.ts"])).toBe(true);
    expect(globMatches("lib/b.ts", ["src/**"])).toBe(false);
    expect(globMatches("src/x.tsx", ["src/*.{ts,tsx}"])).toBe(true);
    expect(globMatches("src/a/x.tsx", ["src/*.{ts,tsx}"])).toBe(false);
  });
});

describe("standards", () => {
  it("requires a check for deterministic verification and an id equal to the file name", () => {
    expect(() =>
      parseStandard(
        "x/STD-1.md",
        "---\nid: STD-1\ntitle: t\nverification: { kind: deterministic }\n---\nr",
        "project",
      ),
    ).toThrow(StandardLoadError);
    expect(() => parseStandard("x/STD-1.md", "---\nid: STD-2\ntitle: t\n---\nr", "project")).toThrow(
      /must equal the file name/,
    );
    const ok = parseStandard(
      "x/STD-1.md",
      "---\nid: STD-1\ntitle: t\nverification: { kind: hybrid, check: { tool: project.lint } }\n---\nr",
      "project",
    );
    expect(ok).toMatchObject({
      id: "STD-1",
      severity: "required",
      verification: { kind: "hybrid" },
      rule: "r",
    });
  });

  it("loads project standards over user ones; user standards are never required", () => {
    std("A", "severity: required");
    sb.write("home/.jarvis/standards/A.md", "---\nid: A\ntitle: user A\n---\nmine");
    sb.write("home/.jarvis/standards/B.md", "---\nid: B\ntitle: user B\nseverity: required\n---\nmine");
    const all = loadStandards({ projectRoot: sb.project, userRoot: join(sb.home, ".jarvis") });
    expect(all.map((s) => [s.id, s.level, s.severity])).toEqual([
      ["A", "project", "required"],
      ["B", "user", "recommended"],
    ]);
  });

  it("checks pattern must / mustNot and tool checks", async () => {
    std(
      "no-console",
      "scope: { paths: ['src/**'] }\nverification:\n  kind: deterministic\n  check: { pattern: { glob: 'src/**/*.ts', mustNot: 'console\\.log' } }",
    );
    std(
      "header",
      "severity: recommended\nverification:\n  kind: deterministic\n  check: { pattern: { glob: 'src/**/*.ts', must: '^// SPDX' } }",
    );
    std("lint", "verification:\n  kind: hybrid\n  check: { tool: project.lint }");
    std("sem", "", "semantic only");
    mkdirSync(join(sb.project, "src"), { recursive: true });
    writeFileSync(join(sb.project, "src", "a.ts"), "// SPDX\nconsole.log(1);\n");
    writeFileSync(join(sb.project, "src", "b.ts"), "export {};\n");
    const standards = loadStandards({ projectRoot: sb.project });
    const calls: string[] = [];
    const report = await checkStandards({
      standards,
      workspace: sb.project,
      files: ["src/a.ts", "src/b.ts", "README.md"],
      runTool: async (cap) => {
        calls.push(cap);
        return { ok: false, text: "lint errors" };
      },
    });
    expect(calls).toEqual(["project.lint"]);
    expect(report.checked).toEqual(["standard:header@1", "standard:lint@1", "standard:no-console@1"]);
    expect(report.violations).toEqual([
      {
        standardId: "header",
        version: 1,
        severity: "recommended",
        file: "src/b.ts",
        detail: "missing required pattern /^// SPDX/",
      },
      { standardId: "lint", version: 1, severity: "required", detail: "project.lint failed:\nlint errors" },
      {
        standardId: "no-console",
        version: 1,
        severity: "required",
        file: "src/a.ts",
        line: 2,
        detail: "forbidden pattern /console\\.log/: console.log(1);",
      },
    ]);
    const noTools = await checkStandards({ standards, workspace: sb.project, files: ["src/b.ts"] });
    expect(noTools.skipped).toEqual([
      { standard: "standard:lint@1", reason: "tool checks need a run context" },
    ]);
  });

  it("judges a forbidden pattern on the lines a change adds, not the legacy lines of a touched file (pilot)", async () => {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (args: string[]) => execFileSync("git", args, { cwd: sb.project, env, encoding: "utf8" });
    std(
      "no-truthy",
      "verification:\n  kind: deterministic\n  check: { pattern: { glob: '**/*.test.ts', mustNot: '\\.toBeTruthy\\(' } }",
    );
    std(
      "no-truthy-anywhere",
      "severity: recommended\nverification:\n  kind: deterministic\n  check: { pattern: { glob: '**/*.test.ts', mustNot: '\\.toBeTruthy\\(', lines: all } }",
    );
    mkdirSync(join(sb.project, "src"), { recursive: true });
    writeFileSync(join(sb.project, "src", "old.test.ts"), "expect(a).toBeTruthy();\nexpect(b).toBe(true);\n");
    git(["init", "-q", "-b", "main"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "legacy"]);
    const base = git(["rev-parse", "HEAD"]).trim();
    // the change touches the legacy test file and adds one bad line, plus a new untracked file
    writeFileSync(
      join(sb.project, "src", "old.test.ts"),
      "expect(a).toBeTruthy();\nexpect(b).toBe(true);\nexpect(c).toBeTruthy();\n",
    );
    writeFileSync(join(sb.project, "src", "new.test.ts"), "expect(d).toBeTruthy();\n");
    const standards = loadStandards({ projectRoot: sb.project });
    const files = await changedFiles(sb.project, base);
    expect(files).toEqual(expect.arrayContaining(["src/old.test.ts", "src/new.test.ts"]));
    const report = await checkStandards({ standards, workspace: sb.project, files, baseRef: base });
    const at = (id: string) =>
      report.violations
        .filter((v) => v.standardId === id)
        .map((v) => `${v.file}:${v.line}`)
        .sort();
    expect(at("no-truthy")).toEqual(["src/new.test.ts:1", "src/old.test.ts:3"]);
    expect(at("no-truthy-anywhere")).toEqual(["src/new.test.ts:1", "src/old.test.ts:1", "src/old.test.ts:3"]);
    // without a base every line is judged, as before
    const whole = await checkStandards({ standards, workspace: sb.project, files });
    expect(whole.violations.filter((v) => v.standardId === "no-truthy")).toHaveLength(3);
  });
});

describe("skills and the resolver", () => {
  it("loads project skills over built-ins and rejects incomplete ones", () => {
    skill("sdd-implementation", "version: 3", "project way");
    skill(
      "aspnet-endpoint-change",
      "appliesTo: { stacks: [aspnet], paths: ['src/**/Api/**'] }\nrequiredStandards: ['STD-ASPNET-*']",
    );
    const skills = loadSkills({ projectRoot: sb.project });
    expect(skills.find((s) => s.id === "sdd-implementation")).toMatchObject({
      version: 3,
      level: "project",
      instructions: "project way",
    });
    expect(
      skills
        .filter((s) => s.level === "builtin")
        .map((s) => s.id)
        .sort(),
    ).toEqual(["refactor", "unit-testing"]);
    sb.write("project/.jarvis/skills/broken/skill.yaml", "id: broken\n");
    expect(() => loadSkills({ projectRoot: sb.project })).toThrow(SkillLoadError);
  });

  it("selects by stack, paths, kind and agent, deterministically, with required standards pulled in", () => {
    skill(
      "aspnet-endpoint-change",
      "appliesTo: { stacks: [aspnet], paths: ['src/**/Api/**'] }\nrequiredStandards: ['STD-ASPNET-*']",
    );
    skill("ef-repository-change", "appliesTo: { stacks: [aspnet], paths: ['src/**/Data/**'] }");
    skill("py-thing", "appliesTo: { stacks: [python] }");
    skill("csharp-generic", "appliesTo: { stacks: [csharp] }");
    std("STD-ASPNET-01", "scope: { stacks: [aspnet] }");
    std("STD-ASPNET-02", "scope: { paths: ['nowhere/**'] }");
    std("STD-SEC-01", "severity: recommended");
    std("STD-PY-01", "scope: { stacks: [python] }");
    sb.write("project/.jarvis/knowledge/domain.md", "---\ntags: [orders]\n---\nOrders domain");
    sb.write("project/.jarvis/knowledge/python.md", "---\nstacks: [python]\n---\nnope");
    const task = {
      kind: "change",
      affectedPaths: ["src/Orders/Api/OrdersController.cs"],
      stacks: ["csharp", "aspnet"],
      agentId: "implementation",
    };
    const pkg = resolvePackage({ roots: { projectRoot: sb.project }, config: CONFIG, task });
    // most specific first (stack + path beats stack only), capped at maxSkills
    expect(pkg.skills.map((s) => s.id)).toEqual(["aspnet-endpoint-change", "csharp-generic"]);
    expect(pkg.deferredSkills.map((s) => s.id)).toEqual(["sdd-implementation", "unit-testing"]);
    // required pulled by the skill even when its own scope does not match (02); required before recommended
    expect(pkg.standards.map((s) => s.id)).toEqual(["STD-ASPNET-01", "STD-ASPNET-02", "STD-SEC-01"]);
    expect(pkg.knowledge.map((k) => k.name)).toEqual(["domain.md"]);
    expect(pkg.provenance).toEqual([
      "skill:aspnet-endpoint-change@1",
      "skill:csharp-generic@1",
      "standard:STD-ASPNET-01@1",
      "standard:STD-ASPNET-02@1",
      "standard:STD-SEC-01@1",
      expect.stringMatching(/^knowledge:domain\.md#[0-9a-f]{12}$/),
    ]);
    const again = resolvePackage({ roots: { projectRoot: sb.project }, config: CONFIG, task });
    expect(again.provenance).toEqual(pkg.provenance);

    // before impact analysis nothing is known about paths: path-scoped items stay in
    const early = resolvePackage({
      roots: { projectRoot: sb.project },
      config: CONFIG,
      task: { ...task, affectedPaths: [] },
    });
    expect(early.standards.map((s) => s.id)).toContain("STD-ASPNET-02");
    // another agent gets no implementation skills
    const review = resolvePackage({
      roots: { projectRoot: sb.project },
      config: CONFIG,
      task: { ...task, agentId: "review" },
    });
    expect(review.skills).toEqual([]);
    expect(review.standards.map((s) => s.id)).toEqual(["STD-ASPNET-01", "STD-SEC-01"]);
  });

  it("renders within budget and lists the rest as available on request; knowledge.read serves it", () => {
    skill("big", "", "x".repeat(5000));
    skill("small", "", "small procedure");
    std("S1", "", "short rule");
    sb.write("project/.jarvis/knowledge/k.md", "knowledge body");
    const roots = { projectRoot: sb.project };
    const pkg = resolvePackage({
      roots,
      config: { ...CONFIG, maxSkills: 3 },
      task: { kind: "change", affectedPaths: [], stacks: [], agentId: "implementation" },
    });
    const text = renderPackage(pkg, 2000, CONFIG);
    expect(text).toContain("## Skill big@1");
    expect(text).toContain("truncated");
    expect(text).toContain("## Skill small@1\nsmall procedure");
    expect(text).toContain("## Skill sdd-implementation@1");
    expect(text).toContain("# Available on request (knowledge.read <ref>)\n- skill:unit-testing@1");
    expect(text).toContain("## Standard S1@1 — S1 title [required; checked in review]\nshort rule");
    expect(text).toContain("## Knowledge k.md\nknowledge body");
    expect(readByRef(roots, "skill:small@1")).toBe("# Skill small@1\nsmall procedure");
    expect(readByRef(roots, "standard:S1@1")).toContain("# Standard S1@1 — S1 title [required]");
    expect(readByRef(roots, "knowledge:k.md")).toBe("# Knowledge k.md\nknowledge body");
    expect(readByRef(roots, "standard:nope")).toBeUndefined();
  });
});

describe("stack detection", () => {
  it("detects node/typescript/react and dotnet", () => {
    sb.write(
      "project/package.json",
      JSON.stringify({ dependencies: { react: "19" }, devDependencies: { typescript: "5" } }),
    );
    expect(detectStacks(sb.project)).toEqual(["node", "react", "typescript"]);
    sb.write("project/Acme.sln", "");
    expect(detectStacks(sb.project)).toEqual(["csharp", "dotnet", "node", "react", "typescript"]);
  });
});
