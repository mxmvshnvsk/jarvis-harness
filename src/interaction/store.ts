import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { InteractionKind } from "../core/domain/run.ts";

/**
 * Interactions (ADR-0019 §2): one durable entity for every way a human takes part — approval,
 * clarification thread, review session, conflict. A thread is rows in SQLite, not a process: it
 * survives closed terminals and daemon restarts.
 */
export type InteractionState =
  | "open"
  | "acknowledged"
  | "applied"
  | "ready_for_review"
  | "resolved"
  | "rejected";

export interface Interaction {
  readonly id: string;
  readonly runId: string;
  readonly kind: InteractionKind;
  readonly stepId: string;
  readonly iteration: number;
  /** Artifact version the interaction is about (`artifactId@version`). */
  readonly contentRef?: string;
  readonly state: InteractionState;
  /** review | requirements | agent — where a clarification came from (ADR-0019 §7). */
  readonly origin?: string;
  readonly openedBy: string;
  readonly openedAt: string;
  readonly resolvedBy?: string;
  readonly resolvedAt?: string;
  /** Artifact that records the resolution (`artifactId@version`). */
  readonly resolutionRef?: string;
  readonly meta: Record<string, unknown>;
}

export interface InteractionMessage {
  readonly id: number;
  readonly interactionId: string;
  readonly seq: number;
  readonly role: "human" | "jarvis";
  readonly actor: string;
  readonly text: string;
  /** A proposed resolution attached by Jarvis (ADR-0019 §4). */
  readonly proposal?: Record<string, unknown>;
  readonly createdAt: string;
}

interface Row {
  id: string;
  run_id: string;
  kind: InteractionKind;
  step_id: string;
  iteration: number;
  content_ref: string | null;
  state: InteractionState;
  origin: string | null;
  opened_by: string;
  opened_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_ref: string | null;
  meta_json: string;
}

const COLUMNS =
  "id, run_id, kind, step_id, iteration, content_ref, state, origin, opened_by, opened_at, resolved_by, resolved_at, resolution_ref, meta_json";

function toInteraction(r: Row): Interaction {
  return {
    id: r.id,
    runId: r.run_id,
    kind: r.kind,
    stepId: r.step_id,
    iteration: r.iteration,
    ...(r.content_ref ? { contentRef: r.content_ref } : {}),
    state: r.state,
    ...(r.origin ? { origin: r.origin } : {}),
    openedBy: r.opened_by,
    openedAt: r.opened_at,
    ...(r.resolved_by ? { resolvedBy: r.resolved_by } : {}),
    ...(r.resolved_at ? { resolvedAt: r.resolved_at } : {}),
    ...(r.resolution_ref ? { resolutionRef: r.resolution_ref } : {}),
    meta: JSON.parse(r.meta_json) as Record<string, unknown>,
  };
}

export interface OpenInteractionInput {
  readonly runId: string;
  readonly kind: InteractionKind;
  readonly stepId: string;
  readonly iteration: number;
  readonly contentRef?: string;
  readonly origin?: string;
  readonly openedBy: string;
  readonly meta?: Record<string, unknown>;
  /** First message of the thread (the question, the review summary). */
  readonly message?: {
    role: "human" | "jarvis";
    actor: string;
    text: string;
    proposal?: Record<string, unknown>;
  };
}

export class InteractionStore {
  private readonly db: DatabaseSync;
  private readonly clock: () => Date;

  constructor(db: DatabaseSync, clock: () => Date = () => new Date()) {
    this.db = db;
    this.clock = clock;
  }

  open(input: OpenInteractionInput): Interaction {
    const id = `int_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = this.clock().toISOString();
    this.db
      .prepare(
        `INSERT INTO interactions (id, run_id, kind, step_id, iteration, content_ref, state, origin, opened_by, opened_at, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.kind,
        input.stepId,
        input.iteration,
        input.contentRef ?? null,
        input.origin ?? null,
        input.openedBy,
        now,
        JSON.stringify(input.meta ?? {}),
      );
    if (input.message) this.say(id, input.message);
    return this.require(id);
  }

  get(id: string): Interaction | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM interactions WHERE id = ?`).get(id) as
      | Row
      | undefined;
    return row ? toInteraction(row) : undefined;
  }

  resolveRef(idOrPrefix: string): Interaction | undefined {
    const exact = this.get(idOrPrefix);
    if (exact) return exact;
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM interactions WHERE id LIKE ? ORDER BY opened_at DESC`)
      .all(`${idOrPrefix}%`) as unknown as Row[];
    return rows.length === 1 ? toInteraction(rows[0] as Row) : undefined;
  }

  require(id: string): Interaction {
    const found = this.get(id);
    if (!found) throw new Error(`interaction ${id} not found`);
    return found;
  }

  listForRun(runId: string, options: { openOnly?: boolean } = {}): Interaction[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM interactions WHERE run_id = ? ${options.openOnly ? "AND state NOT IN ('resolved','rejected')" : ""} ORDER BY opened_at ASC`,
      )
      .all(runId) as unknown as Row[];
    return rows.map(toInteraction);
  }

  listOpen(): Interaction[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM interactions WHERE state NOT IN ('resolved','rejected') ORDER BY opened_at ASC`,
      )
      .all() as unknown as Row[];
    return rows.map(toInteraction);
  }

  /** The open interaction of a run and kind, if any (one per run and kind in v1, ADR-0019 §10). */
  openFor(runId: string, kind?: InteractionKind): Interaction | undefined {
    return this.listForRun(runId, { openOnly: true }).find((i) => kind === undefined || i.kind === kind);
  }

  setState(id: string, state: InteractionState): Interaction {
    this.db.prepare("UPDATE interactions SET state = ? WHERE id = ?").run(state, id);
    return this.require(id);
  }

  close(id: string, outcome: "resolved" | "rejected", by: string, resolutionRef?: string): Interaction {
    this.db
      .prepare(
        "UPDATE interactions SET state = ?, resolved_by = ?, resolved_at = ?, resolution_ref = ? WHERE id = ?",
      )
      .run(outcome, by, this.clock().toISOString(), resolutionRef ?? null, id);
    return this.require(id);
  }

  say(
    id: string,
    message: { role: "human" | "jarvis"; actor: string; text: string; proposal?: Record<string, unknown> },
  ): InteractionMessage {
    const seq = (this.messages(id).at(-1)?.seq ?? 0) + 1;
    const now = this.clock().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO interaction_messages (interaction_id, seq, role, actor, text, proposal_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        seq,
        message.role,
        message.actor,
        message.text,
        message.proposal ? JSON.stringify(message.proposal) : null,
        now,
      );
    return {
      id: Number(result.lastInsertRowid),
      interactionId: id,
      seq,
      role: message.role,
      actor: message.actor,
      text: message.text,
      ...(message.proposal ? { proposal: message.proposal } : {}),
      createdAt: now,
    };
  }

  messages(id: string): InteractionMessage[] {
    const rows = this.db
      .prepare(
        "SELECT id, interaction_id, seq, role, actor, text, proposal_json, created_at FROM interaction_messages WHERE interaction_id = ? ORDER BY seq ASC",
      )
      .all(id) as unknown as Array<{
      id: number;
      interaction_id: string;
      seq: number;
      role: "human" | "jarvis";
      actor: string;
      text: string;
      proposal_json: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      interactionId: r.interaction_id,
      seq: r.seq,
      role: r.role,
      actor: r.actor,
      text: r.text,
      ...(r.proposal_json ? { proposal: JSON.parse(r.proposal_json) as Record<string, unknown> } : {}),
      createdAt: r.created_at,
    }));
  }

  /** Human turns so far — the clarification turn budget (ADR-0019 §4). */
  humanTurns(id: string): number {
    return this.messages(id).filter((m) => m.role === "human").length;
  }
}
