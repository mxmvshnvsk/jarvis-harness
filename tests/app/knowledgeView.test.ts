import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addGlossaryTerm,
  checkSymbols,
  docsOf,
  GlossaryTermTaken,
  glossaryOf,
  skillsOf,
  usageOf,
} from "../../src/app/knowledgeView.ts";
import { createRuntime } from "../../src/app/runtime.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { MODULE_MARKER } from "../../src/onboarding/render.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** What the Knowledge pages show: documents, skills, the glossary and its check against the code. */
let sb: Sandbox;
const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: sb.project, encoding: "utf8", env: { ...process.env, ...gitEnv } });
const put = (rel: string, text: string) => sb.write(`project/${rel}`, text);
const roots = () => ({
  projectRoot: sb.project,
  userRoot: sb.home,
  sources: [
    {
      path: "documentation",
      include: ["**/*.md"],
      exclude: [],
      skills: ["SKILL_*.md"],
      scopes: {},
      agents: ["implementation"],
    },
  ],
});
const GLOSSARY = `# Glossary

Intro.

| термин | синонимы | символы/модули | источники | обновлено | определение |
| --- | --- | --- | --- | --- | --- |
| заказ | order, purchase | \`OrderService\`, \`src/orders\` | CONF-1 | 2026-10-01 | Покупка клиента |
| корзина | cart, purchase | \`CartLegacy\` | | 2026-10-01 | Товары до заказа |

Notes after the table.
`;

beforeEach(() => {
  sb = sandbox();
  put("src/orders/OrderService.ts", "export class OrderService {}\nexport const phoneMask = 1;\n");
  put("src/orders/order.md", "CartLegacy is mentioned only in a document\n");
  put("package.json", '{ "dependencies": { "@acme/ui-kit": "1.0.0" } }\n');
  put(".jarvis/knowledge/glossary.md", GLOSSARY);
  put(
    ".jarvis/knowledge/orders.md",
    '---\npaths: ["src/orders/**"]\ntags: [domain]\n---\n# Orders\n\n## Totals\n\nRounded once.\n',
  );
  put(
    ".jarvis/knowledge/module-api.md",
    `---\ntags: [module]\npaths: ["src/api/**"]\n---\n${MODULE_MARKER}\n# Module src/api\n`,
  );
  put("documentation/orders/overview.md", "# Orders overview\n\nText.\n");
  put("documentation/orders/SKILL_unit-testing.md", "# Unit tests here\n\n1. Next to the code.\n");
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});
afterEach(() => sb.cleanup());

describe("knowledge as the pages show it", () => {
  it("documents: own and the team's, generated, sections, edited and may-be-stale", async () => {
    put("src/orders/OrderService.ts", "export class OrderService { total() {} }\n");
    git("commit", "-q", "-am", "orders: totals");
    const docs = await docsOf(roots());
    expect(docs.map((d) => d.path)).toEqual([
      ".jarvis/knowledge/module-api.md",
      ".jarvis/knowledge/orders.md",
      "documentation/orders/overview.md",
    ]);
    const orders = docs.find((d) => d.name === "orders.md");
    expect(orders?.sections.map((s) => s.heading)).toContain("Totals");
    expect(orders?.staleCommits).toBe(1);
    expect(orders?.edited).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(docs.find((d) => d.name === "module-api.md")?.generated).toBe(true);
    expect(docs.find((d) => d.source)?.title).toBe("Orders overview");
  });

  it("skills: a documentation skill that takes a built-in id overrides it, and the built-in shows as such", () => {
    const skills = skillsOf(roots());
    const own = skills.find((s) => s.skill.id === "unit-testing" && !s.overridden);
    expect(own).toMatchObject({
      origin: "source",
      overrides: true,
      path: "documentation/orders/SKILL_unit-testing.md",
    });
    expect(skills.find((s) => s.skill.id === "unit-testing" && s.overridden)?.origin).toBe("builtin");
  });

  it("symbols against the code: names as words in code (not in documents), paths, packages", async () => {
    const c = await checkSymbols(sb.project, [
      "OrderService",
      "CartLegacy",
      "phoneMask()",
      "src/orders",
      "orders/OrderService.ts",
      "@acme/ui-kit",
      "@acme/nothing",
      "Order",
    ]);
    expect(c.get("OrderService")).toMatchObject({ found: true, where: "src/orders/OrderService.ts:1" });
    expect(c.get("CartLegacy")?.found).toBe(false);
    expect(c.get("phoneMask")?.found).toBe(true);
    expect(c.get("src/orders")).toMatchObject({ found: true, where: "src/orders" });
    expect(c.get("orders/OrderService.ts")?.found).toBe(true);
    expect(c.get("@acme/ui-kit")?.found).toBe(true);
    expect(c.get("@acme/nothing")?.found).toBe(false);
    // a word, not a part of one
    expect(c.get("Order")?.found).toBe(false);
  });

  it("the glossary with its problems; a new term goes after the last row, in the table's columns", async () => {
    const g = await glossaryOf(sb.project);
    const cart = g.rows.find((r) => r.term === "корзина");
    expect(cart?.problems).toContain("CartLegacy is not in the code");
    expect(cart?.problems).toContain("«purchase» is also a synonym of «заказ»");
    expect(g.rows.find((r) => r.term === "заказ")?.updated).toBe("2026-10-01");

    addGlossaryTerm(
      sb.project,
      { term: "форма", synonyms: ["form"], symbols: ["FormField"], sources: [], definition: "Экран | ввода" },
      new Date("2026-10-07T10:00:00Z"),
    );
    const text = readFileSync(join(sb.project, ".jarvis/knowledge/glossary.md"), "utf8");
    expect(text).toContain(
      "| корзина | cart, purchase | `CartLegacy` | | 2026-10-01 | Товары до заказа |\n| форма | form | `FormField` |  | 2026-10-07 | Экран / ввода |\n\nNotes after the table.",
    );
    expect(() =>
      addGlossaryTerm(sb.project, { term: "Форма", synonyms: [], symbols: [], sources: [] }),
    ).toThrow(GlossaryTermTaken);
  });

  it("use in runs: from the context packages of agent calls and explicit knowledge.read", async () => {
    const rt = createRuntime(await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} }), { env: {} });
    try {
      rt.events.emit({
        kind: "agent.start",
        runId: "run_aaaaaaaa1",
        payload: { knowledge: ["knowledge:orders.md#abc", "skill:unit-testing@1"] },
      });
      rt.events.emit({
        kind: "agent.start",
        runId: "run_aaaaaaaa2",
        payload: { knowledge: ["knowledge:orders.md#abd"] },
      });
      rt.events.emit({
        kind: "tool.call",
        runId: "run_aaaaaaaa2",
        payload: { capability: "knowledge.read", args: '{"ref":"skill:unit-testing@1"}' },
      });
      const u = usageOf(rt);
      expect(u.get("knowledge:orders.md")).toMatchObject({ calls: 2, runs: 2 });
      expect(u.get("skill:unit-testing")).toMatchObject({ calls: 1, asked: 1 });
    } finally {
      await rt.close();
    }
  });
});
