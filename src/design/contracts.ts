import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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

const isParam = (s: string) => /^\{[^}]*\}$/.test(s) || /^:[A-Za-z_]/.test(s);
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
}

/** Every mention against every map the project names; undefined when it names none or nothing is mentioned. */
export function checkContracts(
  root: string,
  maps: readonly ContractMapConfig[],
  sources: ReadonlyArray<{ from: string; text: string }>,
): ContractCheck | undefined {
  if (maps.length === 0) return undefined;
  const mentions = mentionsIn(sources);
  if (mentions.length === 0) return undefined;
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
  return {
    files,
    entries: entries.length,
    about: maps.flatMap((m) => (m.about ? [m.about] : [])),
    results: mentions.map((mention) => ({ mention, matches: matchesOf(mention, entries) })),
    unreadable,
  };
}

const MAX_MATCHES = 3;

/** The section of `sources.md`: what was found and what not, settled for the agents. */
export function contractsSection(check: ContractCheck): string {
  const lines = check.results.map(({ mention, matches }) => {
    const head = `- \`${mention.method} ${mention.path}\` (${mention.from})`;
    if (matches.length === 0) return `${head} — **not in the map**`;
    // the same entry in several files (one map per app) is one line with its files
    const byEntry = new Map<string, { e: ContractEntry; files: string[] }>();
    for (const e of matches) {
      const id = `${e.key ?? ""}|${e.method ?? ""}|${e.path ?? ""}|${e.url ?? ""}`;
      const had = byEntry.get(id);
      if (had) had.files.push(basename(e.file));
      else byEntry.set(id, { e, files: [basename(e.file)] });
    }
    const shown = [...byEntry.values()].slice(0, MAX_MATCHES).map(({ e, files }) => {
      const parts = [
        e.key ? `\`${e.key}\`` : undefined,
        e.method ? e.method : undefined,
        e.path ? `path \`${e.path}\`` : undefined,
        e.url ? `url \`${e.url}\`` : undefined,
      ].filter(Boolean);
      return `${parts.join(" · ")} (${files.join(", ")})`;
    });
    const more = byEntry.size > MAX_MATCHES ? `; ${byEntry.size - MAX_MATCHES} more` : "";
    return `${head} — in the map: ${shown.join("; ")}${more}`;
  });
  return [
    "## API methods named in the sources, checked against the contract map",
    "",
    `Checked by Jarvis without a model: every \`METHOD /path\` in the task, its issues and pages, against ${check.files.map((f) => `\`${f}\``).join(", ") || "no readable file"} (${check.entries} entries${check.about.length > 0 ? ` — ${check.about.join("; ")}` : ""}). The map is the source of truth: what is here is settled — do not search the code for these methods again; a method not in the map has no route to it yet.`,
    ...(check.unreadable.length > 0
      ? ["", `Not read: ${check.unreadable.map((f) => `\`${f}\``).join(", ")}.`]
      : []),
    "",
    ...lines,
  ].join("\n");
}
