import { basename } from "node:path";
import { type DtoDecl, dtoDeclsOf, isDtoSource, wireType } from "../adapters/dtoFields.ts";

/**
 * ADR-0026: the work of tasks related to the run's — their branches and pull requests — read before the
 * spec, by code, no model. A front task whose back is done in the back task's branch, not merged yet,
 * gets that contract as a fact with its branch, commit and PR, for research and spec to build on as a
 * dependency. Where the work is: the issue's Development panel in Jira (branches and PRs linked by the
 * team's commit rules), else the repository on this machine (git), else Bitbucket's tools. What is
 * taken from it: the contract — DTOs and their fields, endpoints — and how many other files changed.
 */

export interface ContractChange {
  readonly kind: "dto" | "endpoint";
  readonly name: string;
  readonly change: "added" | "removed" | "changed";
  readonly file: string;
  readonly fields?: ReadonlyArray<{
    readonly name: string;
    readonly change: "added" | "removed" | "type changed";
    readonly type?: string;
  }>;
}

export interface RelatedItem {
  readonly issue: string;
  readonly type?: string;
  readonly status?: string;
  readonly summary?: string;
  /** The service of the map, when the repository is one of it. */
  readonly service?: string;
  readonly repo?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly base?: string;
  readonly pr?: { readonly id?: string; readonly state?: string; readonly url?: string };
  /** How its work was found. */
  readonly found: "jira-dev-info" | "local-git" | "bitbucket" | "none";
  readonly contract: readonly ContractChange[];
  readonly files?: { readonly contract: number; readonly other: number };
  /** The Story it is in (or is), when the run's task is in one: its branch is compared with the Story's. */
  readonly story?: string;
  readonly note?: string;
}

export interface RelatedWorkDoc {
  readonly about: string;
  /** The issue the run is about. */
  readonly from: string;
  readonly items: readonly RelatedItem[];
  /** Related tasks with no branch or PR found. */
  readonly notFound: readonly string[];
  /** Why nothing was looked for: no epic, parent or links in the issue (said, not silent). */
  readonly note?: string;
  /** Related issues not read: past `relatedWork.maxIssues`. */
  readonly notRead?: readonly string[];
  /**
   * The run's task is in a Story (or is one): its branch (the same name in each repository), its
   * tasks, and whether the run started from that branch.
   */
  readonly story?: {
    readonly key: string;
    readonly branch: string;
    readonly tasks: readonly string[];
    readonly based?: boolean;
  };
  readonly checkedAt: string;
}

export const RELATED_WORK = "related-work";
export const RELATED_ABOUT =
  "The work of tasks related to this one, read by Jarvis before the agents: their branches and pull requests and the contract they change (DTO fields, endpoints). A branch not merged yet is a dependency, not a fact: write it in the spec's dependencies with its issue, branch, commit and PR state, and build on what the branch has — never on what it might have. When the task is in a Story (`story`), the tasks of the Story branch off the Story's branch and are merged into it: a task merged into the Story's branch is there, not in the base yet, until the Story's own PR is merged.";

/* ---- reading what the tools answer: they differ between servers, so by shape, not by schema ---- */

const KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g;

const body = (text: string): string => text.replace(/^\[[a-zA-Z.]+\] ok\n/, "");

function json(text: string): unknown {
  try {
    return JSON.parse(body(text));
  } catch {
    return undefined;
  }
}

/** Every object in a JSON value, with the key it was found under. */
function walk(v: unknown, under = "", out: Array<{ under: string; o: Record<string, unknown> }> = []) {
  if (Array.isArray(v)) for (const x of v) walk(x, under, out);
  else if (v && typeof v === "object") {
    out.push({ under, o: v as Record<string, unknown> });
    for (const [k, x] of Object.entries(v)) walk(x, k, out);
  }
  return out;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const named = (v: unknown): string | undefined =>
  str(v) ?? (v && typeof v === "object" ? str((v as Record<string, unknown>).name) : undefined);

export interface IssueFacts {
  readonly key?: string;
  readonly type?: string;
  readonly status?: string;
  readonly summary?: string;
  readonly parent?: string;
  readonly epic?: string;
  /**
   * Issue keys in nameless custom fields, the issue's own project first: one of them may be the Epic
   * Link (mcp-atlassian gives no field names) — the caller reads them and takes the one of type Epic.
   */
  readonly keyFields?: readonly string[];
  /** Keys of the issues it links to. */
  readonly links: readonly string[];
  /** Issue keys the issue's description names: the task's author pointed at them. */
  readonly mentions?: readonly string[];
}

/** An issue as `jira.get` returned it: its type, status, parent or epic and the issues it links. */
const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

/**
 * Epic Link on Jira Server/DC is a custom field: `customfield_NNNNN` holding the epic's key, named
 * "Epic Link" in the answer's `names` (expand=names) or in the field itself (`{name, value}` as the
 * community MCP server renders custom fields). The Jira UI shows the epic's name, the API its key.
 */
function epicField(doc: unknown, fields: Record<string, unknown>): string | undefined {
  const names =
    doc && typeof doc === "object" && (doc as Record<string, unknown>).names
      ? ((doc as Record<string, unknown>).names as Record<string, unknown>)
      : {};
  for (const [id, label] of Object.entries(names))
    if (typeof label === "string" && /^epic link$/i.test(label)) {
      const v = fields[id];
      const k =
        str(v) ?? (v && typeof v === "object" ? str((v as Record<string, unknown>).value) : undefined);
      if (k && ISSUE_KEY.test(k)) return k;
    }
  for (const { o } of walk(fields)) {
    const label = str(o.name) ?? str(o.fieldName) ?? str(o.field);
    if (!label || !/^epic link$/i.test(label)) continue;
    const k =
      str(o.value) ??
      (o.value && typeof o.value === "object" ? str((o.value as Record<string, unknown>).key) : undefined);
    if (k && ISSUE_KEY.test(k)) return k;
  }
  return undefined;
}

/**
 * Without the fields' names (mcp-atlassian gives custom fields as `customfield_NNNNN: {value}`) the
 * Epic Link is the custom field whose value is an issue's key — of the issue's own project first.
 */
function keysInCustomFields(fields: Record<string, unknown>, self: string | undefined): string[] {
  const keys: string[] = [];
  for (const [id, v] of Object.entries(fields)) {
    if (!id.startsWith("customfield_")) continue;
    const k = str(v) ?? (v && typeof v === "object" ? str((v as Record<string, unknown>).value) : undefined);
    if (k && ISSUE_KEY.test(k) && k !== self) keys.push(k);
  }
  const project = self?.split("-")[0];
  const unique = [...new Set(keys)];
  return [
    ...unique.filter((k) => k.split("-")[0] === project),
    ...unique.filter((k) => k.split("-")[0] !== project),
  ];
}

export function issueFacts(text: string): IssueFacts {
  const doc = json(text);
  const raw = body(text);
  const root = (doc && typeof doc === "object" ? doc : {}) as Record<string, unknown>;
  const fields = (root.fields && typeof root.fields === "object" ? root.fields : root) as Record<
    string,
    unknown
  >;
  const pick = (...names: string[]) => names.map((n) => fields[n] ?? root[n]).find((x) => x !== undefined);
  const parentOf = (v: unknown) =>
    str(v) ?? (v && typeof v === "object" ? str((v as Record<string, unknown>).key) : undefined);
  const key = str(root.key);
  const epic =
    parentOf(pick("epic", "epic_link", "epicLink", "epic_key", "Epic Link")) ??
    epicField(doc, fields) ??
    /"epic[_ ]?(?:link|key)?"\s*:\s*"([A-Z][A-Z0-9]+-\d+)"/i.exec(raw)?.[1] ??
    /"name"\s*:\s*"Epic Link"[^{}]{0,200}?"([A-Z][A-Z0-9]+-\d+)"/i.exec(raw)?.[1] ??
    /"([A-Z][A-Z0-9]+-\d+)"[^{}]{0,200}?"name"\s*:\s*"Epic Link"/i.exec(raw)?.[1];
  const parent = parentOf(pick("parent"));
  const keyFields = epic ? [] : keysInCustomFields(fields, key);
  const linkText = JSON.stringify(pick("issuelinks", "issue_links", "links") ?? "");
  const links = [...new Set(linkText.match(KEY) ?? [])].filter(
    (k) => k !== key && k !== parent && k !== epic,
  );
  const mentions = [...new Set(str(pick("description"))?.match(KEY) ?? [])].filter(
    (k) => k !== key && k !== parent && k !== epic && !links.includes(k),
  );
  const type = named(pick("issue_type", "issuetype", "issueType", "type"));
  const status = named(pick("status"));
  const summary = str(pick("summary"));
  return {
    ...(key ? { key } : {}),
    ...(type ? { type } : {}),
    ...(status ? { status } : {}),
    ...(summary ? { summary } : {}),
    ...(parent ? { parent } : {}),
    ...(epic ? { epic } : {}),
    ...(keyFields.length > 0 ? { keyFields } : {}),
    links,
    ...(mentions.length > 0 ? { mentions } : {}),
  };
}

export interface StoryLinks {
  readonly types: readonly string[];
  readonly includes: readonly string[];
  readonly includedIn: readonly string[];
}

export interface Inclusion {
  readonly key: string;
  readonly type?: string;
  readonly summary?: string;
}

/**
 * The issue's inclusion links (`relatedWork.story`): the issues it is included in (a task → its Story)
 * and the issues it includes (a Story → its tasks). Jira gives a link from the issue's side: the other
 * issue as `inwardIssue` — the other one's outward name points at this one («Включает в себя» it), so
 * this one is included in it; as `outwardIssue` — this one includes it.
 */
export function inclusionsOf(
  text: string,
  names: StoryLinks,
): { includedIn: Inclusion[]; includes: Inclusion[] } {
  const doc = json(text);
  const includedIn: Inclusion[] = [];
  const includes: Inclusion[] = [];
  if (doc === undefined) return { includedIn, includes };
  const lower = (xs: readonly string[]) => new Set(xs.map((x) => x.trim().toLowerCase()));
  const inNames = lower(names.includedIn);
  const outNames = lower(names.includes);
  const issueOf = (v: unknown): Inclusion | undefined => {
    if (!v || typeof v !== "object") return undefined;
    const o = v as Record<string, unknown>;
    const key = str(o.key);
    if (!key || !ISSUE_KEY.test(key)) return undefined;
    const fields = (o.fields && typeof o.fields === "object" ? o.fields : o) as Record<string, unknown>;
    const type = named(fields.issuetype ?? fields.issue_type ?? fields.type);
    const summary = str(fields.summary);
    return { key, ...(type ? { type } : {}), ...(summary ? { summary } : {}) };
  };
  for (const { o } of walk(doc)) {
    const t = o.type && typeof o.type === "object" ? (o.type as Record<string, unknown>) : undefined;
    if (!t) continue;
    const inward = str(t.inward)?.toLowerCase();
    const outward = str(t.outward)?.toLowerCase();
    const isInclusion = (!!inward && inNames.has(inward)) || (!!outward && outNames.has(outward));
    if (!isInclusion) continue;
    const other = issueOf(o.inward_issue ?? o.inwardIssue);
    if (other) includedIn.push(other);
    const mine = issueOf(o.outward_issue ?? o.outwardIssue);
    if (mine) includes.push(mine);
  }
  const unique = (xs: Inclusion[]) => xs.filter((x, i) => xs.findIndex((y) => y.key === x.key) === i);
  return { includedIn: unique(includedIn), includes: unique(includes) };
}

/** The Story the issue is in: the first issue it is included in that is a Story (or of no type said). */
export function storyOf(text: string, names: StoryLinks): string | undefined {
  const types = new Set(names.types.map((x) => x.toLowerCase()));
  const { includedIn } = inclusionsOf(text, names);
  return (
    includedIn.find((i) => i.type && types.has(i.type.toLowerCase())) ?? includedIn.find((i) => !i.type)
  )?.key;
}

/** The Story's branch by `relatedWork.story.branch`. */
export function storyBranch(pattern: string, key: string): string {
  return pattern.replaceAll("{key}", key);
}

/** The issues a `jira.search` answered: key, type, status, summary. */
export function searchHits(text: string): IssueFacts[] {
  const doc = json(text);
  if (doc === undefined) return [...new Set(body(text).match(KEY) ?? [])].map((key) => ({ key, links: [] }));
  const seen = new Set<string>();
  const out: IssueFacts[] = [];
  for (const { o } of walk(doc)) {
    const key = str(o.key);
    if (!key || !/^[A-Z][A-Z0-9]+-\d+$/.test(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(issueFacts(JSON.stringify(o)));
  }
  return out;
}

export interface DevBranch {
  readonly name: string;
  readonly repo?: { readonly workspace?: string; readonly slug: string };
  readonly url?: string;
}
export interface DevPr {
  readonly id?: string;
  readonly state?: string;
  readonly url?: string;
  readonly branch?: string;
  /** The branch it goes into: a task's PR into its Story's branch, the Story's into the base. */
  readonly destination?: string;
  readonly repo?: { readonly workspace?: string; readonly slug: string };
}

/** `…/projects/ORD/repos/orders-api/…` (Bitbucket Server) or `bitbucket.org/acme/orders-api`. */
export function repoOfUrl(url: string | undefined): { workspace?: string; slug: string } | undefined {
  if (!url) return undefined;
  const server = /\/projects\/([^/]+)\/repos\/([^/?#]+)/i.exec(url);
  if (server) return { workspace: server[1] as string, slug: server[2] as string };
  const cloud = /bitbucket\.org\/([^/]+)\/([^/?#]+)/i.exec(url);
  return cloud ? { workspace: cloud[1] as string, slug: cloud[2] as string } : undefined;
}

/** The branches and PRs of an issue's Development panel (`jira.devInfo`). */
export function devInfoOf(text: string): { branches: DevBranch[]; prs: DevPr[] } {
  const doc = json(text);
  const branches: DevBranch[] = [];
  const prs: DevPr[] = [];
  if (doc === undefined) return { branches, prs };
  for (const { under, o } of walk(doc)) {
    const u = under.toLowerCase();
    const repoObj =
      o.repository && typeof o.repository === "object"
        ? (o.repository as Record<string, unknown>)
        : undefined;
    const url = str(o.url) ?? str(repoObj?.url);
    const repoName = str(o.repositoryName) ?? str(o.repository_name) ?? named(o.repository);
    const repo = repoOfUrl(url) ?? (repoName ? { slug: repoName } : undefined);
    if (
      u.includes("pull") ||
      (o.status !== undefined && (o.source !== undefined || o.fromRef !== undefined))
    ) {
      const source = (o.source ?? o.fromRef ?? o.source_branch) as unknown;
      const branch =
        str(o.source_branch) ??
        str(o.sourceBranch) ??
        named(source) ??
        (source && typeof source === "object"
          ? (str((source as Record<string, unknown>).branch) ??
            str((source as Record<string, unknown>).displayId))
          : undefined);
      const id = str(o.id) ?? (typeof o.id === "number" ? String(o.id) : undefined);
      const target = (o.destination ?? o.toRef ?? o.destination_branch) as unknown;
      const destination =
        str(o.destination_branch) ??
        str(o.destinationBranch) ??
        named(target) ??
        (target && typeof target === "object"
          ? (str((target as Record<string, unknown>).branch) ??
            str((target as Record<string, unknown>).displayId))
          : undefined);
      prs.push({
        ...(destination ? { destination: destination.replace(/^refs\/heads\//, "") } : {}),
        ...(id ? { id } : {}),
        ...((str(o.status) ?? str(o.state)) ? { state: (str(o.status) ?? str(o.state)) as string } : {}),
        ...(str(o.url) ? { url: str(o.url) as string } : {}),
        ...(branch ? { branch } : {}),
        ...(repo ? { repo } : {}),
      });
    } else if (u.includes("branch") && str(o.name)) {
      branches.push({ name: str(o.name) as string, ...(repo ? { repo } : {}), ...(url ? { url } : {}) });
    }
  }
  return { branches, prs };
}

/**
 * The side of an issue's work: by its type (`relatedWork.sides`: "Front Task", "Middle Task"), else
 * by a prefix in its title (`relatedWork.prefixes`: "[Java] …", "[front] …" — any case), as teams
 * whose tasks are all "Change" name them.
 */
export function sideOfIssue(
  issue: Pick<IssueFacts, "type" | "summary">,
  sides: Readonly<Record<string, string>>,
  prefixes: Readonly<Record<string, string>>,
): string | undefined {
  if (issue.type) {
    const byType =
      sides[issue.type] ??
      Object.entries(sides).find(([k]) => k.toLowerCase() === issue.type?.toLowerCase())?.[1];
    if (byType) return byType;
  }
  const lower = Object.fromEntries(Object.entries(prefixes).map(([k, v]) => [k.toLowerCase(), v]));
  for (const m of (issue.summary ?? "").matchAll(/\[([^\]]{1,30})\]/g)) {
    const side = lower[(m[1] as string).trim().toLowerCase()];
    if (side) return side;
  }
  return undefined;
}

/**
 * The issues worth reading first: the tasks of the run's Story (the other side's first), the ones the
 * task links or names, then the other side's (a front task reads the back ones), then the rest; at
 * most `max`.
 */
export function pickRelated(
  self: string,
  mySide: string | undefined,
  candidates: readonly IssueFacts[],
  sides: Readonly<Record<string, string>> | ((issue: IssueFacts) => string | undefined),
  max: number,
  first: ReadonlySet<string> = new Set(),
  /** The tasks of the run's Story and the Story itself: before all (the other side first). */
  story: ReadonlySet<string> = new Set(),
): IssueFacts[] {
  const side = typeof sides === "function" ? sides : (c: IssueFacts) => (c.type ? sides[c.type] : undefined);
  // the issues the task links or names come first: a person pointed at them
  const rank = (c: IssueFacts) => {
    const sideOfIt = side(c);
    if (c.key && story.has(c.key)) return mySide && sideOfIt && sideOfIt !== mySide ? -3 : -2;
    if (c.key && first.has(c.key)) return -1;
    if (mySide && sideOfIt && sideOfIt !== mySide) return 0;
    if (!sideOfIt) return 1;
    return sideOfIt === mySide ? 2 : 1;
  };
  const seen = new Set<string>([self]);
  return candidates
    .filter((c) => {
      if (!c.key || seen.has(c.key)) return false;
      seen.add(c.key);
      return true;
    })
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .slice(0, max)
    .map((x) => x.c);
}

/* ---- the contract in a change ---- */

/** Files whose change matters to the other side: DTOs, controllers and routes, API and event schemas. */
/** A source whose classes are DTOs: by its name (OrderDto, CreateOrderRequest, OrderCreatedEvent) or its folder. */
function looksLikeDto(path: string): boolean {
  return (
    isDtoSource(path) &&
    (/(dto|request|response|event|message|payload|command|query|view|model)s?\.(java|kt|ts)$/i.test(
      basename(path),
    ) ||
      /\/(dto|dtos|contract|contracts|model|models|events?)\//i.test(path))
  );
}

export function isContractFile(path: string): boolean {
  const name = basename(path);
  return (
    looksLikeDto(path) ||
    /(controller|resource|endpoint|route|router|api|client|listener|producer|consumer)s?\.(java|kt|ts|js)$/i.test(
      name,
    ) ||
    /(openapi|swagger|asyncapi)[^/]*\.(ya?ml|json)$/i.test(path) ||
    /\.(proto|graphql|avsc)$/i.test(path)
  );
}

const ENDPOINT = [
  /@(Get|Post|Put|Delete|Patch|Request)Mapping\s*\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*"([^"]*)"/g,
  /\b(?:router|app|api)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g,
];

function endpointsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const re of ENDPOINT)
    for (const m of text.matchAll(re))
      out.add(`${(m[1] as string).toUpperCase().replace("REQUEST", "ANY")} ${m[2]}`);
  return out;
}

function fieldChanges(before: DtoDecl, after: DtoDecl): NonNullable<ContractChange["fields"]> {
  const was = new Map(before.fields.map((f) => [f.name, f]));
  const now = new Map(after.fields.map((f) => [f.name, f]));
  const out: Array<NonNullable<ContractChange["fields"]>[number]> = [];
  for (const f of after.fields) {
    const old = was.get(f.name);
    if (!old) out.push({ name: f.name, change: "added", type: wireType(f.type) });
    else if (wireType(old.type) !== wireType(f.type))
      out.push({ name: f.name, change: "type changed", type: wireType(f.type) });
  }
  for (const f of before.fields) if (!now.has(f.name)) out.push({ name: f.name, change: "removed" });
  return out;
}

/** What a file's change does to the contract: DTOs added, removed or with fields changed; endpoints added or removed. */
export function contractChanges(file: string, before: string, after: string): ContractChange[] {
  const out: ContractChange[] = [];
  if (looksLikeDto(file)) {
    const was = new Map(dtoDeclsOf(file, before).map((d) => [d.name, d]));
    const now = dtoDeclsOf(file, after);
    for (const d of now) {
      const old = was.get(d.name);
      if (!old) {
        out.push({
          kind: "dto",
          name: d.name,
          change: "added",
          file,
          fields: d.fields.map((f) => ({ name: f.name, change: "added" as const, type: wireType(f.type) })),
        });
        continue;
      }
      const fields = fieldChanges(old, d);
      if (fields.length > 0) out.push({ kind: "dto", name: d.name, change: "changed", file, fields });
    }
    const names = new Set(now.map((d) => d.name));
    for (const d of was.values())
      if (!names.has(d.name)) out.push({ kind: "dto", name: d.name, change: "removed", file });
  }
  const was = endpointsOf(before);
  const now = endpointsOf(after);
  for (const e of now) if (!was.has(e)) out.push({ kind: "endpoint", name: e, change: "added", file });
  for (const e of was) if (!now.has(e)) out.push({ kind: "endpoint", name: e, change: "removed", file });
  return out;
}

/* ---- where a branch's work is read from ---- */

/** A branch's work: its head commit, its base, the files it changed and the contract files before and after. */
export interface BranchWork {
  readonly commit?: string;
  readonly base?: string;
  readonly files: readonly string[];
  readonly read: ReadonlyArray<{ readonly file: string; readonly before: string; readonly after: string }>;
}

export interface WorkReader {
  readonly found: "local-git" | "bitbucket";
  read(branch: string, issue: string): Promise<BranchWork | undefined>;
}

const MAX_CONTRACT_FILES = 40;

export type Git = (args: readonly string[], cwd: string) => Promise<{ code: number; stdout: string }>;

/** The branch in a repository on this machine: fetched, compared with its base. */
export function localReader(path: string, git: Git, base?: string): WorkReader {
  return {
    found: "local-git",
    async read(branch) {
      await git(["fetch", "--quiet", "origin", branch], path);
      // a Story's branch the task goes into: fetched too, it moves with every task merged into it
      if (base) await git(["fetch", "--quiet", "origin", base], path);
      const ref = `origin/${branch}`;
      const head = (await git(["rev-parse", "--verify", "--quiet", ref], path)).stdout.trim();
      if (!head) return undefined;
      const defaultBase = (
        await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], path)
      ).stdout.trim();
      const candidates = [
        base ? `origin/${base}` : "",
        defaultBase,
        "origin/dev",
        "origin/develop",
        "origin/main",
        "origin/master",
      ].filter(Boolean);
      let baseRef = "";
      for (const c of candidates)
        if ((await git(["rev-parse", "--verify", "--quiet", c], path)).code === 0) {
          baseRef = c;
          break;
        }
      const mb = baseRef ? (await git(["merge-base", baseRef, ref], path)).stdout.trim() : "";
      const files = mb
        ? (await git(["diff", "--name-only", mb, ref], path)).stdout.split("\n").filter(Boolean)
        : [];
      const read = await inTurns(
        files.filter(isContractFile).slice(0, MAX_CONTRACT_FILES),
        READS_AT_ONCE,
        async (file) => {
          const [after, before] = await Promise.all([
            git(["show", `${ref}:${file}`], path),
            mb ? git(["show", `${mb}:${file}`], path) : Promise.resolve({ code: 1, stdout: "" }),
          ]);
          return {
            file,
            before: before.code === 0 ? before.stdout : "",
            after: after.code === 0 ? after.stdout : "",
          };
        },
      );
      return { commit: head, ...(baseRef ? { base: baseRef.replace(/^origin\//, "") } : {}), files, read };
    },
  };
}

export type Invoke = (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;

/** The branch through Bitbucket's tools: the commits that name the issue, their files, the contract files on both sides. */
export function bitbucketReader(
  invoke: Invoke,
  where: { workspace?: string; slug: string },
  base: string | undefined,
): WorkReader {
  const at = { ...(where.workspace ? { workspace: where.workspace } : {}), repo: where.slug };
  return {
    found: "bitbucket",
    async read(branch, issue) {
      const listed = await invoke("bitbucket.branch.commits", { ...at, branch });
      if (!listed.ok) return undefined;
      const commits = walk(json(listed.text))
        .map(({ o }) => ({ id: str(o.id) ?? str(o.hash) ?? str(o.displayId), message: str(o.message) ?? "" }))
        .filter((c): c is { id: string; message: string } => !!c.id && /^[0-9a-f]{7,40}$/i.test(c.id));
      const head = commits[0]?.id;
      const own = commits.filter((c) => c.message.includes(issue)).slice(0, 10);
      const files = new Set<string>();
      const details = await inTurns(own, READS_AT_ONCE, (c) =>
        invoke("bitbucket.commit.get", { ...at, commit: c.id }),
      );
      for (const detail of details) {
        if (!detail.ok) continue;
        for (const { o } of walk(json(detail.text))) {
          const p = str(o.path) ?? str(o.toString) ?? str(o.filename) ?? str(o.new_path);
          if (p && /\.[A-Za-z0-9]+$/.test(p)) files.add(p);
        }
      }
      const content = async (path: string, ref: string) => {
        const r = await invoke("bitbucket.file.get", { ...at, path, ref });
        if (!r.ok) return "";
        const doc = json(r.text);
        if (doc && typeof doc === "object" && typeof (doc as Record<string, unknown>).content === "string")
          return (doc as Record<string, string>).content as string;
        return body(r.text);
      };
      const read = await inTurns(
        [...files].filter(isContractFile).slice(0, MAX_CONTRACT_FILES),
        READS_AT_ONCE,
        async (file) => {
          const [before, after] = await Promise.all([content(file, base ?? "dev"), content(file, branch)]);
          return { file, before, after };
        },
      );
      return { ...(head ? { commit: head } : {}), base: base ?? "dev", files: [...files], read };
    },
  };
}

/** Reads at once against one server or repository (the MCP limiter still counts each). */
export const READS_AT_ONCE = 4;

/** `work` on each item, `limit` at a time; the answers in the items' order. */
export async function inTurns<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await work(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}
