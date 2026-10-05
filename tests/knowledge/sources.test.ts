import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeConfigSchema } from "../../src/core/config/schema.ts";
import { loadKnowledgeDocs, readByRef, resolvePackage } from "../../src/knowledge/resolver.ts";
import { loadSkills } from "../../src/knowledge/skills.ts";
import { loadSourceDocuments } from "../../src/knowledge/sources.ts";
import type { KnowledgeRoots } from "../../src/knowledge/standards.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  // a team's documentation layout: documentation/ with overviews and SKILL_ files, AGENTS.md memos
  sb.write("project/documentation/index.md", "# Документация\nКарта документов.\n");
  sb.write(
    "project/documentation/billing/overview.md",
    "# Счета\nСумма счёта хранится в минорных единицах валюты.\n",
  );
  sb.write(
    "project/documentation/billing/SKILL_invoice-events.md",
    "# События счетов: как добавлять\n1. Объяви события в constants.ts рядом с компонентом.\n",
  );
  sb.write("project/documentation/server/how-api-works.md", "# API\nОдин процесс, два HTTP-сервера.\n");
  sb.write("project/documentation/secret/notes.md", "# Secret\nnot for agents\n");
  sb.write("project/documentation/empty.md", "\n");
  sb.write("project/AGENTS.md", "# AGENTS.md\n- Тесты: npx jest <путь>.\n");
  sb.write("project/apps/server/AGENTS.md", "# API memo\n- Логгер бери из ctx.log.\n");
});
afterEach(() => sb.cleanup());

function roots(sources: unknown[]): KnowledgeRoots {
  const config = KnowledgeConfigSchema.parse({ sources });
  return {
    projectRoot: sb.project,
    sources: config.sources,
    isDenied: (rel) => rel.startsWith("documentation/secret/"),
  };
}

const PILOT = [
  {
    path: "documentation",
    skills: ["SKILL_*.md"],
    scopes: {
      "billing/**": ["packages/lib/src/billing/**", "apps/*/src/**/constants.ts"],
      "server/**": ["apps/server/**"],
    },
    agents: ["implementation", "onboard-mapper"],
  },
  "AGENTS.md",
  { path: "apps", include: ["**/AGENTS.md"] },
];

describe("knowledge.sources", () => {
  it("reads documentation in place: scoped knowledge, skills from SKILL_ files, AGENTS.md memos", () => {
    const docs = loadSourceDocuments(roots(PILOT));
    expect(docs.map((d) => [d.path, d.skill, d.paths])).toEqual([
      ["documentation/billing/SKILL_invoice-events.md", true, expect.any(Array)],
      [
        "documentation/billing/overview.md",
        false,
        ["packages/lib/src/billing/**", "apps/*/src/**/constants.ts"],
      ],
      ["documentation/index.md", false, []],
      ["documentation/server/how-api-works.md", false, ["apps/server/**"]],
      // the root memo applies everywhere, a module memo to its module
      ["AGENTS.md", false, []],
      ["apps/server/AGENTS.md", false, ["apps/server/**"]],
    ]);
    // denied paths are never read, empty documents are skipped

    const knowledge = loadKnowledgeDocs(roots(PILOT)).map((d) => d.name);
    expect(knowledge).not.toContain("documentation/billing/SKILL_invoice-events.md");
    expect(knowledge).toContain("documentation/billing/overview.md");

    const skill = loadSkills(roots(PILOT)).find((s) => s.id === "invoice-events");
    expect(skill).toMatchObject({
      title: "События счетов: как добавлять",
      level: "project",
      source: "documentation/billing/SKILL_invoice-events.md",
      appliesTo: { paths: ["packages/lib/src/billing/**", "apps/*/src/**/constants.ts"] },
    });
    expect(skill?.appliesTo.agents).toEqual(["implementation", "onboard-mapper"]);
  });

  it("gives an agent the documents and skills of the paths it works on, and nothing scoped elsewhere", () => {
    const pkg = resolvePackage({
      roots: roots(PILOT),
      config: KnowledgeConfigSchema.parse({ sources: PILOT }),
      task: {
        kind: "change",
        affectedPaths: ["packages/lib/src/billing/"],
        stacks: [],
        agentId: "onboard-mapper",
      },
    });
    const names = pkg.knowledge.map((k) => k.name);
    expect(names).toContain("documentation/billing/overview.md");
    expect(names).toContain("AGENTS.md");
    expect(names).not.toContain("documentation/server/how-api-works.md");
    expect(names).not.toContain("apps/server/AGENTS.md");
    expect(pkg.skills.map((s) => s.id)).toEqual(["invoice-events"]);
    expect(pkg.provenance).toContain("skill:invoice-events@1");
  });

  it("does not let a path-scoped skill displace the general ones while the task's paths are unknown (pilot)", () => {
    const config = KnowledgeConfigSchema.parse({ sources: PILOT });
    const before = resolvePackage({
      roots: roots(PILOT),
      config,
      task: { kind: "change", affectedPaths: [], stacks: [], agentId: "implementation" },
    });
    // before impact analysis: the built-in procedure first, the documentation's skill on request
    expect(before.skills.map((s) => s.id)).toEqual(["sdd-implementation", "unit-testing"]);
    expect(before.deferredSkills.map((s) => s.id)).toContain("invoice-events");
    const after = resolvePackage({
      roots: roots(PILOT),
      config,
      task: {
        kind: "change",
        affectedPaths: ["packages/lib/src/billing/track.ts"],
        stacks: [],
        agentId: "implementation",
      },
    });
    // once impact names the billing code, its skill is the most specific one
    expect(after.skills.map((s) => s.id)[0]).toBe("invoice-events");
  });

  it("serves a document by its path, with or without the knowledge: prefix", () => {
    const r = roots(PILOT);
    expect(readByRef(r, "documentation/billing/overview.md")).toContain("минорных единицах");
    expect(readByRef(r, "knowledge:apps/server/AGENTS.md")).toContain("ctx.log");
    expect(readByRef(r, "skill:invoice-events")).toContain("constants.ts");
    expect(readByRef(r, "documentation/secret/notes.md")).toBeUndefined();
  });

  it("accepts a bare path, skips missing or escaping ones, and is empty without sources", () => {
    expect(KnowledgeConfigSchema.parse({ sources: ["documentation"] }).sources[0]).toEqual({
      path: "documentation",
      include: ["**/*.md"],
      exclude: [],
      skills: [],
      scopes: {},
      agents: [],
    });
    expect(loadSourceDocuments(roots(["nowhere", "../outside", "./AGENTS.md"])).map((d) => d.path)).toEqual([
      "AGENTS.md",
    ]);
    expect(loadSourceDocuments({ projectRoot: sb.project })).toEqual([]);
  });
});
