import { hostname } from "node:os";
import type { Lease } from "../core/domain/run.ts";
import { LeaseLostError, type SqliteRunStore } from "../storage/runStore.ts";

/** ADR-0002 §5: heartbeat 30 s, TTL 90 s. */
export const LEASE_TTL_MS = 90_000;
export const LEASE_HEARTBEAT_MS = 30_000;

export type LeaseOwnerKind = "cli" | "daemon" | "ci";

export function leaseOwner(kind: LeaseOwnerKind, extra?: string): string {
  const host = hostname();
  if (kind === "ci") return `ci:${extra ?? process.pid}`;
  if (kind === "daemon") return `daemon:${host}`;
  return `cli:${host}:${extra ?? process.pid}`;
}

export interface HeldLeaseOptions {
  readonly ttlMs?: number;
  readonly heartbeatMs?: number;
  /** Called once when a renewal fails: the process must stop before its next effect. */
  readonly onLost?: (error: LeaseLostError) => void;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
}

/**
 * A lease held by this process on one run. `check()` is the fencing call the Tool Router makes
 * before every effect; `release()` hands the run back when the step ends.
 */
export class HeldLease {
  readonly runId: string;
  readonly owner: string;
  readonly epoch: number;
  private readonly store: SqliteRunStore;
  private readonly ttlMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lost: LeaseLostError | undefined;
  private readonly clearTimer: typeof globalThis.clearInterval;

  private constructor(store: SqliteRunStore, runId: string, lease: Lease, options: HeldLeaseOptions) {
    this.store = store;
    this.runId = runId;
    this.owner = lease.owner;
    this.epoch = lease.epoch;
    this.ttlMs = options.ttlMs ?? LEASE_TTL_MS;
    const setTimer = options.setInterval ?? globalThis.setInterval;
    this.clearTimer = options.clearInterval ?? globalThis.clearInterval;
    const heartbeat = options.heartbeatMs ?? LEASE_HEARTBEAT_MS;
    if (heartbeat > 0) {
      this.timer = setTimer(() => this.heartbeat(options.onLost), heartbeat);
      if (typeof this.timer === "object" && this.timer && "unref" in this.timer) this.timer.unref();
    }
  }

  static acquire(
    store: SqliteRunStore,
    runId: string,
    owner: string,
    options: HeldLeaseOptions = {},
  ): HeldLease | undefined {
    const result = store.acquireLease(runId, owner, options.ttlMs ?? LEASE_TTL_MS);
    if (!result.ok) return undefined;
    return new HeldLease(store, runId, result.lease, options);
  }

  static steal(
    store: SqliteRunStore,
    runId: string,
    owner: string,
    options: HeldLeaseOptions = {},
  ): HeldLease {
    const lease = store.stealLease(runId, owner, options.ttlMs ?? LEASE_TTL_MS);
    return new HeldLease(store, runId, lease, options);
  }

  get isLost(): boolean {
    return this.lost !== undefined;
  }

  heartbeat(onLost?: (error: LeaseLostError) => void): boolean {
    if (this.lost) return false;
    const ok = this.store.renewLease(this.runId, this.owner, this.epoch, this.ttlMs);
    if (!ok) {
      this.lost = new LeaseLostError(this.runId, "renewal failed — taken by another process");
      this.stopTimer();
      onLost?.(this.lost);
    }
    return ok;
  }

  /** Fencing: throws when the lease is no longer ours. Cheap; call before every effect. */
  check(): void {
    if (this.lost) throw this.lost;
    this.store.assertLease(this.runId, this.owner, this.epoch);
  }

  release(): void {
    this.stopTimer();
    if (!this.lost) this.store.releaseLease(this.runId, this.owner, this.epoch);
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }
}
