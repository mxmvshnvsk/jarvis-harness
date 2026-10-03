import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Runtime } from "../../app/runtime.ts";
import { loadKnowledgeDocs } from "../resolver.ts";
import { loadSkills } from "../skills.ts";
import { type KnowledgeRoots, loadStandards } from "../standards.ts";
import type { Embedder } from "./embedder.ts";

/**
 * Knowledge index (ADR-0015 §2 v0.1–v0.2): units of knowledge, standards, skills and run
 * artifacts in FTS5, re-indexed only when the unit's version (content sha) changed; vectors
 * (§4–5) keyed by `(sourceId, sourceVersion, embedder)` so a different embedder is a different index.
 */
export type UnitKind = "knowledge" | "standard" | "skill" | "artifact";

export interface KnowledgeUnit {
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly kind: UnitKind;
  readonly title: string;
  /** How an agent reads it in full: `knowledge:name`, `standard:ID@v`, `skill:id@v`, `artifactId@v`. */
  readonly ref: string;
  readonly body: string;
}

export interface IndexReport {
  readonly indexed: number;
  readonly unchanged: number;
  readonly removed: number;
  readonly embedded: number;
}

export function unitVersion(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export class KnowledgeIndex {
  private readonly db: DatabaseSync;
  private readonly clock: () => Date;

  constructor(db: DatabaseSync, clock: () => Date = () => new Date()) {
    this.db = db;
    this.clock = clock;
  }

  /** Units from the project's explicit knowledge; artifacts are added by the runtime per run. */
  static projectUnits(roots: KnowledgeRoots): KnowledgeUnit[] {
    const units: KnowledgeUnit[] = [];
    for (const d of loadKnowledgeDocs(roots)) {
      // one unit per heading section keeps hits precise (ADR-0015 §1: semantic units, not fixed chunks)
      const sections = splitSections(d.text).filter((sec) => sec.body.trim().length > 0);
      sections.forEach((sec, i) => {
        units.push({
          sourceId: `knowledge:${d.name}#${i}`,
          sourceVersion: unitVersion(sec.body),
          kind: "knowledge",
          title: sec.heading ? `${d.name} — ${sec.heading}` : d.name,
          ref: `knowledge:${d.name}`,
          body: sec.body,
        });
      });
    }
    for (const s of loadStandards(roots)) {
      units.push({
        sourceId: `standard:${s.id}`,
        sourceVersion: `${s.version}:${unitVersion(s.rule)}`,
        kind: "standard",
        title: s.title,
        ref: `standard:${s.id}@${s.version}`,
        body: `${s.title}\n${s.rule}\n${s.tags.join(" ")}`,
      });
    }
    for (const s of loadSkills(roots)) {
      units.push({
        sourceId: `skill:${s.id}`,
        sourceVersion: `${s.version}:${unitVersion(s.instructions)}`,
        kind: "skill",
        title: s.title ?? s.id,
        ref: `skill:${s.id}@${s.version}`,
        body: `${s.title ?? ""}\n${s.instructions}`,
      });
    }
    return units;
  }

  static artifactUnits(runtime: Runtime, runId: string): KnowledgeUnit[] {
    const types = new Set([
      "research",
      "requirements",
      "spec",
      "impact",
      "plan",
      "review",
      "clarification",
      "release-notes",
    ]);
    return runtime.artifacts
      .listLatest(runId)
      .filter((a) => types.has(a.type))
      .map((a) => ({
        sourceId: `artifact:${a.artifactId}`,
        sourceVersion: String(a.version),
        kind: "artifact" as const,
        title: `${a.type} of run ${runId.slice(0, 12)}`,
        ref: `${a.artifactId}@${a.version}`,
        body: runtime.artifacts.text(a),
      }));
  }

  async upsert(units: readonly KnowledgeUnit[], embedder?: Embedder): Promise<IndexReport> {
    let indexed = 0;
    let unchanged = 0;
    let embedded = 0;
    const toEmbed: KnowledgeUnit[] = [];
    const now = this.clock().toISOString();
    for (const u of units) {
      const existing = this.db
        .prepare("SELECT source_version FROM knowledge_units WHERE source_id = ?")
        .get(u.sourceId) as { source_version: string } | undefined;
      const vectorMissing = embedder
        ? !this.db
            .prepare(
              "SELECT 1 FROM knowledge_vectors WHERE source_id = ? AND embedder = ? AND source_version = ?",
            )
            .get(u.sourceId, embedder.id, u.sourceVersion)
        : false;
      if (existing?.source_version === u.sourceVersion) {
        unchanged += 1;
        if (vectorMissing) toEmbed.push(u);
        continue;
      }
      this.db.prepare("DELETE FROM knowledge_fts WHERE source_id = ?").run(u.sourceId);
      this.db
        .prepare(
          "INSERT INTO knowledge_fts (source_id, source_version, kind, title, body) VALUES (?, ?, ?, ?, ?)",
        )
        .run(u.sourceId, u.sourceVersion, u.kind, u.title, u.body);
      this.db
        .prepare(
          "INSERT OR REPLACE INTO knowledge_units (source_id, source_version, kind, title, ref, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(u.sourceId, u.sourceVersion, u.kind, u.title, u.ref, now);
      this.db.prepare("DELETE FROM knowledge_vectors WHERE source_id = ?").run(u.sourceId);
      indexed += 1;
      if (embedder) toEmbed.push(u);
    }
    if (embedder && toEmbed.length > 0) {
      const vectors = await embedder.embed(toEmbed.map((u) => `${u.title}\n${u.body}`.slice(0, 8000)));
      toEmbed.forEach((u, i) => {
        const v = vectors[i];
        if (!v) return;
        this.db
          .prepare(
            "INSERT OR REPLACE INTO knowledge_vectors (source_id, source_version, embedder, dims, vector_json) VALUES (?, ?, ?, ?, ?)",
          )
          .run(u.sourceId, u.sourceVersion, embedder.id, v.length, JSON.stringify(v));
        embedded += 1;
      });
    }
    return { indexed, unchanged, removed: 0, embedded };
  }

  /** Drops project units that no longer exist (artifacts are never removed here). */
  prune(keep: ReadonlySet<string>): number {
    const rows = this.db
      .prepare("SELECT source_id FROM knowledge_units WHERE kind != 'artifact'")
      .all() as Array<{ source_id: string }>;
    let removed = 0;
    for (const { source_id } of rows) {
      if (keep.has(source_id)) continue;
      this.db.prepare("DELETE FROM knowledge_fts WHERE source_id = ?").run(source_id);
      this.db.prepare("DELETE FROM knowledge_units WHERE source_id = ?").run(source_id);
      this.db.prepare("DELETE FROM knowledge_vectors WHERE source_id = ?").run(source_id);
      removed += 1;
    }
    return removed;
  }

  count(): { units: number; vectors: number } {
    const units = (this.db.prepare("SELECT COUNT(*) AS n FROM knowledge_units").get() as { n: number }).n;
    const vectors = (this.db.prepare("SELECT COUNT(*) AS n FROM knowledge_vectors").get() as { n: number }).n;
    return { units, vectors };
  }

  lexical(
    terms: readonly string[],
    options: { kinds?: readonly UnitKind[]; limit?: number } = {},
  ): Array<{ sourceId: string; ref: string; kind: UnitKind; title: string; score: number; snippet: string }> {
    const match = terms
      .map((t) => `"${t.replace(/"/g, "")}"`)
      .filter((t) => t.length > 2)
      .join(" OR ");
    if (!match) return [];
    const kinds = options.kinds ?? ["knowledge", "standard", "skill", "artifact"];
    const rows = this.db
      .prepare(
        `SELECT f.source_id AS source_id, u.ref AS ref, f.kind AS kind, f.title AS title, bm25(knowledge_fts) AS score,
                snippet(knowledge_fts, 4, '[', ']', '…', 12) AS snippet
         FROM knowledge_fts f JOIN knowledge_units u ON u.source_id = f.source_id
         WHERE knowledge_fts MATCH ? AND f.kind IN (${kinds.map(() => "?").join(",")})
         ORDER BY score LIMIT ?`,
      )
      .all(match, ...kinds, options.limit ?? 20) as Array<{
      source_id: string;
      ref: string;
      kind: UnitKind;
      title: string;
      score: number;
      snippet: string;
    }>;
    return rows.map((r) => ({
      sourceId: r.source_id,
      ref: r.ref,
      kind: r.kind,
      title: r.title,
      score: -r.score,
      snippet: r.snippet,
    }));
  }

  semantic(
    query: number[],
    embedder: string,
    options: { kinds?: readonly UnitKind[]; limit?: number } = {},
  ): Array<{ sourceId: string; ref: string; kind: UnitKind; title: string; score: number }> {
    const kinds = options.kinds ?? ["knowledge", "standard", "skill", "artifact"];
    const rows = this.db
      .prepare(
        `SELECT v.source_id AS source_id, v.vector_json AS vector_json, u.ref AS ref, u.kind AS kind, u.title AS title
         FROM knowledge_vectors v JOIN knowledge_units u ON u.source_id = v.source_id AND u.source_version = v.source_version
         WHERE v.embedder = ? AND u.kind IN (${kinds.map(() => "?").join(",")})`,
      )
      .all(embedder, ...kinds) as Array<{
      source_id: string;
      vector_json: string;
      ref: string;
      kind: UnitKind;
      title: string;
    }>;
    return rows
      .map((r) => ({
        sourceId: r.source_id,
        ref: r.ref,
        kind: r.kind,
        title: r.title,
        score: cosine(query, JSON.parse(r.vector_json) as number[]),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit ?? 20);
  }
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function splitSections(text: string): Array<{ heading?: string; body: string }> {
  const out: Array<{ heading?: string; body: string }> = [];
  let heading: string | undefined;
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body.length > 0) out.push({ ...(heading ? { heading } : {}), body });
    buf = [];
  };
  for (const line of text.split("\n")) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (m) {
      flush();
      heading = m[1]?.trim();
      buf.push(line);
    } else buf.push(line);
  }
  flush();
  return out.length > 0 ? out : [{ body: text }];
}
