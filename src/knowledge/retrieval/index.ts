import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Runtime } from "../../app/runtime.ts";
import { loadKnowledgeDocs } from "../resolver.ts";
import { loadSkills } from "../skills.ts";
import { type KnowledgeRoots, loadStandards } from "../standards.ts";
import type { Embedder } from "./embedder.ts";

/**
 * Knowledge index (ADR-0015 §2 v0.1–v0.4): units of knowledge, standards, skills, run artifacts
 * and code symbols in FTS5, re-indexed only when the unit's version (content sha, blob sha for
 * code) changed; vectors (§4–5) keyed by `(sourceId, sourceVersion, embedder)` so a different
 * embedder is a different index.
 */
export type UnitKind = "knowledge" | "standard" | "skill" | "artifact" | "code";

export const UNIT_KINDS: readonly UnitKind[] = ["knowledge", "standard", "skill", "artifact", "code"];

export interface KnowledgeUnit {
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly kind: UnitKind;
  readonly title: string;
  /** How an agent reads it in full: `knowledge:name`, `standard:ID@v`, `skill:id@v`, `artifactId@v`, `path:start-end`. */
  readonly ref: string;
  readonly body: string;
}

export interface IndexReport {
  readonly indexed: number;
  readonly unchanged: number;
  readonly removed: number;
  readonly embedded: number;
  /** Source files seen, changed since the last refresh, and skipped (ADR-0015 §2 v0.4). */
  readonly code?: { readonly files: number; readonly changed: number; readonly skipped: number };
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

  /**
   * Indexes a project's units (`project`: its key, `projectKeyOf`; a run's artifacts: `run:<id>`).
   * Units are keyed by project and id — two repositories' `code:src/index.ts` are two units — and a
   * section's vector by its text, so a moved section or another project's same text is not embedded
   * again. Pilot: one index for every repository on the machine, each refresh pruning the others.
   */
  async upsert(
    units: readonly KnowledgeUnit[],
    embedder: Embedder | undefined,
    project: string,
  ): Promise<IndexReport> {
    let indexed = 0;
    let unchanged = 0;
    let embedded = 0;
    const toEmbed = new Map<string, string>();
    const now = this.clock().toISOString();
    const has = embedder
      ? this.db.prepare("SELECT 1 FROM knowledge_vectors WHERE text_hash = ? AND embedder = ?")
      : undefined;
    const want = (u: KnowledgeUnit, hash: string) => {
      if (embedder && !toEmbed.has(hash) && !has?.get(hash, embedder.id))
        toEmbed.set(hash, `${u.title}\n${u.body}`.slice(0, 8000));
    };
    const get = this.db.prepare(
      "SELECT source_version, fts_rowid, text_hash FROM knowledge_units WHERE project = ? AND source_id = ?",
    );
    const delFts = this.db.prepare("DELETE FROM knowledge_fts WHERE rowid = ?");
    const addFts = this.db.prepare("INSERT INTO knowledge_fts (title, body) VALUES (?, ?)");
    const putUnit = this.db.prepare(
      `INSERT OR REPLACE INTO knowledge_units (project, source_id, source_version, kind, title, ref, indexed_at, fts_rowid, text_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // IMMEDIATE: the write lock from the start — a deferred one read first, and another process's
    // commit in between made it fail at once with SQLITE_BUSY (UI and a run refresh side by side)
    const own = !this.db.isTransaction;
    if (own) this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const u of units) {
        const hash = unitVersion(`${u.title}\n${u.body}`);
        const existing = get.get(project, u.sourceId) as
          | { source_version: string; fts_rowid: number; text_hash: string }
          | undefined;
        if (existing?.source_version === u.sourceVersion && existing.text_hash === hash) {
          unchanged += 1;
          want(u, hash);
          continue;
        }
        // by rowid: a delete by the unindexed source id scanned the whole FTS table for every unit
        if (existing) delFts.run(existing.fts_rowid);
        const rowid = Number(addFts.run(u.title, u.body).lastInsertRowid);
        putUnit.run(project, u.sourceId, u.sourceVersion, u.kind, u.title, u.ref, now, rowid, hash);
        indexed += 1;
        want(u, hash);
      }
      if (own) this.db.exec("COMMIT");
    } catch (error) {
      if (own) this.db.exec("ROLLBACK");
      throw error;
    }
    if (embedder && toEmbed.size > 0) embedded = await this.embed(embedder, toEmbed);
    return { indexed, unchanged, removed: 0, embedded };
  }

  /**
   * Vectors in batches, each written as it comes: one request of 10k texts went past the API's limit,
   * failed, and every refresh sent it again. A batch that fails is said and left for the next refresh;
   * search goes on lexically meanwhile.
   */
  private async embed(embedder: Embedder, texts: Map<string, string>): Promise<number> {
    const put = this.db.prepare(
      "INSERT OR REPLACE INTO knowledge_vectors (text_hash, embedder, dims, vector) VALUES (?, ?, ?, ?)",
    );
    const all = [...texts];
    let done = 0;
    for (let at = 0; at < all.length; at += EMBED_BATCH) {
      const batch = all.slice(at, at + EMBED_BATCH);
      let vectors: number[][];
      try {
        vectors = await embedder.embed(batch.map(([, t]) => t));
      } catch (error) {
        this.onEmbedError?.(error, all.length - at);
        break;
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        batch.forEach(([hash], i) => {
          const v = vectors[i];
          if (!v) return;
          put.run(hash, embedder.id, v.length, Buffer.from(new Float32Array(v).buffer));
          done += 1;
        });
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      this.vectorsAt += 1;
    }
    return done;
  }

  /** Said when a batch of embeddings failed (the runtime logs it); the rest waits for the next refresh. */
  onEmbedError: ((error: unknown, left: number) => void) | undefined;

  /** Drops the project's units that no longer exist; other projects' are not touched. */
  prune(keep: ReadonlySet<string>, project: string): number {
    const rows = this.db
      .prepare("SELECT source_id, fts_rowid FROM knowledge_units WHERE project = ?")
      .all(project) as Array<{ source_id: string; fts_rowid: number }>;
    const gone = rows.filter((r) => !keep.has(r.source_id));
    if (gone.length === 0) return 0;
    const own = !this.db.isTransaction;
    if (own) this.db.exec("BEGIN IMMEDIATE");
    try {
      const delFts = this.db.prepare("DELETE FROM knowledge_fts WHERE rowid = ?");
      const delUnit = this.db.prepare("DELETE FROM knowledge_units WHERE project = ? AND source_id = ?");
      for (const r of gone) {
        delFts.run(r.fts_rowid);
        delUnit.run(project, r.source_id);
      }
      if (own) this.db.exec("COMMIT");
    } catch (error) {
      if (own) this.db.exec("ROLLBACK");
      throw error;
    }
    return gone.length;
  }

  /** Drops whole projects (the artifacts of runs that ended): what no search reaches any more. */
  dropProjects(projects: readonly string[]): number {
    let removed = 0;
    for (const project of projects) removed += this.prune(new Set(), project);
    return removed;
  }

  /** The projects indexed, by prefix (`run:` — runs' artifacts). */
  projects(prefix = ""): string[] {
    return (
      this.db
        .prepare("SELECT DISTINCT project FROM knowledge_units WHERE project LIKE ? ESCAPE '\\'")
        .all(`${prefix.replace(/[\\%_]/g, "\\$&")}%`) as Array<{ project: string }>
    ).map((r) => r.project);
  }

  /** Indexed code by file: the version its units carry and their ids (to keep an unchanged file as is). */
  codeVersions(project: string): Map<string, { version: string; ids: string[] }> {
    const rows = this.db
      .prepare("SELECT source_id, source_version FROM knowledge_units WHERE project = ? AND kind = 'code'")
      .all(project) as Array<{ source_id: string; source_version: string }>;
    const out = new Map<string, { version: string; ids: string[] }>();
    for (const r of rows) {
      const path = r.source_id.slice("code:".length).replace(/#\d+$/, "");
      const prev = out.get(path);
      if (!prev) out.set(path, { version: r.source_version, ids: [r.source_id] });
      else {
        prev.ids.push(r.source_id);
        // units of one file at two versions (an interrupted refresh): the file is read again
        if (prev.version !== r.source_version) prev.version = "";
      }
    }
    return out;
  }

  /** Characters of each unit's indexed text, for the retrieved-tokens metric (ADR-0015 §6). */
  sizes(sourceIds: readonly string[], project: string): Map<string, number> {
    const out = new Map<string, number>();
    const q = this.db.prepare(
      `SELECT length(f.title) + length(f.body) AS n FROM knowledge_units u JOIN knowledge_fts f ON f.rowid = u.fts_rowid
       WHERE u.project = ? AND u.source_id = ?`,
    );
    for (const id of sourceIds) {
      const row = q.get(project, id) as { n: number } | undefined;
      if (row) out.set(id, row.n);
    }
    return out;
  }

  count(): { units: number; vectors: number } {
    const units = (this.db.prepare("SELECT COUNT(*) AS n FROM knowledge_units").get() as { n: number }).n;
    const vectors = (this.db.prepare("SELECT COUNT(*) AS n FROM knowledge_vectors").get() as { n: number }).n;
    return { units, vectors };
  }

  lexical(
    terms: readonly string[],
    options: { kinds?: readonly UnitKind[]; limit?: number; projects: readonly string[] },
  ): Array<{ sourceId: string; ref: string; kind: UnitKind; title: string; score: number; snippet: string }> {
    const match = [...new Set(terms.map((t) => t.replace(/"/g, "")).filter((t) => t.length > 2))]
      .slice(0, MAX_TERMS)
      .map(termQuery)
      .join(" OR ");
    if (!match || options.projects.length === 0) return [];
    const kinds = options.kinds ?? UNIT_KINDS;
    const rows = this.db
      .prepare(
        `SELECT u.source_id AS source_id, u.ref AS ref, u.kind AS kind, u.title AS title, bm25(knowledge_fts) AS score,
                snippet(knowledge_fts, 1, '[', ']', '…', 12) AS snippet
         FROM knowledge_fts f JOIN knowledge_units u ON u.fts_rowid = f.rowid
         WHERE knowledge_fts MATCH ? AND u.kind IN (${kinds.map(() => "?").join(",")})
           AND u.project IN (${options.projects.map(() => "?").join(",")})
         ORDER BY score LIMIT ?`,
      )
      .all(match, ...kinds, ...options.projects, options.limit ?? 20) as Array<{
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

  /** Vectors read once per embedder and kept while nothing was embedded since (a parse of all per query was 1.8 s at 10k). */
  private vectorsAt = 0;
  private vectorCache: { embedder: string; at: number; byHash: Map<string, Float32Array> } | undefined;

  private vectorsOf(embedder: string): Map<string, Float32Array> {
    const c = this.vectorCache;
    if (c && c.embedder === embedder && c.at === this.vectorsAt) return c.byHash;
    const rows = this.db
      .prepare("SELECT text_hash, vector FROM knowledge_vectors WHERE embedder = ?")
      .all(embedder) as Array<{ text_hash: string; vector: Uint8Array }>;
    const byHash = new Map<string, Float32Array>();
    for (const r of rows) {
      const b = r.vector;
      byHash.set(r.text_hash, new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
    }
    this.vectorCache = { embedder, at: this.vectorsAt, byHash };
    return byHash;
  }

  semantic(
    query: number[],
    embedder: string,
    options: { kinds?: readonly UnitKind[]; limit?: number; projects: readonly string[] },
  ): Array<{ sourceId: string; ref: string; kind: UnitKind; title: string; score: number }> {
    if (options.projects.length === 0) return [];
    const kinds = options.kinds ?? UNIT_KINDS;
    const vectors = this.vectorsOf(embedder);
    const rows = this.db
      .prepare(
        `SELECT source_id, ref, kind, title, text_hash FROM knowledge_units
         WHERE kind IN (${kinds.map(() => "?").join(",")}) AND project IN (${options.projects.map(() => "?").join(",")})`,
      )
      .all(...kinds, ...options.projects) as Array<{
      source_id: string;
      ref: string;
      kind: UnitKind;
      title: string;
      text_hash: string;
    }>;
    const out: Array<{ sourceId: string; ref: string; kind: UnitKind; title: string; score: number }> = [];
    for (const r of rows) {
      const v = vectors.get(r.text_hash);
      if (!v) continue;
      out.push({ sourceId: r.source_id, ref: r.ref, kind: r.kind, title: r.title, score: cosine(query, v) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, options.limit ?? 20);
  }
}

/** Texts per embeddings request (OpenAI-compatible APIs take up to 2048; gateways often fewer). */
export const EMBED_BATCH = 128;
/** Search terms per query: a query of hundreds of ORed tokens matched everything a little. */
const MAX_TERMS = 40;

/**
 * A term as FTS5 matches it: a long word by its stem — its last letters cut and a prefix query — so
 * «заявки» finds «заявка» (the tokenizer does not stem Russian).
 */
function termQuery(term: string): string {
  return term.length >= 6 ? `"${term.slice(0, Math.max(4, term.length - 2))}"*` : `"${term}"`;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
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
