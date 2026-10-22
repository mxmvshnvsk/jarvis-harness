import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { EMBED_BATCH, KnowledgeIndex, type KnowledgeUnit } from "../../src/knowledge/retrieval/index.ts";
import { MIGRATIONS } from "../../src/storage/migrations/index.ts";

function index(): KnowledgeIndex {
  const db = new DatabaseSync(":memory:");
  for (const m of MIGRATIONS) db.exec(m.sql);
  return new KnowledgeIndex(db);
}
const unit = (id: string, body: string): KnowledgeUnit => ({
  sourceId: id,
  sourceVersion: body,
  kind: "knowledge",
  title: id,
  ref: id,
  body,
});

describe("the knowledge index per project", () => {
  it("two repositories keep their own units: a refresh of one prunes nothing of the other", async () => {
    const ix = index();
    await ix.upsert([unit("knowledge:a.md#0", "orders are refunded once")], undefined, "repo:/a");
    await ix.upsert([unit("knowledge:a.md#0", "invoices are paid monthly")], undefined, "repo:/b");
    expect(ix.prune(new Set(["knowledge:a.md#0"]), "repo:/a")).toBe(0);
    expect(ix.lexical(["refunded"], { projects: ["repo:/a"] })).toHaveLength(1);
    expect(ix.lexical(["refunded"], { projects: ["repo:/b"] })).toHaveLength(0);
    expect(ix.lexical(["invoices"], { projects: ["repo:/b"] })).toHaveLength(1);
  });

  it("a long word finds its other forms (no Russian stemmer: a prefix of its stem)", async () => {
    const ix = index();
    await ix.upsert([unit("knowledge:z.md#0", "Статус заявки меняется после проверки")], undefined, "p");
    expect(ix.lexical(["заявка"], { projects: ["p"] })).toHaveLength(1);
  });

  it("embeds in batches, the same text once; a failed batch is said and leaves the rest for later", async () => {
    const ix = index();
    const calls: number[] = [];
    let fail = false;
    const embedder = {
      id: "toy",
      dims: 2,
      embed: async (texts: string[]) => {
        calls.push(texts.length);
        if (fail) throw new Error("413 too many inputs");
        return texts.map(() => [1, 0]);
      },
    };
    const units = Array.from({ length: EMBED_BATCH + 5 }, (_, i) => unit(`knowledge:d.md#${i}`, `text ${i}`));
    const first = await ix.upsert(units, embedder as never, "p");
    expect(calls).toEqual([EMBED_BATCH, 5]);
    expect(first.embedded).toBe(EMBED_BATCH + 5);
    // the same texts under another project: nothing to embed
    await ix.upsert(units, embedder as never, "q");
    expect(calls).toHaveLength(2);
    fail = true;
    const told: number[] = [];
    ix.onEmbedError = (_e, left) => told.push(left);
    const r = await ix.upsert([unit("knowledge:n.md#0", "new text")], embedder as never, "p");
    expect(r.embedded).toBe(0);
    expect(told).toEqual([1]);
  });
});
