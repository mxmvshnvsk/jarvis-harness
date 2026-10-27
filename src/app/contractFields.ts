import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  compareFields,
  type DtoDecl,
  dtoDeclsOf,
  endpointTypesOf,
  type FieldRow,
  isDtoSource,
  listenedTypeOf,
  sentTypeOf,
} from "../adapters/dtoFields.ts";
import type { Run } from "../core/domain/run.ts";
import { parseEndpoint, type ServiceContracts, sameEndpoint } from "../knowledge/catalog.ts";
import { changedFiles } from "../knowledge/check.ts";
import { trackedFiles } from "../onboarding/scan.ts";
import type { ContractItem } from "./subtasks.ts";

/**
 * The fields of a contract's DTOs in the subtasks' checkouts (ADR-0025 §6): the type each side
 * declares — the payload a topic's sender and listener name, an endpoint's body and response, a DTO
 * the contract names — looked up in the checkout, the files the subtask changed first, and compared
 * field by field between the side that writes it and the side that reads it. No model; the same
 * checkouts give the same report.
 */
export type DtoRole = "payload" | "request" | "response" | "dto";

export interface DtoCheck {
  readonly role: DtoRole;
  /** The type's name (the writer's, where the two differ). */
  readonly dto: string;
  /** Who serializes it, who reads it: the producer and a consumer, the other way for a request body. */
  readonly writer: string;
  readonly reader: string;
  readonly writerAt?: string;
  readonly readerAt?: string;
  readonly fields?: readonly FieldRow[];
  /** Why the fields are not checked. */
  readonly note?: string;
}

/** A subtask's checkout: its source files, the changed ones first, read once. */
export class Checkout {
  private readonly texts = new Map<string, string>();
  private readonly found = new Map<string, DtoDecl | undefined>();

  readonly root: string;
  readonly files: readonly string[];
  readonly changed: ReadonlySet<string>;

  constructor(root: string, files: readonly string[], changed: ReadonlySet<string>) {
    this.root = root;
    this.files = files;
    this.changed = changed;
  }

  read(file: string): string {
    let text = this.texts.get(file);
    if (text === undefined) {
      try {
        text = readFileSync(join(this.root, file), "utf8");
      } catch {
        text = "";
      }
      this.texts.set(file, text);
    }
    return text;
  }

  /** Where the type is declared: a file named after it, then a changed file, then any source. */
  findDto(name: string): DtoDecl | undefined {
    if (this.found.has(name)) return this.found.get(name);
    const sources = this.files.filter(isDtoSource);
    const named = sources.filter((f) => basename(f).replace(/\.\w+$/, "") === name);
    const changedFirst = (list: readonly string[]) => [
      ...list.filter((f) => this.changed.has(f)),
      ...list.filter((f) => !this.changed.has(f)),
    ];
    // an enum is a type of the contract too (pilot: EmailType «not declared» in the library declaring it)
    const declares = new RegExp(`\\b(class|record|interface|type|enum)\\s+${name}\\b`);
    let decl: DtoDecl | undefined;
    for (const file of [...changedFirst(named), ...changedFirst(sources)]) {
      const text = this.read(file);
      if (!declares.test(text)) continue;
      decl = dtoDeclsOf(file, text).find((d) => d.name === name);
      if (decl) break;
    }
    this.found.set(name, decl);
    return decl;
  }
}

/** The checkout of a subtask's run: tracked and untracked files, changed against its base. */
export async function checkoutOf(run: Run): Promise<Checkout | undefined> {
  const root = run.workspace.path;
  if (!existsSync(root)) return undefined;
  const changed = await changedFiles(root, run.workspace.baseCommit ?? run.workspace.baseRef);
  const tracked = await trackedFiles(root);
  const files = [...new Set([...tracked, ...changed])].sort();
  return new Checkout(root, files, new Set(changed));
}

export interface SideFacts {
  readonly service: string;
  readonly facts?: ServiceContracts;
  readonly checkout?: Checkout;
}

const handlerMethod = (handler: string | undefined) => handler?.split(".").at(-1);

/** The types one side declares for a contract item: what it sends or reads, its body and response. */
function typesOf(item: ContractItem, side: SideFacts, producer: boolean): Partial<Record<DtoRole, string>> {
  const { facts, checkout } = side;
  if (item.kind === "dto") return { dto: item.id.replace(/^.*\./, "") };
  if (!facts || !checkout) return {};
  if (item.kind === "topic") {
    if (producer) {
      for (const t of facts.produces.filter((p) => p.topic === item.id)) {
        const type = sentTypeOf(checkout.read(t.file));
        if (type) return { payload: type };
      }
      return {};
    }
    for (const t of facts.consumes.filter((c) => c.topic === item.id)) {
      const method = handlerMethod(t.handler);
      const type = method ? listenedTypeOf(checkout.read(t.file), method) : undefined;
      if (type) return { payload: type };
    }
    return {};
  }
  const wanted = parseEndpoint(item.id);
  const hit = producer
    ? facts.serves.find((e) => sameEndpoint(e, wanted))
    : facts.calls.find((e) => sameEndpoint(e, wanted, item.producer));
  const method = handlerMethod(hit?.handler);
  if (!hit || !method) return {};
  return endpointTypesOf(checkout.read(hit.file), method) ?? {};
}

const at = (d: DtoDecl) => `${d.file}:${d.line}`;

/**
 * The DTOs of a contract item between its producer and one consumer, field by field. A role neither
 * side declares a type for is left out; one only a side declares is said, not checked.
 */
export function dtoChecksOf(item: ContractItem, producer: SideFacts, consumer: SideFacts): DtoCheck[] {
  const p = typesOf(item, producer, true);
  const c = typesOf(item, consumer, false);
  const roles: DtoRole[] =
    item.kind === "dto" ? ["dto"] : item.kind === "topic" ? ["payload"] : ["request", "response"];
  const out: DtoCheck[] = [];
  for (const role of roles) {
    const pType = p[role];
    const cType = c[role];
    if (!pType && !cType) continue;
    // a request body goes from the consumer (the client) to the producer (the server)
    const consumerWrites = role === "request";
    const writer = consumerWrites ? consumer : producer;
    const reader = consumerWrites ? producer : consumer;
    const wType = consumerWrites ? cType : pType;
    const rType = consumerWrites ? pType : cType;
    const base = { role, dto: wType ?? rType ?? "", writer: writer.service, reader: reader.service };
    if (!wType || !rType) {
      const blind = !wType ? writer.service : reader.service;
      out.push({ ...base, note: `the type is not declared in ${blind}: fields not checked` });
      continue;
    }
    const wDecl = writer.checkout?.findDto(wType);
    const rDecl = reader.checkout?.findDto(rType);
    const located = {
      ...(wDecl ? { writerAt: at(wDecl) } : {}),
      ...(rDecl ? { readerAt: at(rDecl) } : {}),
    };
    if (!wDecl || !rDecl) {
      const [who, name] = !wDecl ? [writer.service, wType] : [reader.service, rType];
      out.push({
        ...base,
        ...located,
        note: `${name} is not declared in ${who}'s checkout (a library's type?): fields not checked`,
      });
      continue;
    }
    out.push({ ...base, ...located, fields: compareFields(wDecl, rDecl) });
  }
  return out;
}

/** Any field of the checks that does not hold. */
export const fieldsMismatch = (checks: readonly DtoCheck[]): boolean =>
  checks.some((c) => (c.fields ?? []).some((f) => f.status === "mismatch"));
