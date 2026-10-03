import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Actor } from "../core/domain/actor.ts";
import {
  type ApprovalDecision,
  type ArtifactVersion,
  ArtifactVersionSchema,
  type Provenance,
  type ProvenanceInput,
  ProvenanceSchema,
} from "../core/domain/artifact.ts";
import { type BlobStore, contentRefOf } from "./blobs.ts";
import { unifiedDiff } from "./diff.ts";

/**
 * ArtifactStore (ADR-0005): immutable versions, provenance on every one, human edits as new
 * versions with a diff, approvals bound to an exact content hash.
 */
export interface CreateArtifactInput {
  readonly runId: string;
  readonly type: string;
  readonly name: string;
  readonly content: Buffer | string;
  readonly mediaType?: string;
  readonly provenance: ProvenanceInput;
  readonly sourceRefs?: readonly string[];
  readonly stepId?: string;
  readonly iteration?: number;
  readonly schemaVersion?: number;
}

export interface Approval {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly artifactId: string;
  readonly version: number;
  readonly contentRef: string;
  readonly actor: Actor;
  readonly decision: ApprovalDecision;
  readonly comment?: string;
  /** For request_changes: the workflow outcome to follow (ADR-0019 §5), default `request_changes`. */
  readonly outcome?: string;
  readonly createdAt: string;
}

export interface HumanEditResult {
  readonly artifact: ArtifactVersion;
  readonly changed: boolean;
  readonly diff?: string;
}

/** Logical id: stable across versions, derived from (runId, type, name) (ADR-0005 §1). */
export function artifactIdFor(runId: string, type: string, name: string): string {
  return `art_${createHash("sha256").update(`${runId}\0${type}\0${name}`).digest("hex").slice(0, 16)}`;
}

interface ArtifactRow {
  artifact_id: string;
  version: number;
  run_id: string;
  type: string;
  name: string;
  schema_version: number;
  content_ref: string;
  parent_version: number | null;
  provenance_json: string;
  source_refs_json: string;
  step_id: string | null;
  iteration: number | null;
  created_at: string;
}

const COLUMNS =
  "artifact_id, version, run_id, type, name, schema_version, content_ref, parent_version, provenance_json, source_refs_json, step_id, iteration, created_at";

function rowToArtifact(row: ArtifactRow): ArtifactVersion {
  return ArtifactVersionSchema.parse({
    artifactId: row.artifact_id,
    version: row.version,
    runId: row.run_id,
    type: row.type,
    name: row.name,
    schemaVersion: row.schema_version,
    contentRef: row.content_ref,
    ...(row.parent_version !== null ? { parentVersion: row.parent_version } : {}),
    provenance: JSON.parse(row.provenance_json),
    sourceRefs: JSON.parse(row.source_refs_json),
    ...(row.step_id ? { stepId: row.step_id } : {}),
    ...(row.iteration !== null ? { iteration: row.iteration } : {}),
    createdAt: row.created_at,
  });
}

export class ArtifactStore {
  private readonly db: DatabaseSync;
  private readonly blobs: BlobStore;
  private readonly clock: () => Date;

  constructor(db: DatabaseSync, blobs: BlobStore, clock: () => Date = () => new Date()) {
    this.db = db;
    this.blobs = blobs;
    this.clock = clock;
  }

  /** Creates version 1, or the next version when the logical artifact already exists. */
  put(input: CreateArtifactInput): ArtifactVersion {
    const artifactId = artifactIdFor(input.runId, input.type, input.name);
    const latest = this.latest(artifactId);
    const blob = this.blobs.put(input.content, input.mediaType);
    const version = latest ? latest.version + 1 : 1;
    this.insert({
      artifactId,
      version,
      runId: input.runId,
      type: input.type,
      name: input.name,
      schemaVersion: input.schemaVersion ?? 1,
      contentRef: blob.contentRef,
      ...(latest ? { parentVersion: latest.version } : {}),
      provenance: ProvenanceSchema.parse(input.provenance),
      sourceRefs: [...(input.sourceRefs ?? [])],
      ...(input.stepId ? { stepId: input.stepId } : {}),
      ...(input.iteration !== undefined ? { iteration: input.iteration } : {}),
      createdAt: this.clock().toISOString(),
    });
    return this.require(artifactId, version);
  }

  private insert(a: ArtifactVersion): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (artifact_id, version, run_id, type, name, schema_version, content_ref, parent_version, provenance_json, source_refs_json, step_id, iteration, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.artifactId,
        a.version,
        a.runId,
        a.type,
        a.name,
        a.schemaVersion,
        a.contentRef,
        a.parentVersion ?? null,
        JSON.stringify(a.provenance),
        JSON.stringify(a.sourceRefs),
        a.stepId ?? null,
        a.iteration ?? null,
        a.createdAt,
      );
  }

  get(artifactId: string, version: number): ArtifactVersion | undefined {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM artifacts WHERE artifact_id = ? AND version = ?`)
      .get(artifactId, version) as ArtifactRow | undefined;
    return row ? rowToArtifact(row) : undefined;
  }

  require(artifactId: string, version: number): ArtifactVersion {
    const a = this.get(artifactId, version);
    if (!a) throw new Error(`artifact ${artifactId}@${version} not found`);
    return a;
  }

  latest(artifactId: string): ArtifactVersion | undefined {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM artifacts WHERE artifact_id = ? ORDER BY version DESC LIMIT 1`)
      .get(artifactId) as ArtifactRow | undefined;
    return row ? rowToArtifact(row) : undefined;
  }

  find(runId: string, type: string, name: string): ArtifactVersion | undefined {
    return this.latest(artifactIdFor(runId, type, name));
  }

  versions(artifactId: string): ArtifactVersion[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM artifacts WHERE artifact_id = ? ORDER BY version ASC`)
      .all(artifactId) as unknown as ArtifactRow[];
    return rows.map(rowToArtifact);
  }

  /** Latest version of every artifact of a run (optionally one type). */
  listLatest(runId: string, type?: string): ArtifactVersion[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM artifacts a
         WHERE run_id = ? ${type ? "AND type = ?" : ""}
           AND version = (SELECT MAX(version) FROM artifacts b WHERE b.artifact_id = a.artifact_id)
         ORDER BY type, name`,
      )
      .all(...(type ? [runId, type] : [runId])) as unknown as ArtifactRow[];
    return rows.map(rowToArtifact);
  }

  content(a: Pick<ArtifactVersion, "contentRef">): Buffer {
    return this.blobs.get(a.contentRef);
  }

  text(a: Pick<ArtifactVersion, "contentRef">): string {
    return this.blobs.getText(a.contentRef);
  }

  /**
   * ADR-0005 §3: compares `content` with the latest version; a difference becomes a new version
   * with `provenance.kind = human` and a unified diff against the parent.
   */
  recordHumanEdit(artifactId: string, content: string, actor: Actor, comment?: string): HumanEditResult {
    const latest = this.latest(artifactId);
    if (!latest) throw new Error(`artifact ${artifactId} not found`);
    if (contentRefOf(content) === latest.contentRef) return { artifact: latest, changed: false };
    const before = this.text(latest);
    const diff = unifiedDiff(
      before,
      content,
      `${latest.name}@${latest.version}`,
      `${latest.name}@${latest.version + 1}`,
    );
    const diffRef = diff !== undefined ? this.blobs.put(diff, "text/x-diff").contentRef : undefined;
    const blob = this.blobs.put(content, this.blobs.info(latest.contentRef)?.mediaType);
    const provenance: Provenance = {
      kind: "human",
      actor,
      ...(diffRef ? { diffRef } : {}),
      ...(comment ? { comment } : {}),
    };
    this.insert({
      artifactId,
      version: latest.version + 1,
      runId: latest.runId,
      type: latest.type,
      name: latest.name,
      schemaVersion: latest.schemaVersion,
      contentRef: blob.contentRef,
      parentVersion: latest.version,
      provenance,
      sourceRefs: latest.sourceRefs,
      ...(latest.stepId ? { stepId: latest.stepId } : {}),
      ...(latest.iteration !== undefined ? { iteration: latest.iteration } : {}),
      createdAt: this.clock().toISOString(),
    });
    const artifact = this.require(artifactId, latest.version + 1);
    return diff !== undefined ? { artifact, changed: true, diff } : { artifact, changed: true };
  }

  /* ---- approvals (ADR-0005 §4) ---- */

  approve(input: Omit<Approval, "id" | "contentRef" | "createdAt">): Approval {
    const artifact = this.require(input.artifactId, input.version);
    const approval: Approval = {
      ...input,
      id: `apr_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      contentRef: artifact.contentRef,
      createdAt: this.clock().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO approvals (id, run_id, step_id, artifact_id, version, content_ref, actor_json, decision, comment, outcome, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.runId,
        approval.stepId,
        approval.artifactId,
        approval.version,
        approval.contentRef,
        JSON.stringify(approval.actor),
        approval.decision,
        approval.comment ?? null,
        approval.outcome ?? null,
        approval.createdAt,
      );
    return approval;
  }

  approvalsFor(artifactId: string, version?: number): Approval[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, step_id, artifact_id, version, content_ref, actor_json, decision, comment, outcome, created_at
         FROM approvals WHERE artifact_id = ? ${version !== undefined ? "AND version = ?" : ""} ORDER BY created_at DESC`,
      )
      .all(...(version !== undefined ? [artifactId, version] : [artifactId])) as unknown as Array<{
      id: string;
      run_id: string;
      step_id: string;
      artifact_id: string;
      version: number;
      content_ref: string;
      actor_json: string;
      decision: ApprovalDecision;
      comment: string | null;
      outcome: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      stepId: r.step_id,
      artifactId: r.artifact_id,
      version: r.version,
      contentRef: r.content_ref,
      actor: JSON.parse(r.actor_json) as Actor,
      decision: r.decision,
      ...(r.comment ? { comment: r.comment } : {}),
      ...(r.outcome ? { outcome: r.outcome } : {}),
      createdAt: r.created_at,
    }));
  }

  /** The gate passes only with an `approve` for the latest version's exact content (ADR-0005 §4). */
  isApproved(artifactId: string): { approved: boolean; latest?: ArtifactVersion; approval?: Approval } {
    const latest = this.latest(artifactId);
    if (!latest) return { approved: false };
    const approval = this.approvalsFor(artifactId, latest.version).find((a) => a.decision === "approve");
    if (!approval || approval.contentRef !== latest.contentRef) return { approved: false, latest };
    return { approved: true, latest, approval };
  }

  /** Approvals for all artifacts of a run whose latest version is still unapproved (for `status`). */
  pendingApprovals(runId: string, types: readonly string[]): ArtifactVersion[] {
    return this.listLatest(runId).filter(
      (a) => types.includes(a.type) && !this.isApproved(a.artifactId).approved,
    );
  }
}
