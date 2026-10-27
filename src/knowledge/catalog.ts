import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { isPlainObject } from "../core/config/merge.ts";
import { metaConfigFile } from "../core/paths.ts";
import type { CodeContracts } from "../design/codeContracts.ts";
import type { ContractEntry } from "../design/contracts.ts";

/**
 * The contract catalog of a knowledge repository (ADR-0025 §4): what each service serves, calls, sends
 * and reads, from `knowledge/services/<service>/contracts.json` that `onboard` writes, and the links
 * between services built from them — without a model. Topics link by name; an HTTP client links to
 * the service whose name is the first segment of its address through the balancer
 * (`http://${SERVICE_HOST}/<service>`), or its `services.<name>.path`. Built in memory: nothing
 * shared is committed, so PRs of different services do not conflict.
 */
export const CONTRACTS_FILE = "contracts.json";
export const CONTRACTS_VERSION = 1;

export interface ServedEndpoint {
  readonly method?: string;
  readonly path: string;
  readonly handler?: string;
  readonly file: string;
  readonly line?: number;
}

export interface CalledEndpoint extends ServedEndpoint {
  readonly client?: string;
  /** The client's address with the configuration's placeholders resolved where it could be. */
  readonly url?: string;
}

export interface ProducedTopic {
  readonly topic: string;
  readonly property?: string;
  /** The classes that send to it. */
  readonly senders: readonly string[];
  readonly file: string;
  readonly line?: number;
}

export interface ConsumedTopic {
  readonly topic: string;
  readonly property?: string;
  readonly handler?: string;
  readonly file: string;
  readonly line?: number;
}

export interface ServiceContracts {
  readonly version: number;
  readonly service: string;
  /** The service's commit the facts are of. */
  readonly commit?: string;
  readonly serves: readonly ServedEndpoint[];
  readonly calls: readonly CalledEndpoint[];
  readonly produces: readonly ProducedTopic[];
  readonly consumes: readonly ConsumedTopic[];
}

/** `${a.b}` placeholders resolved from the configuration, twice at most; unknown ones stay. */
export function resolvePlaceholders(text: string, config: Readonly<Record<string, string>>): string {
  let out = text;
  for (let i = 0; i < 2; i++)
    out = out.replace(/\$\{([^}:]+)(?::[^}]*)?\}/g, (m, key: string) => config[key.trim()] ?? m);
  return out;
}

const compact = <T>(o: Record<string, unknown>): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as T;

/** The client of a call a contract map names (not seen in code): its backend may go by another name. */
export const MAP_CLIENT = "map";

/**
 * The endpoints a contract map names (src/design/contracts.ts), as `contracts.json` keeps them: an
 * entry with a `url` is a call to another service (its path — the URL's), one with a `path` is served
 * here; a BFF's service map has both — the route it serves and the backend it passes it to.
 */
export function mapEndpointsOf(entries: readonly ContractEntry[]): {
  serves: ServedEndpoint[];
  calls: CalledEndpoint[];
} {
  const serves = new Map<string, ServedEndpoint>();
  const calls = new Map<string, CalledEndpoint>();
  for (const e of entries) {
    if (e.direction) continue; // the code's own endpoints are counted from the code
    if (e.path) {
      const key = `${e.method ?? ""} ${e.path}`;
      if (!serves.has(key))
        serves.set(
          key,
          compact<ServedEndpoint>({ method: e.method, path: e.path, handler: e.key, file: e.file }),
        );
    }
    if (e.url) {
      const path = e.url.replace(/^[a-z]+:\/\/[^/]*/i, "") || "/";
      const key = `${e.method ?? ""} ${e.url}`;
      if (!calls.has(key))
        calls.set(
          key,
          compact<CalledEndpoint>({
            method: e.method,
            path,
            url: e.url,
            handler: e.key,
            file: e.file,
            client: MAP_CLIENT,
          }),
        );
    }
  }
  return { serves: [...serves.values()], calls: [...calls.values()] };
}

/** A service's contracts with what its maps add: an endpoint the code already has is not doubled. */
export function withMapEndpoints(doc: ServiceContracts, entries: readonly ContractEntry[]): ServiceContracts {
  const { serves, calls } = mapEndpointsOf(entries);
  const has = (list: readonly ServedEndpoint[], e: ServedEndpoint) =>
    list.some((x) => x.path === e.path && (!x.method || !e.method || x.method === e.method));
  return {
    ...doc,
    serves: [...doc.serves, ...serves.filter((e) => !has(doc.serves, e))],
    calls: [
      ...doc.calls,
      ...calls.filter((e) => !doc.calls.some((x) => x.url === e.url && x.path === e.path)),
    ],
  };
}

/** A service's contracts from its code (src/design/codeContracts.ts), as `contracts.json` keeps them. */
export function serviceContractsOf(
  service: string,
  code: CodeContracts,
  config: Readonly<Record<string, string>>,
  commit?: string,
): ServiceContracts {
  const serves: ServedEndpoint[] = [];
  const calls: CalledEndpoint[] = [];
  for (const e of code.endpoints) {
    const base = compact<ServedEndpoint>({
      method: e.method,
      path: e.path ?? "/",
      handler: e.key,
      file: e.file,
      line: e.line,
    });
    if (e.direction === "out")
      calls.push(
        compact<CalledEndpoint>({
          ...base,
          client: e.client,
          url: e.url ? resolvePlaceholders(e.url, config) : undefined,
        }),
      );
    else serves.push(base);
  }
  // a topic by its value; a listener of a property reads the topic the configuration names
  const topicOfProperty = new Map(code.topics.map((t) => [t.property, t.topic]));
  const produces: ProducedTopic[] = [];
  for (const s of code.senders ?? [])
    for (const t of s.topics) {
      const known = produces.find((p) => p.topic === t.topic);
      if (known) {
        if (!known.senders.includes(s.type)) (known.senders as string[]).push(s.type);
        continue;
      }
      produces.push(
        compact<ProducedTopic>({
          topic: t.topic,
          property: t.property,
          senders: [s.type],
          file: s.file,
          line: s.line,
        }),
      );
    }
  const consumes: ConsumedTopic[] = [];
  for (const l of code.listeners) {
    const topic =
      l.topic ?? (l.property ? (topicOfProperty.get(l.property) ?? config[l.property]) : undefined);
    if (!topic) continue;
    consumes.push(
      compact<ConsumedTopic>({ topic, property: l.property, handler: l.handler, file: l.file, line: l.line }),
    );
  }
  const byText =
    <T>(key: (x: T) => string) =>
    (a: T, b: T) =>
      key(a).localeCompare(key(b));
  return {
    version: CONTRACTS_VERSION,
    service,
    ...(commit ? { commit } : {}),
    serves: serves.sort(byText((e) => `${e.path} ${e.method ?? ""} ${e.file}`)),
    calls: calls.sort(byText((e) => `${e.url ?? ""} ${e.path} ${e.method ?? ""} ${e.file}`)),
    produces: produces.sort(byText((t) => t.topic)),
    consumes: consumes.sort(byText((t) => `${t.topic} ${t.file}`)),
  };
}

/** The Spring configuration of a repository as dotted keys: `application*.yml` and `.properties`. */
export function springConfigOf(root: string, files: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const configs = files
    .filter((f) =>
      /(^|\/)src\/main\/resources\/(?:config\/)?(application|bootstrap)[\w-]*\.(ya?ml|properties)$/.test(f),
    )
    // the default profile first: `application.yml` before `application-dev.yml`
    .sort(
      (a, b) =>
        Number(/-\w+\.\w+$/.test(a.replace(/^.*\//, ""))) -
          Number(/-\w+\.\w+$/.test(b.replace(/^.*\//, ""))) || a.localeCompare(b),
    );
  const put = (key: string, value: unknown) => {
    if (
      out[key] === undefined &&
      (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    )
      out[key] = String(value);
  };
  const flatten = (value: unknown, prefix: string) => {
    if (isPlainObject(value))
      for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k);
    else put(prefix, value);
  };
  for (const f of configs) {
    let text: string;
    try {
      text = readFileSync(join(root, f), "utf8");
    } catch {
      continue;
    }
    if (f.endsWith(".properties")) {
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*([\w.-]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
        if (m && !line.trimStart().startsWith("#")) put(m[1] as string, m[2]);
      }
      continue;
    }
    try {
      for (const doc of YAML.parseAllDocuments(text)) flatten(doc.toJS(), "");
    } catch {
      // a broken config file: its keys stay unknown
    }
  }
  return out;
}

export interface Catalog {
  readonly services: ReadonlyMap<string, ServiceContracts>;
  readonly links: readonly CatalogLink[];
  /** HTTP calls whose address names no service of the map. */
  readonly unresolved: ReadonlyArray<{ readonly service: string; readonly call: CalledEndpoint }>;
}

export interface CatalogLink {
  readonly kind: "topic" | "http";
  /** The topic, or `METHOD /path` as the producer serves it. */
  readonly what: string;
  /** Sends the topic, or serves the endpoint. */
  readonly producer: string;
  /** Reads the topic, or calls the endpoint. */
  readonly consumer: string;
  /** An HTTP call to a service of the map whose endpoint was not found there: the link is to the service only. */
  readonly endpointFound: boolean;
  readonly producerAt?: string;
  readonly consumerAt?: string;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** `services.<name>.path` of the knowledge repository: the segment the balancer routes to it. */
function pathAliases(metaRoot: string): Map<string, string> {
  const aliases = new Map<string, string>();
  try {
    const value: unknown = YAML.parse(readFileSync(metaConfigFile(metaRoot), "utf8"));
    const services = isPlainObject(value) && isPlainObject(value.services) ? value.services : {};
    for (const [name, def] of Object.entries(services)) {
      aliases.set(name.toLowerCase(), name);
      if (isPlainObject(def) && typeof def.path === "string")
        aliases.set(def.path.replace(/^\/+|\/+$/g, "").toLowerCase(), name);
    }
  } catch {
    // no map: the folder names of services/ are the names
  }
  return aliases;
}

/** The segments of an address after its host: `http://${SERVICE_HOST}/slots-api/v1` → [slots-api, v1]. */
function segmentsOf(url: string): string[] {
  const rest = url.replace(/^[a-z]+:\/\//i, "").replace(/^\$\{[^}]*\}|^[^/]*/, "");
  return rest.split(/[/?#]/).filter((s) => s && !s.startsWith("$"));
}

const norm = (path: string) => `/${path.replace(/^\/+|\/+$/g, "").replace(/\{[^}]*\}/g, "{}")}`.toLowerCase();
const at = (e: { file: string; line?: number }) => (e.line ? `${e.file}:${e.line}` : e.file);

/** Which service an HTTP call goes to: the first address segment, else its client's name, else its path's first segment. */
function targetOf(call: CalledEndpoint, aliases: ReadonlyMap<string, string>): string | undefined {
  const candidates = [
    ...(call.url ? segmentsOf(call.url).slice(0, 1) : []),
    ...(call.client ? [call.client] : []),
    ...segmentsOf(call.path).slice(0, 1),
  ];
  for (const c of candidates) {
    const hit = aliases.get(c.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

/** Reads every service's `contracts.json` of a knowledge repository and links them. */
export function loadCatalog(metaRoot: string): Catalog {
  const dir = join(metaRoot, "knowledge", "services");
  const services = new Map<string, ServiceContracts>();
  if (existsSync(dir))
    for (const name of readdirSync(dir).sort()) {
      const doc = readJson(join(dir, name, CONTRACTS_FILE));
      if (isPlainObject(doc) && Array.isArray(doc.serves))
        services.set(name, { ...(doc as unknown as ServiceContracts), service: name });
    }
  const aliases = pathAliases(metaRoot);
  for (const name of services.keys())
    if (!aliases.has(name.toLowerCase())) aliases.set(name.toLowerCase(), name);
  const links: CatalogLink[] = [];
  const unresolved: Array<{ service: string; call: CalledEndpoint }> = [];
  // topics: who sends, who reads
  for (const [producer, p] of services)
    for (const t of p.produces)
      for (const [consumer, c] of services) {
        if (consumer === producer) continue;
        for (const l of c.consumes.filter((x) => x.topic === t.topic))
          links.push({
            kind: "topic",
            what: t.topic,
            producer,
            consumer,
            endpointFound: true,
            producerAt: at(t),
            consumerAt: at(l),
          });
      }
  // HTTP: the call's service by its address, its endpoint by method and path (with or without the segment)
  for (const [consumer, c] of services)
    for (const call of c.calls) {
      const producer = targetOf(call, aliases);
      if (!producer || producer === consumer) {
        if (!producer) unresolved.push({ service: consumer, call });
        continue;
      }
      const served = services.get(producer)?.serves ?? [];
      const segment = [...aliases].find(([, n]) => n === producer)?.[0] ?? producer;
      const wanted = new Set([
        norm(call.path),
        norm(
          call.path.replace(
            new RegExp(`^/?${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=/|$)`, "i"),
            "",
          ),
        ),
        norm(`/${segment}${call.path}`),
      ]);
      const hit = served.find(
        (e) => wanted.has(norm(e.path)) && (!e.method || !call.method || e.method === call.method),
      );
      links.push({
        kind: "http",
        what: `${call.method ? `${call.method} ` : ""}${hit?.path ?? call.path}`,
        producer,
        consumer,
        endpointFound: hit !== undefined,
        ...(hit ? { producerAt: at(hit) } : {}),
        consumerAt: at(call),
      });
    }
  const seen = new Set<string>();
  return {
    services,
    links: links
      .sort(
        (a, b) =>
          Number(a.kind === "http") - Number(b.kind === "http") ||
          a.what.localeCompare(b.what) ||
          a.producer.localeCompare(b.producer) ||
          a.consumer.localeCompare(b.consumer),
      )
      .filter((l) => {
        const key = `${l.kind}|${l.what}|${l.producer}|${l.consumer}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    unresolved,
  };
}

/**
 * A service's neighbours as a knowledge document for its agents (ADR-0025 §4): who reads and calls
 * what it provides, what it uses of others. Cards, not the other services' code. Undefined when the
 * catalog links it to nobody.
 */
export function neighboursDoc(catalog: Catalog, service: string): string | undefined {
  const out = catalog.links.filter((l) => l.producer === service);
  const uses = catalog.links.filter((l) => l.consumer === service);
  const unknown = catalog.unresolved.filter((u) => u.service === service);
  if (out.length === 0 && uses.length === 0 && unknown.length === 0) return undefined;
  const label = (l: CatalogLink) => (l.kind === "topic" ? `topic \`${l.what}\`` : `\`${l.what}\``);
  const group = (links: readonly CatalogLink[], side: "producer" | "consumer") => {
    const by = new Map<string, CatalogLink[]>();
    for (const l of links) by.set(label(l), [...(by.get(label(l)) ?? []), l]);
    return [...by].map(
      ([what, ls]) =>
        `- ${what} — ${ls.map((l) => `${l[side]}${l.kind === "http" && !l.endpointFound ? " (endpoint not found there)" : ""}`).join(", ")}`,
    );
  };
  return [
    `# Neighbours of ${service}`,
    "",
    "Generated from the services' contracts.json in the knowledge repository (ADR-0025 §4): what other services use of this one, and what it uses of them. A change to these is a change to them too.",
    "",
    "For the impact analysis: a requirement that another service must implement — its behaviour, not this service's code — goes to \"elsewhere\" with that service's name as written here and why; it is not an affected path of this service.",
    "",
    ...(out.length > 0 ? [`## Used by other services`, "", ...group(out, "consumer"), ""] : []),
    ...(uses.length > 0 ? [`## Used by ${service}`, "", ...group(uses, "producer"), ""] : []),
    ...(unknown.length > 0
      ? [
          "## Calls to an address that names no service",
          "",
          ...unknown.map(
            (u) =>
              `- \`${u.call.method ? `${u.call.method} ` : ""}${u.call.path}\`${u.call.url ? ` at \`${u.call.url}\`` : ""}${u.call.client ? ` (client ${u.call.client})` : ""}`,
          ),
          "",
        ]
      : []),
  ].join("\n");
}

const cached = new Map<string, { readonly key: string; readonly catalog: Catalog }>();

/** `loadCatalog`, read again only when a service's contracts.json or the map changed. */
export function catalogOf(metaRoot: string): Catalog {
  const dir = join(metaRoot, "knowledge", "services");
  const stamp = (file: string) => {
    try {
      const st = statSync(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "-";
    }
  };
  const names = existsSync(dir) ? readdirSync(dir).sort() : [];
  const key = [
    stamp(metaConfigFile(metaRoot)),
    ...names.map((n) => `${n}=${stamp(join(dir, n, CONTRACTS_FILE))}`),
  ].join("|");
  const hit = cached.get(metaRoot);
  if (hit?.key === key) return hit.catalog;
  const catalog = loadCatalog(metaRoot);
  cached.set(metaRoot, { key, catalog });
  return catalog;
}

/** `GET /delivery-slots/{id}` → method and path; a bare path has no method. */
export function parseEndpoint(id: string): { readonly method?: string; readonly path: string } {
  const m = /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i.exec(id);
  return m ? { method: (m[1] as string).toUpperCase(), path: m[2] as string } : { path: id.trim() };
}

/** The same endpoint: method (when both say it) and path, variables aside, with or without `segment` in front. */
export function sameEndpoint(
  a: { readonly method?: string; readonly path: string },
  b: { readonly method?: string; readonly path: string },
  segment?: string,
): boolean {
  if (a.method && b.method && a.method.toUpperCase() !== b.method.toUpperCase()) return false;
  const strip = (p: string) =>
    segment
      ? p.replace(new RegExp(`^/?${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=/|$)`, "i"), "")
      : p;
  const left = new Set([norm(a.path), norm(strip(a.path))]);
  return left.has(norm(b.path)) || left.has(norm(strip(b.path)));
}

/** A service the text names, and how: by its name, a topic it sends or reads, an endpoint it serves. */
export interface NamedService {
  readonly service: string;
  readonly by: string;
}

const mentions = (text: string, word: string) =>
  new RegExp(`(?<![\\w.-])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-]|\\.[\\w])`, "i").test(text);

/**
 * The services a task's text points at, without a model (ADR-0025 §7): their names, the topics they
 * send or read, the endpoints they serve (a path of two segments or more). For the New task hint and
 * the master's split.
 */
export function namedServices(catalog: Catalog, text: string, names: readonly string[]): NamedService[] {
  const out = new Map<string, string>();
  const add = (service: string, by: string) => {
    if (!out.has(service)) out.set(service, by);
  };
  for (const name of names) if (mentions(text, name)) add(name, "its name");
  for (const [service, c] of catalog.services) {
    for (const t of c.produces) if (mentions(text, t.topic)) add(service, `sends ${t.topic}`);
    for (const t of c.consumes) if (mentions(text, t.topic)) add(service, `reads ${t.topic}`);
    for (const e of c.serves) {
      const fixed = e.path.replace(/\{[^}]*\}.*$/, "").replace(/\/+$/, "");
      if (fixed.split("/").filter(Boolean).length >= 2 && text.includes(fixed))
        add(service, `serves ${e.path}`);
    }
  }
  return [...out]
    .map(([service, by]) => ({ service, by }))
    .sort((a, b) => a.service.localeCompare(b.service));
}

/** The catalog as a document for the master's agents: services, links, and what the text names. */
export function catalogDoc(
  catalog: Catalog,
  names: readonly string[],
  named: readonly NamedService[],
  /** Libraries of the map (`kind: library`): they change first, who uses them starts after. */
  libraries: ReadonlyArray<{
    readonly service: string;
    readonly publishes: readonly string[];
    readonly usedBy: readonly string[];
  }> = [],
): string {
  const without = names.filter((n) => !catalog.services.has(n));
  const linkLine = (l: CatalogLink) =>
    `- ${l.kind === "topic" ? `topic \`${l.what}\`` : `\`${l.what}\``}: ${l.producer} → ${l.consumer}${l.kind === "http" && !l.endpointFound ? " (endpoint not found in the producer)" : ""}`;
  const lines = [
    "# The services and their contracts",
    "",
    `Services of the map (use these names exactly): ${names.join(", ") || "none"}.`,
    ...(without.length > 0
      ? [`No contracts.json yet (their links are unknown): ${without.join(", ")}.`]
      : []),
    "",
    "## Named by the task and its specification",
    "",
    ...(named.length > 0
      ? named.map((n) => `- ${n.service} — ${n.by}`)
      : ["- none found by name, topic or endpoint"]),
    "",
    "## Links between services (producer → consumer)",
    "",
    ...(catalog.links.length > 0 ? catalog.links.map(linkLine) : ["- none known"]),
    "",
    ...(libraries.length > 0
      ? [
          "## Libraries of the map",
          "",
          "A library the change needs gets a subtask of its own, like a service: what changes in it, and its new version. Its users are not part of the task for that: only a service that changes for the task anyway gets a subtask, and that subtask moves it to the library's new version and says what it uses of it (Jarvis starts it once the library's change is accepted and published). A user that would only move to the new version gets no subtask: it stays on its version, in notInScope.",
          "",
          ...libraries.map(
            (l) =>
              `- ${l.service}${l.publishes.length > 0 ? ` (${l.publishes.join(", ")})` : ""} — used by ${l.usedBy.join(", ") || "no service of the map"}`,
          ),
          "",
        ]
      : []),
  ];
  for (const [service, c] of catalog.services) {
    lines.push(`## ${service}`, "");
    if (c.serves.length > 0)
      lines.push(
        `Serves: ${c.serves
          .slice(0, 30)
          .map((e) => `\`${e.method ? `${e.method} ` : ""}${e.path}\``)
          .join(", ")}${c.serves.length > 30 ? ` … +${c.serves.length - 30}` : ""}`,
      );
    if (c.produces.length > 0) lines.push(`Sends: ${c.produces.map((t) => `\`${t.topic}\``).join(", ")}`);
    if (c.consumes.length > 0)
      lines.push(`Reads: ${[...new Set(c.consumes.map((t) => `\`${t.topic}\``))].join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}
