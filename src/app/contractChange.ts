import type { Actor } from "../core/domain/actor.ts";
import { isTerminal, type Run } from "../core/domain/run.ts";
import { addNote } from "../interaction/notes.ts";
import type { DecisionChannel } from "./decide.ts";
import type { Runtime } from "./runtime.ts";
import {
  type ContractItem,
  childrenOf,
  libraryMapOf,
  resumeSubtask,
  SPLIT_TYPE,
  scheduleSubtasks,
  splitOf,
  subtasksOf,
} from "./subtasks.ts";

/**
 * A subtask asks for a contract change (ADR-0025 §6): only the master changes the contract. A subtask
 * whose analysis finds the agreed contract cannot work as split writes `contractChange` in its impact;
 * its `scope` step parks it (WAITING_HUMAN, `contract`) and records the request on the master, whose
 * page shows it at the gate. A person accepts — the split gets a new version with the contract
 * changed, the other subtasks it touches get it as a note, the asking one analyses its impact again
 * with it — or rejects: the asking subtask goes on with the contract as agreed.
 */
export interface ContractChangeAsk {
  readonly item: string;
  readonly kind?: ContractItem["kind"];
  readonly change: string;
  readonly why: string;
  /**
   * The service or library of the map whose code changes for it, when not the asking one (the shared
   * library that declares the DTO). Accepted while it has no subtask: the split gets one for it.
   */
  readonly owner?: string;
}

export interface ContractChangeRequest extends ContractChangeAsk {
  /** The impact that asks, `artifactId@version`: one request per analysis. */
  readonly id: string;
  readonly key: string;
  readonly service: string;
  readonly run: string;
  readonly at: string;
  /** Pending: the owner accepting it adds as a subtask (the split has none for it). */
  readonly adds?: { readonly service: string; readonly library: boolean };
}

export interface ContractChangeDecision {
  readonly request: string;
  readonly choice: "accept" | "reject";
  /** Accepted: the change as written into the split (the person may have edited it). */
  readonly change?: string;
  readonly why?: string;
  readonly by?: string;
  /** Accepted: the split's new version. */
  readonly version?: number;
  /** Accepted: the subtask the split got for the owner, when it had none. */
  readonly added?: { readonly key: string; readonly service: string; readonly library: boolean };
}

export const CONTRACT_REQUESTED = "contract.changeRequested";
export const CONTRACT_DECIDED = "contract.changeDecided";
/** The scope step's outcome after an accepted change: back to the impact, with the new contract. */
export const CONTRACT_CHANGED = "contract_changed";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const KINDS: readonly string[] = ["endpoint", "topic", "dto"];

/** What the subtask's latest impact asks, with the id of that analysis. */
export function contractChangeAsked(
  runtime: Runtime,
  run: Run,
): { readonly id: string; readonly ask: ContractChangeAsk } | undefined {
  const a = runtime.artifacts.listLatest(run.id, "impact")[0];
  if (!a) return undefined;
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(runtime.artifacts.text(a)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const c = (doc.contractChange ?? undefined) as Record<string, unknown> | undefined;
  const item = str(c?.item);
  const change = str(c?.change);
  if (!c || !item || !change) return undefined;
  const kind = KINDS.includes(String(c.kind)) ? (c.kind as ContractItem["kind"]) : undefined;
  const owner = str(c.owner);
  return {
    id: `${a.artifactId}@${a.version}`,
    ask: { item, ...(kind ? { kind } : {}), change, why: str(c.why) ?? "", ...(owner ? { owner } : {}) },
  };
}

/** Every request recorded on the master, oldest first. */
export function contractRequestsOf(runtime: Runtime, masterId: string): ContractChangeRequest[] {
  const out: ContractChangeRequest[] = [];
  for (const e of runtime.events.list({ runId: masterId, kind: CONTRACT_REQUESTED, limit: 10_000 })) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const [id, key, service, run, item, change] = [p.id, p.key, p.service, p.run, p.item, p.change].map(str);
    if (!id || !key || !service || !run || !item || !change || out.some((r) => r.id === id)) continue;
    const kind = KINDS.includes(String(p.kind)) ? (p.kind as ContractItem["kind"]) : undefined;
    out.push({
      id,
      key,
      service,
      run,
      item,
      ...(kind ? { kind } : {}),
      change,
      why: str(p.why) ?? "",
      ...(str(p.owner) ? { owner: str(p.owner) as string } : {}),
      at: e.ts,
    });
  }
  return out;
}

/** The person's decision on a request, if any. */
export function contractDecisionOf(
  runtime: Runtime,
  masterId: string,
  requestId: string,
): ContractChangeDecision | undefined {
  const e = runtime.events
    .list({ runId: masterId, kind: CONTRACT_DECIDED, limit: 10_000 })
    .filter((x) => (x.payload as Record<string, unknown> | undefined)?.request === requestId)
    .at(-1);
  const p = (e?.payload ?? {}) as Record<string, unknown>;
  if (!e || (p.choice !== "accept" && p.choice !== "reject")) return undefined;
  return {
    request: requestId,
    choice: p.choice,
    ...(str(p.change) ? { change: str(p.change) as string } : {}),
    ...(str(p.why) ? { why: str(p.why) as string } : {}),
    ...(e.actor ? { by: e.actor.replace(/^(user|service|ci):/, "") } : {}),
    ...(typeof p.version === "number" ? { version: p.version } : {}),
    ...(isAdded(p.added) ? { added: p.added } : {}),
  };
}

function isAdded(v: unknown): v is NonNullable<ContractChangeDecision["added"]> {
  const o = v as Record<string, unknown> | undefined;
  return !!o && typeof o.key === "string" && typeof o.service === "string" && typeof o.library === "boolean";
}

/**
 * The owner of a request that the split has no subtask for: a service of the knowledge repository's map
 * other than the asking one. Undefined when it names nothing, the asking service, an unknown name, or a
 * service the split already has (dropped or not: a person decided on it).
 */
export function ownerToAdd(
  runtime: Runtime,
  master: Run,
  request: ContractChangeAsk & { service: string },
): string | undefined {
  const owner = request.owner;
  if (!owner || owner === request.service) return undefined;
  if (!runtime.loaded.meta?.repos[owner]) return undefined;
  return splitOf(runtime, master)?.subtasks.some((s) => s.service === owner) ? undefined : owner;
}

/** A key for a new subtask in the split's own style: S1, S2 → S3; anything else → the next free number. */
export function nextKey(keys: readonly string[]): string {
  const m = keys.map((k) => /^(\D*)(\d+)$/.exec(k)).filter((x) => x !== null);
  const prefix = m[0]?.[1] ?? "S";
  let n = Math.max(0, ...m.map((x) => Number(x[2]))) + 1;
  while (keys.includes(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** The requests that wait for a person: not decided, their subtask's run still waiting for it. */
export function pendingContractRequests(runtime: Runtime, master: Run): ContractChangeRequest[] {
  const libraries = libraryMapOf(runtime).libraries;
  return contractRequestsOf(runtime, master.id)
    .filter((r) => {
      if (contractDecisionOf(runtime, master.id, r.id)) return false;
      const run = runtime.runs.get(r.run);
      return run !== undefined && !isTerminal(run.state);
    })
    .map((r) => {
      const owner = ownerToAdd(runtime, master, r);
      return owner ? { ...r, adds: { service: owner, library: libraries.has(owner) } } : r;
    });
}

/** The subtask's request on its master, once per analysis. */
export function recordContractRequest(
  runtime: Runtime,
  master: Run,
  run: Run,
  asked: { readonly id: string; readonly ask: ContractChangeAsk },
): void {
  if (contractRequestsOf(runtime, master.id).some((r) => r.id === asked.id)) return;
  const parent = run.options?.parent;
  const service = splitOf(runtime, master)?.subtasks.find((s) => s.key === parent?.key)?.service;
  runtime.events.emit({
    kind: CONTRACT_REQUESTED,
    runId: master.id,
    payload: { id: asked.id, key: parent?.key, service, run: run.id, ...asked.ask },
  });
}

const itemLine = (c: Pick<ContractItem, "kind" | "id" | "change">) => `${c.kind} ${c.id}: ${c.change}`;

/**
 * Accepted: the split's contract item takes the change (a new item when the request names one the
 * contract does not have), as a new version of the split; the other subtasks of its sides that still
 * run get it as a note; the asking one goes on — its impact runs again with the new contract.
 */
export function acceptContractChange(
  runtime: Runtime,
  master: Run,
  request: ContractChangeRequest,
  actor: Actor,
  channel: DecisionChannel,
  edited?: string,
): { version: number; told: string[]; done: string[]; added?: ContractChangeDecision["added"] } {
  const split = runtime.artifacts.listLatest(master.id, SPLIT_TYPE)[0];
  const current = splitOf(runtime, master);
  if (!split || !current) throw new Error("the master has no split: nothing to change");
  const change = edited?.trim() || request.change;
  const doc = JSON.parse(runtime.artifacts.text(split)) as Record<string, unknown>;
  const contract = (Array.isArray(doc.contract) ? doc.contract : []) as Array<Record<string, unknown>>;
  const owner = ownerToAdd(runtime, master, request);
  let item = contract.find((c) => c.id === request.item);
  if (item) item.change = change;
  else {
    item = {
      kind: request.kind ?? "dto",
      id: request.item,
      change,
      producer: owner ?? request.service,
      consumers: owner ? [request.service] : [],
    };
    contract.push(item);
  }
  // the change is the owner's code: the split gets a subtask for it, delivered before the asking one
  const subtasks = (Array.isArray(doc.subtasks) ? doc.subtasks : []) as Array<Record<string, unknown>>;
  let added: ContractChangeDecision["added"];
  if (owner) {
    const key = nextKey(subtasks.map((x) => String(x.key)));
    const library = libraryMapOf(runtime).libraries.has(owner);
    subtasks.push({
      key,
      service: owner,
      task: `${change} (the contract change ${request.item} asked by subtask ${request.key}, ${request.service}: ${request.why})`,
      requirements: [],
      deliverAfter: [],
    });
    const asking = subtasks.find((x) => x.key === request.key);
    if (asking) {
      const after = Array.isArray(asking.deliverAfter) ? (asking.deliverAfter as string[]) : [];
      asking.deliverAfter = [...new Set([...after, key])];
    }
    added = { key, service: owner, library };
  }
  const by = `${actor.kind}:${actor.id}`;
  const next = runtime.artifacts.put({
    runId: master.id,
    type: SPLIT_TYPE,
    name: split.name,
    content: JSON.stringify({ ...doc, contract, ...(added ? { subtasks } : {}) }, null, 2),
    mediaType: "application/json",
    provenance: { kind: "human", actor: { kind: "user", id: actor.id, verified: false } },
    sourceRefs: [request.id],
    ...(split.stepId ? { stepId: split.stepId } : {}),
    ...(split.iteration !== undefined ? { iteration: split.iteration } : {}),
  });
  runtime.events.emit({
    kind: CONTRACT_DECIDED,
    runId: master.id,
    actor: by,
    payload: {
      request: request.id,
      key: request.key,
      choice: "accept",
      change,
      version: next.version,
      ...(added ? { added } : {}),
      channel,
    },
  });
  const line = itemLine({ kind: item.kind as ContractItem["kind"], id: request.item, change });
  const sides = new Set([String(item.producer), ...((item.consumers as string[] | undefined) ?? [])]);
  const told: string[] = [];
  const done: string[] = [];
  for (const [key, run] of childrenOf(runtime, master.id)) {
    const sub = current.subtasks.find((s) => s.key === key);
    if (!sub || key === request.key || !sides.has(sub.service)) continue;
    if (isTerminal(run.state)) {
      done.push(key);
      continue;
    }
    addNote(
      runtime,
      run,
      `The master changed the contract (asked by subtask ${request.key}, ${request.service}): ${line}. Keep it as now written.`,
      actor.id,
    );
    told.push(key);
  }
  const asking = runtime.runs.get(request.run);
  if (added) scheduleSubtasks(runtime, runtime.runs.get(master.id) ?? master);
  if (asking && !isTerminal(asking.state)) {
    addNote(
      runtime,
      asking,
      added?.library
        ? `The master accepted the contract change: ${line}. It is a change of the library ${added.service}: its subtask ${added.key} changes it first; this run goes on once that change is accepted and published, and builds against the new version.`
        : `The master accepted the contract change: ${line}. Keep it as now written; the impact is analysed again with it.${added ? ` ${added.service} makes its side as subtask ${added.key}, delivered before this one.` : ""}`,
      actor.id,
    );
    // a library's change comes first: the asking run waits for its publication (afterRunStops resumes it)
    if (!added?.library) resumeSubtask(runtime, asking);
  }
  return { version: next.version, told, done, ...(added ? { added } : {}) };
}

/** Rejected: the asking subtask goes on with the contract as agreed. */
export function rejectContractChange(
  runtime: Runtime,
  master: Run,
  request: ContractChangeRequest,
  actor: Actor,
  channel: DecisionChannel,
  why?: string,
): void {
  runtime.events.emit({
    kind: CONTRACT_DECIDED,
    runId: master.id,
    actor: `${actor.kind}:${actor.id}`,
    payload: {
      request: request.id,
      key: request.key,
      choice: "reject",
      ...(why?.trim() ? { why: why.trim() } : {}),
      channel,
    },
  });
  const agreed = splitOf(runtime, master)?.contract.find((c) => c.id === request.item);
  const asking = runtime.runs.get(request.run);
  if (!asking || isTerminal(asking.state)) return;
  addNote(
    runtime,
    asking,
    `The master keeps the contract as agreed${agreed ? `: ${itemLine(agreed)}` : ""}${why?.trim() ? ` — ${why.trim()}` : ""}. Work with it as written.`,
    actor.id,
  );
  resumeSubtask(runtime, asking);
}

/**
 * The library a subtask waits for after its contract change was accepted as that library's change: its
 * subtask not yet accepted and published (nor dropped). Undefined once it is — the run goes on.
 */
export function libraryAwaited(
  runtime: Runtime,
  master: Run,
  run: Run,
): { readonly key: string; readonly service: string } | undefined {
  const asked = contractChangeAsked(runtime, run);
  if (!asked) return undefined;
  const added = contractDecisionOf(runtime, master.id, asked.id)?.added;
  if (!added?.library) return undefined;
  const view = subtasksOf(runtime, master).find((v) => v.subtask.key === added.key);
  const ready =
    !view || view.state === "dropped" || (view.state === "COMPLETED" && view.published?.ok === true);
  return ready ? undefined : { key: added.key, service: added.service };
}

/**
 * Subtasks parked for a library's change go on once it is accepted and published (or dropped): each
 * asks again in its scope step, which lets it through to the impact with the new version.
 */
export function resumeLibraryWaiters(runtime: Runtime, master: Run): string[] {
  const resumed: string[] = [];
  for (const [key, run] of childrenOf(runtime, master.id)) {
    if (run.state !== "WAITING_HUMAN" || run.waitingFor?.kind !== "contract") continue;
    const asked = contractChangeAsked(runtime, run);
    const added = asked ? contractDecisionOf(runtime, master.id, asked.id)?.added : undefined;
    if (!added?.library || libraryAwaited(runtime, master, run)) continue;
    resumeSubtask(runtime, run);
    resumed.push(key);
  }
  return resumed;
}
