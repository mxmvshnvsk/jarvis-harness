import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app/runtime.ts";
import { run } from "../../src/cli/main.ts";
import { expandQuery, parseGlossary } from "../../src/knowledge/retrieval/glossary.ts";
import { cosine, splitSections } from "../../src/knowledge/retrieval/index.ts";
import { retrieve } from "../../src/knowledge/retrieval/retriever.ts";
import { rankKnowledge, refreshIndex, search } from "../../src/knowledge/retrieval/service.ts";
import { testRuntime } from "../helpers/engine.ts";
import { type FakeOpenAi, startFakeOpenAi } from "../helpers/fakeOpenAi.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let rt: Runtime | undefined;
let server: FakeOpenAi | undefined;

beforeEach(() => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
  sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
  sb.write(
    "project/.jarvis/knowledge/glossary.md",
    `# Glossary
| термин | синонимы | символы/модули | источники | обновлено |
|---|---|---|---|---|
| повторная регистрация | restart onboarding, re-register | canRestartOnboarding, OnboardingService | CONF-12 | 2026-10-01 |
| заявка | application | Application, applications/ | | |
`,
  );
  sb.write(
    "project/.jarvis/knowledge/onboarding.md",
    "# Onboarding\n\nOnboardingService owns the flow.\n\n## Restart\n\nA rejected application may restart onboarding once; canRestartOnboarding decides.\n",
  );
  sb.write(
    "project/.jarvis/knowledge/payments.md",
    "# Payments\n\nRefunds go through the ledger; never call the gateway twice.\n",
  );
  sb.write("project/.jarvis/knowledge/infra.md", "# Infra\n\nDeploys run on Tuesdays.\n");
  sb.write(
    "project/.jarvis/standards/no-double-refund.md",
    "---\nid: no-double-refund\ntitle: Refund once\n---\nA refund is idempotent per ledger entry.\n",
  );
});

afterEach(async () => {
  await rt?.close();
  rt = undefined;
  await server?.close();
  server = undefined;
  sb.cleanup();
});

describe("glossary", () => {
  it("parses the table and expands queries deterministically", () => {
    const g = parseGlossary(
      "| термин | синонимы | символы | источники | обновлено |\n|---|---|---|---|---|\n| заявка | application | `Application`, applications/ | JIRA-1 | x |\n",
    );
    expect(g).toEqual([
      {
        term: "заявка",
        synonyms: ["application"],
        symbols: ["Application", "applications/"],
        sources: ["JIRA-1"],
      },
    ]);
    const e = expandQuery("Повторная подача заявки после отказа", g);
    expect(e.expansions).toEqual([
      { term: "заявка", added: ["application", "Application", "applications/"] },
    ]);
    expect(e.terms).toEqual(expect.arrayContaining(["повторная", "заявки", "application", "applications/"]));
    expect(expandQuery("nothing here", g).expansions).toEqual([]);
  });
  it("splits documents into heading sections", () => {
    expect(splitSections("# A\n\ntext\n\n## B\n\nmore").map((s) => s.heading)).toEqual(["A", "B"]);
    expect(splitSections("plain")).toEqual([{ body: "plain" }]);
  });
});

describe("lexical index (ADR-0015 v0.1)", () => {
  it("indexes units incrementally, finds across the language gap through the glossary, prunes removed units", async () => {
    rt = await testRuntime(sb);
    const roots = { projectRoot: sb.project, userRoot: join(sb.home, ".jarvis") };
    const first = await refreshIndex(rt, roots);
    expect(first).toMatchObject({ indexed: 8, unchanged: 0, removed: 0, embedded: 0 }); // 4 sections + 1 standard + 3 built-in skills
    const counts = rt.index.count();
    expect(counts.units).toBeGreaterThanOrEqual(6);
    const again = await refreshIndex(rt, roots);
    expect(again.indexed).toBe(0);
    expect(again.unchanged).toBe(first.indexed + first.unchanged);

    // Russian business language → English code through the glossary (ADR-0015 §3)
    const r = await search(rt, roots, "повторная регистрация после отказа");
    expect(r.expansions.map((x) => x.term)).toEqual(["повторная регистрация"]);
    expect(r.evidence[0]?.ref).toBe("knowledge:onboarding.md");
    expect(r.evidence[0]?.title).toBe("onboarding.md — Restart");
    expect(r.evidence[0]?.retrievalPath).toEqual([{ index: "lexical", rank: 1 }]);
    expect(r.indexes).toEqual(["lexical"]);

    const refund = await search(rt, roots, "refund ledger", { kinds: ["standard"] });
    expect(refund.evidence.map((e) => e.ref)).toEqual(["standard:no-double-refund@1"]);

    // a changed section is re-indexed, a removed document pruned
    sb.write("project/.jarvis/knowledge/infra.md", "# Infra\n\nDeploys run on Fridays.\n");
    writeFileSync(join(sb.project, ".jarvis", "knowledge", "payments.md"), "");
    const third = await refreshIndex(rt, roots);
    expect(third.indexed).toBe(1);
    expect(third.removed).toBe(1);
    expect((await search(rt, roots, "Fridays")).evidence[0]?.ref).toBe("knowledge:infra.md");
  });
});

describe("hybrid retrieval with an embedder (ADR-0015 §4–5)", () => {
  it("fuses lexical and semantic lists by reciprocal rank and embeds only new versions", async () => {
    server = await startFakeOpenAi();
    // a toy embedder: vector = counts of a few concept words, so "refund" and "ledger" are neighbours
    const concepts = ["refund", "ledger", "onboarding", "restart", "deploy"];
    const embeddingCalls: string[][] = [];
    server.respond((req) => {
      if (!req.url.endsWith("/embeddings"))
        return { status: 500, body: { error: { message: "unexpected" } } };
      const input = (req.body.input as string[]).map(String);
      embeddingCalls.push(input);
      return {
        body: {
          data: input.map((text, index) => ({
            index,
            embedding: concepts.map(
              (c) =>
                text.toLowerCase().split(c).length - 1 + (c === "refund" && /money back/i.test(text) ? 1 : 0),
            ),
          })),
        },
      };
    });
    sb.write(
      "home/.jarvis/config.yaml",
      `version: 1\nactor: { id: me@corp }\nmodels:\n  embed: { provider: openai-compatible, baseUrl: ${server.baseUrl}, model: e5, egress: private, contextWindow: 512, maxOutput: 1 }\n`,
    );
    sb.write(
      "project/.jarvis/project.yaml",
      "version: 1\nworkspace: { mode: cwd }\nknowledge: { retrieval: { embeddings: embed } }\n",
    );
    rt = await testRuntime(sb);
    expect(rt.embedder?.id).toBe("openai-compatible:embed:e5");
    const roots = { projectRoot: sb.project, userRoot: join(sb.home, ".jarvis") };
    const first = await refreshIndex(rt, roots);
    expect(first.embedded).toBe(first.indexed);
    expect(embeddingCalls).toHaveLength(1);
    await refreshIndex(rt, roots);
    expect(embeddingCalls).toHaveLength(1); // nothing new → no embedding calls

    // "money back" has no lexical hit at all; the toy embedder maps it next to refunds
    const r = await retrieve(rt.index, "money back", {
      embedder: rt.embedder as NonNullable<typeof rt.embedder>,
      limit: 3,
    });
    expect(r.indexes).toEqual(["lexical", "semantic"]);
    expect(r.evidence[0]?.retrievalPath).toEqual([{ index: "semantic", rank: 1 }]);
    expect(["knowledge:payments.md", "standard:no-double-refund@1"]).toContain(r.evidence[0]?.ref);

    // a query both indexes agree on ranks first with two paths
    const both = await retrieve(rt.index, "refund ledger", {
      embedder: rt.embedder as NonNullable<typeof rt.embedder>,
      limit: 3,
    });
    expect(both.evidence[0]?.retrievalPath.map((p) => p.index).sort()).toEqual(["lexical", "semantic"]);
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });
});

describe("knowledge ranking for agents (ADR-0015 §2, ADR-0020 §3)", () => {
  it("orders matching documents by retrieval once more than rankAbove match, dropping none", async () => {
    sb.write(
      "project/.jarvis/project.yaml",
      "version: 1\nworkspace: { mode: cwd }\nknowledge: { retrieval: { rankAbove: 2 } }\n",
    );
    rt = await testRuntime(sb);
    const roots = { projectRoot: sb.project, userRoot: join(sb.home, ".jarvis") };
    await refreshIndex(rt, roots);
    const docs = [
      { name: "infra.md", text: "", sha: "1", scope: { stacks: [], paths: [], agents: [] }, tags: [] },
      { name: "payments.md", text: "", sha: "2", scope: { stacks: [], paths: [], agents: [] }, tags: [] },
      { name: "onboarding.md", text: "", sha: "3", scope: { stacks: [], paths: [], agents: [] }, tags: [] },
      { name: "glossary.md", text: "", sha: "4", scope: { stacks: [], paths: [], agents: [] }, tags: [] },
    ];
    const ranked = await rankKnowledge(rt, roots, docs, "ABC-1 повторная регистрация заявки");
    expect(ranked.docs.map((d) => d.name)[0]).toBe("onboarding.md");
    expect(ranked.docs).toHaveLength(4);
    const few = await rankKnowledge(rt, roots, docs.slice(0, 2), "anything");
    expect(few.result).toBeUndefined();
    expect(few.docs.map((d) => d.name)).toEqual(["infra.md", "payments.md"]);
  });
});

describe("jarvis knowledge index / search", () => {
  it("indexes and searches from the CLI", async () => {
    const jarvis = async (args: string[]) => {
      let out = "";
      const code = await run(["node", "jarvis", ...args], {
        streams: {
          out: new Writable({
            write(c, _e, cb) {
              out += String(c);
              cb();
            },
          }),
          err: new Writable({
            write(_c, _e, cb) {
              cb();
            },
          }),
        },
        context: { cwd: sb.project, homeDir: sb.home, env: {} },
      });
      return { code, out };
    };
    mkdirSync(join(sb.project, "src"), { recursive: true });
    const indexed = await jarvis(["knowledge", "index"]);
    expect(indexed.code).toBe(0);
    expect(indexed.out).toMatch(
      /index: \d+ indexed, 0 unchanged, 0 removed → \d+ unit\(s\), 0 vector\(s\) \(lexical only/,
    );
    const found = await jarvis(["knowledge", "search", "re-register after rejection"]);
    expect(found.out).toContain("expansions: повторная регистрация → ");
    expect(found.out).toContain("knowledge:onboarding.md  [knowledge] onboarding.md — Restart");
  });
});
