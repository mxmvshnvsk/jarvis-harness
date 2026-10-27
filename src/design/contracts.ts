import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type CodeContracts,
  type ConfigHit,
  configNamedIn,
  type TopicHit,
  topicsNamedIn,
} from "./codeContracts.ts";

/**
 * API methods the task's sources name (`GET /delivery-slots`), checked by code against the project's
 * contract maps (`contracts` in .jarvis/project.yaml: e.g. a BFF's route map that a test keeps true).
 * Pilot: the research agent spent ~25 tool calls reading a BFF's code to learn that a method had no
 * route yet — a question one lookup in the map settles.
 */

export interface ContractMapConfig {
  /** Files relative to the repository root; `*` in the file name (`__snapshots__/services-*.json`). */
  readonly files: readonly string[];
  /** What the map is, in a few words, for the agents. */
  readonly about?: string | undefined;
}

/** One entry of a map: its key (an object map's), a method if the map has one, and the paths it names. */
export interface ContractEntry {
  readonly file: string;
  readonly key?: string;
  readonly method?: string;
  readonly path?: string;
  readonly url?: string;
  /** An endpoint of the repository's code (src/design/codeContracts.ts): where it is declared. */
  readonly line?: number;
  /** Served here (`in`) or called through a client of another service (`out`). */
  readonly direction?: "in" | "out";
  readonly client?: string;
}

export interface Mention {
  readonly method: string;
  readonly path: string;
  readonly from: string;
}

const METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD";
const MENTION = new RegExp(
  `\\b(${METHODS})(?:\\s|&nbsp;|\\\\u00a0)+((?:https?:\\/\\/[^\\s/"'\`<>]+)?\\/[^\\s"'\`<>)\\],;|\\\\]*)`,
  "g",
);

/** `GET /path` in the texts, once per method and path, in the order found. */
export function mentionsIn(sources: ReadonlyArray<{ from: string; text: string }>): Mention[] {
  const seen = new Set<string>();
  const out: Mention[] = [];
  for (const s of sources)
    for (const m of s.text.matchAll(MENTION)) {
      const method = m[1] as string;
      const path = (m[2] as string).replace(/[.:]+$/, "");
      if (segmentsOf(path).length === 0) continue;
      const id = `${method} ${segmentsOf(path).join("/").toLowerCase()}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ method, path, from: s.from });
    }
  return out;
}

/** `/a/{id}/b?x=1`, `http://host/a/b/` → its segments, without host, query and empty parts. */
export function segmentsOf(path: string): string[] {
  const bare = path
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/[?#].*$/, "")
    .trim();
  return bare.split("/").filter((s) => s.length > 0);
}

const isParam = (s: string) => /^\$?\{[^}]*\}$/.test(s) || /^:[A-Za-z_]/.test(s);
const sameSegment = (a: string, b: string) => isParam(a) || isParam(b) || a.toLowerCase() === b.toLowerCase();

/** The mention's segments are the end of the target's (`/delivery-slots` in `/logistics-api/delivery-slots`). */
function endsWith(target: string | undefined, mention: readonly string[]): boolean {
  if (!target) return false;
  const t = segmentsOf(target);
  if (mention.length > t.length) return false;
  const tail = t.slice(t.length - mention.length);
  if (!mention.every((s, i) => sameSegment(s, tail[i] as string))) return false;
  // a parameter matches any segment, so at least one named segment must match one: `/lead` is not
  // `/api/invoices/{id}`
  return mention.some((s, i) => !isParam(s) && !isParam(tail[i] as string));
}

/**
 * The entries a mention names. A whole path or url that matches wins over ends that do: `POST /api/orders`
 * is the route `/api/orders`, not every url that ends in `{type}/orders`.
 */
export function matchesOf(mention: Mention, entries: readonly ContractEntry[]): ContractEntry[] {
  const segs = segmentsOf(mention.path);
  const whole = (target: string | undefined) => !!target && segmentsOf(target).length === segs.length;
  const found = entries.filter(
    (e) =>
      (!e.method || e.method.toUpperCase() === mention.method) &&
      (endsWith(e.url, segs) || endsWith(e.path, segs)),
  );
  const exact = found.filter(
    (e) => (whole(e.url) && endsWith(e.url, segs)) || (whole(e.path) && endsWith(e.path, segs)),
  );
  return exact.length > 0 ? exact : found;
}

/** The files a pattern names: `*` only in the file name. */
function filesOf(root: string, pattern: string): string[] {
  if (pattern.startsWith("/") || pattern.split("/").includes("..")) return [];
  if (!pattern.includes("*")) return existsSync(join(root, pattern)) ? [pattern] : [];
  const dir = dirname(pattern);
  const abs = join(root, dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return [];
  const name = new RegExp(
    `^${basename(pattern)
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return readdirSync(abs)
    .filter((f) => name.test(f))
    .sort()
    .map((f) => (dir === "." ? f : `${dir}/${f}`));
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The entries of a JSON map: an object of key → entry, or an array of entries. */
export function entriesOf(file: string, json: unknown): ContractEntry[] {
  const one = (v: unknown, key?: string): ContractEntry | undefined => {
    if (!v || typeof v !== "object") return undefined;
    const o = v as Record<string, unknown>;
    const path = str(o.path);
    const url = str(o.url);
    if (!path && !url) return undefined;
    const method = str(o.method);
    return {
      file,
      ...(key ? { key } : {}),
      ...(method ? { method } : {}),
      ...(path ? { path } : {}),
      ...(url ? { url } : {}),
    };
  };
  const list = Array.isArray(json)
    ? json.map((v) => one(v))
    : json && typeof json === "object"
      ? Object.entries(json as Record<string, unknown>).map(([k, v]) => one(v, k))
      : [];
  return list.filter((e): e is ContractEntry => e !== undefined);
}

export interface ContractCheck {
  readonly files: readonly string[];
  readonly entries: number;
  readonly about: readonly string[];
  readonly results: ReadonlyArray<{ mention: Mention; matches: ContractEntry[] }>;
  /** Files named in the config that were not there or not JSON. */
  readonly unreadable: readonly string[];
  /** Endpoints of the repository's code checked too (project graph). */
  readonly codeEndpoints?: number;
  /** Topics the sources name, found in the code's config. */
  readonly topics?: readonly TopicHit[];
  /** Config keys the sources name, with the classes that read them. */
  readonly config?: readonly ConfigHit[];
}

/** The entries of the maps a configuration names, the files read and those that could not be. */
export function mapEntriesOf(
  root: string,
  maps: readonly ContractMapConfig[],
): { files: string[]; unreadable: string[]; entries: ContractEntry[] } {
  const files: string[] = [];
  const unreadable: string[] = [];
  const entries: ContractEntry[] = [];
  for (const map of maps)
    for (const pattern of map.files) {
      const found = filesOf(root, pattern);
      if (found.length === 0) unreadable.push(pattern);
      for (const f of found)
        try {
          entries.push(...entriesOf(f, JSON.parse(readFileSync(join(root, f), "utf8"))));
          files.push(f);
        } catch {
          unreadable.push(f);
        }
    }
  return { files, unreadable, entries };
}

/** A BFF's snapshot maps (`__snapshots__/routes-*.json`, `services-*.json`) a test keeps true. */
const SNAPSHOT_MAP = /(^|\/)__snapshots__\/(routes|services)-[^/]+\.json$/;

/**
 * Maps a repository keeps without saying so: a BFF's route and service snapshots, as the folders
 * that hold them (`apps/server/__snapshots__/routes-*.json`). Pilot: a BFF calls its backends through
 * a map in its configuration, not from code, so its contracts.json said it served and called nothing.
 */
export function snapshotMapsIn(tracked: readonly string[]): ContractMapConfig[] {
  const patterns = new Set<string>();
  for (const f of tracked) {
    const m = SNAPSHOT_MAP.exec(f);
    if (!m) continue;
    patterns.add(`${f.slice(0, f.lastIndexOf("/"))}/${m[2]}-*.json`);
  }
  return [...patterns].sort().map((p) => ({ files: [p], about: "a snapshot map kept true by a test" }));
}

/**
 * Every mention against every map the project names and the contracts of its code (`code`, from the
 * project graph); undefined when there is nothing to check against or nothing is mentioned.
 */
export function checkContracts(
  root: string,
  maps: readonly ContractMapConfig[],
  sources: ReadonlyArray<{ from: string; text: string }>,
  code?: CodeContracts,
): ContractCheck | undefined {
  const fromCode = code ?? { endpoints: [], topics: [], listeners: [] };
  if (
    maps.length === 0 &&
    fromCode.endpoints.length === 0 &&
    fromCode.topics.length === 0 &&
    (fromCode.config ?? []).length === 0
  )
    return undefined;
  const all = mentionsIn(sources);
  // a method checks only against something: the code's endpoints or a map
  const mentions = maps.length > 0 || fromCode.endpoints.length > 0 ? all : [];
  const topics = topicsNamedIn(sources, fromCode);
  const config = configNamedIn(sources, fromCode);
  if (mentions.length === 0 && topics.length === 0 && config.length === 0) return undefined;
  const { files, unreadable, entries } = mapEntriesOf(root, maps);
  entries.push(...fromCode.endpoints);
  return {
    files,
    entries: entries.length - fromCode.endpoints.length,
    about: maps.flatMap((m) => (m.about ? [m.about] : [])),
    results: mentions.map((mention) => ({ mention, matches: matchesOf(mention, entries) })),
    unreadable,
    ...(fromCode.endpoints.length > 0 ? { codeEndpoints: fromCode.endpoints.length } : {}),
    ...(topics.length > 0 ? { topics } : {}),
    ...(config.length > 0 ? { config } : {}),
  };
}

const MAX_MATCHES = 3;

/** The section of `sources.md`: what was found and what not, settled for the agents. */
export function contractsSection(check: ContractCheck): string {
  const where = (e: ContractEntry) => `${basename(e.file)}${e.line ? `:${e.line}` : ""}`;
  const lines = check.results.map(({ mention, matches }) => {
    const head = `- \`${mention.method} ${mention.path}\` (${mention.from})`;
    if (matches.length === 0)
      return `${head} — **${check.codeEndpoints ? (check.files.length > 0 ? "not in the map nor in the code" : "not in the code") : "not in the map"}**`;
    // the same entry in several files (one map per app) is one line with its files
    const byEntry = new Map<string, { e: ContractEntry; files: string[] }>();
    for (const e of matches) {
      const id = `${e.key ?? ""}|${e.method ?? ""}|${e.path ?? ""}|${e.url ?? ""}|${e.direction ?? ""}`;
      const had = byEntry.get(id);
      if (had) had.files.push(where(e));
      else byEntry.set(id, { e, files: [where(e)] });
    }
    const shown = [...byEntry.values()].slice(0, MAX_MATCHES).map(({ e, files }) => {
      const parts = [
        e.key ? `\`${e.key}\`` : undefined,
        e.method ? e.method : undefined,
        e.path ? `path \`${e.path}\`` : undefined,
        e.url ? `url \`${e.url}\`` : undefined,
        e.direction === "out"
          ? `called here through the client of ${e.client ? `\`${e.client}\`` : "another service"}`
          : undefined,
        e.direction === "in" ? "served here" : undefined,
      ].filter(Boolean);
      return `${parts.join(" · ")} (${files.join(", ")})`;
    });
    const more = byEntry.size > MAX_MATCHES ? `; ${byEntry.size - MAX_MATCHES} more` : "";
    return `${head} — ${matches.every((m) => m.direction) ? "in the code" : "in the map"}: ${shown.join("; ")}${more}`;
  });
  const against = [
    ...(check.files.length > 0 || !check.codeEndpoints
      ? [
          `${check.files.map((f) => `\`${f}\``).join(", ") || "no readable file"} (${check.entries} entries${check.about.length > 0 ? ` — ${check.about.join("; ")}` : ""})`,
        ]
      : []),
    ...(check.codeEndpoints
      ? [
          `the HTTP endpoints of this repository's code (${check.codeEndpoints}, from the project graph: served here, or called through a client of another service)`,
        ]
      : []),
  ].join(" and ");
  const methods =
    check.results.length > 0
      ? [
          "## API methods named in the sources, checked against the contract map",
          "",
          `Checked by Jarvis without a model: every \`METHOD /path\` in the task, its issues and pages, against ${against}. ${
            check.codeEndpoints
              ? "What is here is settled — do not search the code for these methods again; a method not found is neither served nor called by this code yet."
              : "The map is the source of truth: what is here is settled — do not search the code for these methods again; a method not in the map has no route to it yet."
          }`,
          ...(check.unreadable.length > 0
            ? ["", `Not read: ${check.unreadable.map((f) => `\`${f}\``).join(", ")}.`]
            : []),
          "",
          ...lines,
        ]
      : [];
  const topics = (check.topics ?? []).map((h) => {
    const config = h.topics.map(
      (t) => `\`${t.topic}\` — property \`${t.property}\` (${basename(t.file)}${t.line ? `:${t.line}` : ""})`,
    );
    const listeners = h.listeners.map(
      (l) =>
        `${l.handler ? `\`${l.handler}\`` : "a listener"} (${basename(l.file)}${l.line ? `:${l.line}` : ""})`,
    );
    const senders =
      h.senders && h.senders.length > 0 ? `; sent by ${h.senders.map((x) => `\`${x}\``).join(", ")}` : "";
    return `- \`${h.name}\` (${h.from})${config.length > 0 ? ` — ${config.join("; ")}` : ""}${listeners.length > 0 ? `; listened to by ${listeners.join(", ")}` : "; no listener in this code"}${senders}`;
  });
  const topicPart =
    topics.length > 0
      ? [
          ...(methods.length > 0 ? [""] : []),
          "## Message topics named in the sources, found in the code",
          "",
          "Found by Jarvis without a model in the repository's config and listeners (project graph): the property a topic is configured under and the code that listens to it. Settled — do not search for them again. A topic per environment may differ from the one in the config.",
          "",
          ...topics,
        ]
      : [];
  const configLines = (check.config ?? []).map(
    (h) =>
      `- \`${h.key}\` (${h.from}) — read by ${h.readers.map((r) => `\`${r.type}\` (${basename(r.file)}${r.line ? `:${r.line}` : ""}, ${r.via})`).join(", ")}`,
  );
  const configPart =
    configLines.length > 0
      ? [
          ...(methods.length > 0 || topicPart.length > 0 ? [""] : []),
          "## Config keys named in the sources, found in the code",
          "",
          "Found by Jarvis without a model: the class that reads each key (`@ConfigurationProperties` prefix or `@Value`). Settled — do not search for them again.",
          "",
          ...configLines,
        ]
      : [];
  return [...methods, ...topicPart, ...configPart].join("\n");
}
