import { basename } from "node:path";
import type { Runtime } from "../../app/runtime.ts";
import type { Run } from "../../core/domain/run.ts";
import {
  bitbucketReader,
  type ContractChange,
  contractChanges,
  type DevBranch,
  type DevPr,
  devInfoOf,
  type Git,
  type IssueFacts,
  inTurns,
  issueFacts,
  localReader,
  pickRelated,
  READS_AT_ONCE,
  RELATED_ABOUT,
  RELATED_WORK,
  type RelatedItem,
  type RelatedWorkDoc,
  searchHits,
  type WorkReader,
} from "../../sources/relatedWork.ts";
import { git as runGit } from "../../tools/local/exec.ts";
import type { DeterministicTool } from "../executors.ts";
import type { StepContext } from "../types.ts";

/**
 * ADR-0026 steps: `related.collect` (after the sources) reads the work of related tasks into the
 * `related-work` document; `related.check` (before implementation) says when a branch the spec built on
 * moved on or was merged. Both run only when the run reads related work (`relatedWork.enabled`, else
 * the run's `--related` / New task) and never fail the run: what is not found is said in the document.
 */
export function relatedOn(runtime: Runtime, run: Pick<Run, "options">): boolean {
  return run.options?.related ?? runtime.loaded.config.relatedWork.enabled;
}

const git: Git = async (args, cwd) => {
  const r = await runGit(args, cwd, { timeoutMs: 60_000 });
  return { code: r.code ?? 1, stdout: r.stdout };
};

/** The repositories on this machine: the run's own and the map's services, by folder name and service name. */
function localRepos(runtime: Runtime, run: Run): Map<string, { path: string; service?: string }> {
  const out = new Map<string, { path: string; service?: string }>();
  out.set(basename(run.workspace.repoRoot).toLowerCase(), { path: run.workspace.repoRoot });
  for (const [service, path] of Object.entries(runtime.loaded.meta?.repos ?? {})) {
    out.set(service.toLowerCase(), { path, service });
    out.set(basename(path).toLowerCase(), { path, service });
  }
  return out;
}

async function call(ctx: StepContext, name: string, args: Record<string, unknown>) {
  try {
    const r = await ctx.tools.invoke(name, args);
    // the whole answer, not the agent's cut: a cut JSON does not parse (pilot: a Development panel of
    // 58 KB came cut, and every branch and PR of the issue was lost)
    const text = r.truncated && r.fullRef ? ctx.runtime.blobs.getText(r.fullRef) : r.text;
    return { ok: r.ok, text };
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}

/** The related issues: the issue's links, its epic's (or parent's) other issues; the other side first. */
async function relatedIssues(
  ctx: StepContext,
  self: IssueFacts & { key: string },
): Promise<{ picked: IssueFacts[]; notRead: string[] }> {
  const cfg = ctx.runtime.loaded.config.relatedWork;
  const available = new Set(ctx.tools.list().map((d) => d.name));
  const candidates: IssueFacts[] = [];
  const group = self.epic ?? self.parent;
  if (group && available.has("jira.search")) {
    for (const jql of [`"Epic Link" = ${group} OR parent = ${group}`, `parent = ${group}`]) {
      const r = await call(ctx, "jira.search", {
        jql: `${jql} ORDER BY updated DESC`,
        limit: 30,
        fields: "summary,status,issuetype,parent",
      });
      if (r.ok) {
        candidates.push(...searchHits(r.text));
        break;
      }
    }
  }
  // linked, named in the issue's description or in the task's own text: read first
  const inTask = ctx.run.task.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [];
  const first = new Set([...self.links, ...(self.mentions ?? []), ...inTask]);
  first.delete(self.key);
  for (const key of first) if (!candidates.some((c) => c.key === key)) candidates.push({ key, links: [] });
  const all = pickRelated(
    self.key,
    self.type ? cfg.sides[self.type] : undefined,
    candidates,
    cfg.sides,
    Number.POSITIVE_INFINITY,
    first,
  );
  return {
    picked: all.slice(0, cfg.maxIssues),
    notRead: all.slice(cfg.maxIssues).flatMap((c) => (c.key ? [c.key] : [])),
  };
}

/** Repositories of one issue read, at most: a task's work is in one to three services. */
const MAX_REPOS = 3;

/**
 * One related issue's work, an item per repository: its branch and PR from Jira's Development panel,
 * read where it can be (pilot: a back task changed a shared library and a service at once).
 */
async function itemsOf(ctx: StepContext, issue: IssueFacts & { key: string }): Promise<RelatedItem[]> {
  const available = new Set(ctx.tools.list().map((d) => d.name));
  const head = {
    issue: issue.key,
    ...(issue.type ? { type: issue.type } : {}),
    ...(issue.status ? { status: issue.status } : {}),
    ...(issue.summary ? { summary: issue.summary } : {}),
  };
  if (!available.has("jira.devInfo"))
    return [
      {
        ...head,
        found: "none",
        contract: [],
        note: "jira.devInfo is not available: allow it on the Atlassian MCP server",
      },
    ];
  const dev = await call(ctx, "jira.devInfo", { key: issue.key });
  if (!dev.ok)
    return [{ ...head, found: "none", contract: [], note: `jira.devInfo failed: ${dev.text.slice(0, 160)}` }];
  const info = devInfoOf(dev.text);
  // the issue's own branches and PRs: the panel also lists the repository's dev, master and the like
  const own = (name?: string) => !!name && name.toUpperCase().includes(issue.key.toUpperCase());
  const branches = info.branches.filter((b) => own(b.name));
  const prs = info.prs.filter((p) => !p.branch || own(p.branch));
  const repos = [
    ...new Set([...branches.map((b) => b.repo?.slug), ...prs.map((p) => p.repo?.slug)].map((r) => r ?? "")),
  ].slice(0, MAX_REPOS);
  if (repos.length === 0) return [{ ...head, found: "none", contract: [] }];
  const items: RelatedItem[] = [];
  items.push(
    ...(await Promise.all(
      repos.map((slug) =>
        repoItem(
          ctx,
          issue.key,
          head,
          branches.filter((b) => (b.repo?.slug ?? "") === slug),
          prs.filter((p) => (p.repo?.slug ?? "") === slug),
        ),
      ),
    )),
  );
  return items;
}

/** The feature branch of a repository: the PR's open one, else the plainest name (not its -int, -master copies). */
function mainBranch(branches: readonly DevBranch[], prs: readonly DevPr[]) {
  const pr = prs.find((p) => /open/i.test(p.state ?? "")) ?? prs.find((p) => p.branch) ?? prs[0];
  const names = [
    ...new Set([...branches.map((b) => b.name), ...prs.flatMap((p) => (p.branch ? [p.branch] : []))]),
  ];
  const plain = names.sort((a, b) => a.length - b.length)[0];
  const name = pr && /open/i.test(pr.state ?? "") && pr.branch ? pr.branch : (plain ?? pr?.branch);
  const prOf =
    prs.find((p) => p.branch === name && /open/i.test(p.state ?? "")) ??
    prs.find((p) => p.branch === name) ??
    pr;
  return { name, pr: prOf, branch: branches.find((b) => b.name === name) };
}

async function repoItem(
  ctx: StepContext,
  key: string,
  head: Pick<RelatedItem, "issue" | "type" | "status" | "summary">,
  branches: readonly DevBranch[],
  prs: readonly DevPr[],
): Promise<RelatedItem> {
  const cfg = ctx.runtime.loaded.config.relatedWork;
  const available = new Set(ctx.tools.list().map((d) => d.name));
  const { name, pr, branch } = mainBranch(branches, prs);
  if (!name) return { ...head, found: "none", contract: [] };
  const repo = branch?.repo ?? pr?.repo;
  const local = repo ? localRepos(ctx.runtime, ctx.run).get(repo.slug.toLowerCase()) : undefined;
  const reader: WorkReader | undefined = local
    ? localReader(local.path, git, cfg.base)
    : repo && available.has("bitbucket.branch.commits")
      ? bitbucketReader((n, a) => call(ctx, n, a), repo, cfg.base)
      : undefined;
  const merged = /merged/i.test(pr?.state ?? "") && !prs.some((p) => /open/i.test(p.state ?? ""));
  const base = {
    ...head,
    ...(local?.service ? { service: local.service } : {}),
    ...(repo ? { repo: repo.slug } : {}),
    branch: name,
    ...(pr
      ? {
          pr: {
            ...(pr.id ? { id: pr.id } : {}),
            ...(pr.state ? { state: pr.state } : {}),
            ...(pr.url ? { url: pr.url } : {}),
          },
        }
      : {}),
  };
  if (!reader)
    return {
      ...base,
      found: "jira-dev-info",
      contract: [],
      note: "the repository is not on this machine and Bitbucket's branch tools are not available: only the branch and PR are known",
    };
  let work: Awaited<ReturnType<WorkReader["read"]>>;
  try {
    work = await reader.read(name, key);
  } catch (error) {
    return {
      ...base,
      found: "jira-dev-info",
      contract: [],
      note: `could not read the branch: ${String(error).slice(0, 160)}`,
    };
  }
  if (!work) return { ...base, found: "jira-dev-info", contract: [], note: "the branch could not be read" };
  // merged: the base has the branch's files already, a comparison shows nothing — the contract is
  // said as it is now in the base (what the other side builds on), not as a change
  const same = work.read.length > 0 && work.read.every((f) => f.before === f.after);
  const contract: ContractChange[] = work.read.flatMap((f) =>
    contractChanges(f.file, merged && same ? "" : f.before, f.after),
  );
  return {
    ...base,
    ...(work.commit ? { commit: work.commit.slice(0, 12) } : {}),
    ...(work.base ? { base: work.base } : {}),
    found: reader.found,
    contract,
    files: { contract: work.read.length, other: Math.max(0, work.files.length - work.read.length) },
    ...(merged
      ? {
          note: `merged into ${work.base ?? "the base"}: the contract is what is there now (its fields shown as added), not a pending change`,
        }
      : {}),
  };
}

/** Of the issue keys in nameless custom fields, the one of type Epic (read one by one, at most 5). */
async function epicAmong(ctx: StepContext, keys: readonly string[]): Promise<{ epic?: string }> {
  for (const k of keys.slice(0, 5)) {
    const r = await call(ctx, "jira.get", { key: k });
    if (r.ok && /^(epic|эпик)$/i.test(issueFacts(r.text).type ?? "")) return { epic: k };
  }
  return {};
}

/** `related.collect`: the related-work document, or nothing when there is no issue to start from. */
export const collectRelated: DeterministicTool = async (ctx) => {
  const available = new Set(ctx.tools.list().map((d) => d.name));
  const key = ctx.run.task.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0];
  const say = (reason: string) => {
    ctx.runtime.events.emit({
      kind: "related.skipped",
      runId: ctx.run.id,
      stepId: ctx.step.id,
      iteration: ctx.iteration,
      payload: { reason },
    });
    return { status: "success" as const };
  };
  if (!key) return say("the task names no issue");
  if (!available.has("jira.get")) return say("jira.get is not available");
  // all fields: the community server's default set has no issue links, no parent and no Epic Link
  const got = await call(ctx, "jira.get", { key, fields: "*all" });
  if (!got.ok) return say(`jira.get ${key} failed`);
  const facts = issueFacts(got.text);
  const self = { ...facts, key, ...(facts.epic ? {} : await epicAmong(ctx, facts.keyFields ?? [])) };
  const related = await relatedIssues(ctx, self);
  const issues = related.picked.filter((i): i is IssueFacts & { key: string } => !!i.key);
  const items: RelatedItem[] = [];
  // the related issues side by side, a few at a time; the document keeps their order
  for (const found of await inTurns(issues, READS_AT_ONCE, (issue) => itemsOf(ctx, issue)))
    items.push(...found);
  const doc: RelatedWorkDoc = {
    about: RELATED_ABOUT,
    from: key,
    items: items.filter((i) => i.found !== "none" || i.note),
    notFound: items.filter((i) => i.found === "none" && !i.note).map((i) => i.issue),
    ...(related.notRead.length > 0 ? { notRead: related.notRead } : {}),
    ...(issues.length === 0
      ? {
          note:
            self.epic || self.parent
              ? `no other issues found under ${self.epic ?? self.parent} (jira.search)`
              : `${key} has no epic, parent or issue links in jira.get's answer`,
        }
      : {}),
    checkedAt: new Date().toISOString(),
  };
  const a = ctx.runtime.artifacts.put({
    runId: ctx.run.id,
    type: RELATED_WORK,
    name: "related-work.json",
    content: JSON.stringify(doc, null, 2),
    mediaType: "application/json",
    provenance: { kind: "tool", capability: "related.collect" },
    stepId: ctx.step.id,
    iteration: ctx.iteration,
  });
  ctx.runtime.events.emit({
    kind: "related.collected",
    runId: ctx.run.id,
    stepId: ctx.step.id,
    iteration: ctx.iteration,
    payload: {
      issues: items.length,
      branches: items.filter((i) => i.branch).length,
      contract: items.reduce((n, i) => n + i.contract.length, 0),
    },
  });
  return { status: "success", outputs: [`${a.artifactId}@${a.version}`] };
};

/**
 * `related.check` (before implementation): each branch the spec built on, read again — merged, moved
 * on (and whether its contract changed), or as it was. Said in the run's feed and as a new version of
 * the document for the agents; never a failure.
 */
export const checkRelated: DeterministicTool = async (ctx) => {
  const latest = ctx.runtime.artifacts.listLatest(ctx.run.id, RELATED_WORK)[0];
  if (!latest) return { status: "success" };
  let doc: RelatedWorkDoc;
  try {
    doc = JSON.parse(ctx.runtime.artifacts.text(latest)) as RelatedWorkDoc;
  } catch {
    return { status: "success" };
  }
  const withBranch = doc.items.filter((i) => i.branch && i.commit);
  if (withBranch.length === 0) return { status: "success" };
  const now: RelatedItem[] = [];
  const moved: Array<{
    issue: string;
    from: string;
    to?: string;
    contractChanged: boolean;
    merged: boolean;
  }> = [];
  const byIssue = new Map<string, RelatedItem[]>();
  for (const item of doc.items) {
    if (!item.branch || !item.commit) {
      now.push(item);
      continue;
    }
    let read = byIssue.get(item.issue);
    if (!read) {
      read = await itemsOf(ctx, { key: item.issue, links: [], ...(item.type ? { type: item.type } : {}) });
      byIssue.set(item.issue, read);
    }
    const fresh = read.find((r) => r.repo === item.repo) ?? (read[0] as RelatedItem);
    // merged since the spec read it: a merge the spec already knew of is no news
    const merged = /merged/i.test(fresh.pr?.state ?? "") && !/merged/i.test(item.pr?.state ?? "");
    const same = !fresh.commit || fresh.commit === item.commit;
    const contractChanged = JSON.stringify(fresh.contract) !== JSON.stringify(item.contract);
    if (!same || merged)
      moved.push({
        issue: item.issue,
        from: item.commit,
        ...(fresh.commit ? { to: fresh.commit } : {}),
        contractChanged,
        merged,
      });
    now.push({ ...fresh, ...(fresh.found === "none" ? { contract: item.contract } : {}) });
  }
  for (const m of moved)
    ctx.runtime.events.emit({
      kind: "related.moved",
      runId: ctx.run.id,
      stepId: ctx.step.id,
      iteration: ctx.iteration,
      payload: m,
    });
  if (moved.length === 0) return { status: "success" };
  const a = ctx.runtime.artifacts.put({
    runId: ctx.run.id,
    type: RELATED_WORK,
    name: "related-work.json",
    content: JSON.stringify({ ...doc, items: now, checkedAt: new Date().toISOString() }, null, 2),
    mediaType: "application/json",
    provenance: { kind: "tool", capability: "related.check" },
    stepId: ctx.step.id,
    iteration: ctx.iteration,
  });
  return { status: "success", outputs: [`${a.artifactId}@${a.version}`] };
};

export const RELATED_TOOLS: Record<string, DeterministicTool> = {
  "related.collect": collectRelated,
  "related.check": checkRelated,
};
