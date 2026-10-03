import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FileFacts, GraphEdge, GraphNode } from "../../core/capabilities/contracts.ts";

/**
 * Project Graph storage (ADR-0008 §1): facts per file content-addressed in the cache directory
 * (shared by every branch and worktree), snapshots per tree in SQLite.
 */
export interface SnapshotInfo {
  readonly id: string;
  readonly repoId: string;
  readonly treeSha: string;
  readonly branch?: string;
  readonly extractors: string;
  readonly files: number;
  readonly cacheHits: number;
  readonly contentHash: string;
  readonly createdAt: string;
}

export class FactsCache {
  private readonly dir: string;

  constructor(cacheRoot: string, repoId: string) {
    this.dir = join(cacheRoot, "graph", repoId, "blobs");
  }

  key(extractorVersion: number, blobSha: string): string {
    return `${blobSha}.v${extractorVersion}.json`;
  }

  get(extractorVersion: number, blobSha: string): FileFacts | undefined {
    const file = join(this.dir, this.key(extractorVersion, blobSha));
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as FileFacts;
    } catch {
      return undefined;
    }
  }

  put(extractorVersion: number, blobSha: string, facts: FileFacts): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, this.key(extractorVersion, blobSha)), JSON.stringify(facts));
  }
}

export interface Snapshot extends SnapshotInfo {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
}

export function contentHashOf(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string {
  const h = createHash("sha256");
  for (const n of nodes) h.update(`${n.id}|${n.kind}|${n.file ?? ""}\n`);
  for (const e of edges) h.update(`${e.from}|${e.relation}|${e.to}\n`);
  return h.digest("hex").slice(0, 16);
}

export class GraphStore {
  private readonly db: DatabaseSync;
  private readonly clock: () => Date;

  constructor(db: DatabaseSync, clock: () => Date = () => new Date()) {
    this.db = db;
    this.clock = clock;
  }

  latest(repoId: string): SnapshotInfo | undefined {
    const row = this.db
      .prepare("SELECT * FROM graph_snapshots WHERE repo_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(repoId) as Record<string, unknown> | undefined;
    return row ? this.toInfo(row) : undefined;
  }

  byTree(repoId: string, treeSha: string): SnapshotInfo | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM graph_snapshots WHERE repo_id = ? AND tree_sha = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(repoId, treeSha) as Record<string, unknown> | undefined;
    return row ? this.toInfo(row) : undefined;
  }

  save(
    input: Omit<SnapshotInfo, "id" | "createdAt" | "contentHash"> & {
      nodes: GraphNode[];
      edges: GraphEdge[];
    },
  ): Snapshot {
    const id = `gs_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const createdAt = this.clock().toISOString();
    const contentHash = contentHashOf(input.nodes, input.edges);
    const insertNode = this.db.prepare(
      "INSERT OR REPLACE INTO graph_nodes (snapshot_id, id, kind, file, metadata_json) VALUES (?, ?, ?, ?, ?)",
    );
    const insertEdge = this.db.prepare(
      "INSERT INTO graph_edges (snapshot_id, from_id, to_id, relation) VALUES (?, ?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO graph_snapshots (id, repo_id, tree_sha, branch, extractors, files, cache_hits, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          input.repoId,
          input.treeSha,
          input.branch ?? null,
          input.extractors,
          input.files,
          input.cacheHits,
          contentHash,
          createdAt,
        );
      for (const n of input.nodes)
        insertNode.run(id, n.id, n.kind, n.file ?? null, n.metadata ? JSON.stringify(n.metadata) : null);
      for (const e of input.edges) insertEdge.run(id, e.from, e.to, e.relation);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.prune(input.repoId, 5);
    return {
      ...input,
      id,
      createdAt,
      contentHash,
      ...(input.branch ? { branch: input.branch } : {}),
    } as Snapshot;
  }

  load(id: string): Snapshot | undefined {
    const row = this.db.prepare("SELECT * FROM graph_snapshots WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    const nodes = (
      this.db
        .prepare("SELECT id, kind, file, metadata_json FROM graph_nodes WHERE snapshot_id = ? ORDER BY id")
        .all(id) as Array<{
        id: string;
        kind: GraphNode["kind"];
        file: string | null;
        metadata_json: string | null;
      }>
    ).map((n) => ({
      id: n.id,
      kind: n.kind,
      ...(n.file ? { file: n.file } : {}),
      ...(n.metadata_json ? { metadata: JSON.parse(n.metadata_json) as Record<string, unknown> } : {}),
    }));
    const edges = (
      this.db
        .prepare(
          "SELECT from_id, to_id, relation FROM graph_edges WHERE snapshot_id = ? ORDER BY from_id, relation, to_id",
        )
        .all(id) as Array<{
        from_id: string;
        to_id: string;
        relation: GraphEdge["relation"];
      }>
    ).map((e) => ({ from: e.from_id, to: e.to_id, relation: e.relation }));
    return { ...this.toInfo(row), nodes, edges };
  }

  /** ADR-0008 §2: keep the last N snapshots per repository. */
  prune(repoId: string, keep: number): void {
    const old = this.db
      .prepare(
        "SELECT id FROM graph_snapshots WHERE repo_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?",
      )
      .all(repoId, keep) as Array<{ id: string }>;
    for (const { id } of old) {
      this.db.prepare("DELETE FROM graph_edges WHERE snapshot_id = ?").run(id);
      this.db.prepare("DELETE FROM graph_nodes WHERE snapshot_id = ?").run(id);
      this.db.prepare("DELETE FROM graph_snapshots WHERE id = ?").run(id);
    }
  }

  private toInfo(row: Record<string, unknown>): SnapshotInfo {
    return {
      id: row.id as string,
      repoId: row.repo_id as string,
      treeSha: row.tree_sha as string,
      ...(row.branch ? { branch: row.branch as string } : {}),
      extractors: row.extractors as string,
      files: row.files as number,
      cacheHits: row.cache_hits as number,
      contentHash: row.content_hash as string,
      createdAt: row.created_at as string,
    };
  }
}
