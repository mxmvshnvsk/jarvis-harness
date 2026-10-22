import { basename } from "node:path";
import type { Runtime } from "../../app/runtime.ts";
import type { Run } from "../../core/domain/run.ts";
import {
  bitbucketReader,
  type ContractChange,
  contractChanges,
  devInfoOf,
  type Git,
  type IssueFacts,
  issueFacts,
  localReader,
  pickRelated,
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
    return { ok: r.ok, text: r.text };
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}

/** The related issues: the issue's links, its epic's (or parent's) other issues; the other side first. */
async function relatedIssues(ctx: StepContext, self: IssueFacts & { key: string }): Promise<IssueFacts[]> {
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
  for (const key of self.links)
    if (!candidates.some((c) => c.key === key)) candidates.push({ key, links: [] });
  return pickRelated(
    self.key,
    self.type ? cfg.sides[self.type] : undefined,
    candidates,
    cfg.sides,
    cfg.maxIssues,
  );
}

/** One related issue's work: its branch and PR from Jira, read where it can be. */
async function itemOf(ctx: StepContext, issue: IssueFacts & { key: string }): Promise<RelatedItem> {
  const cfg = ctx.runtime.loaded.config.relatedWork;
  const available = new Set(ctx.tools.list().map((d) => d.name));
  const head = {
    issue: issue.key,
    ...(issue.type ? { type: issue.type } : {}),
    ...(issue.status ? { status: issue.status } : {}),
    ...(issue.summary ? { summary: issue.summary } : {}),
  };
  if (!available.has("jira.devInfo"))
    return {
      ...head,
      found: "none",
      contract: [],
      note: "jira.devInfo is not available: allow it on the Atlassian MCP server",
    };
  const dev = await call(ctx, "jira.devInfo", { key: issue.key });
  if (!dev.ok)
    return { ...head, found: "none", contract: [], note: `jira.devInfo failed: ${dev.text.slice(0, 160)}` };
  const { branches, prs } = devInfoOf(dev.text);
  const pr = prs.find((p) => /open/i.test(p.state ?? "")) ?? prs[0];
  const branch = branches.find((b) => b.name === pr?.branch) ?? branches[0];
  const name = branch?.name ?? pr?.branch;
  if (!name) return { ...head, found: "none", contract: [] };
  const repo = branch?.repo ?? pr?.repo;
  const local = repo ? localRepos(ctx.runtime, ctx.run).get(repo.slug.toLowerCase()) : undefined;
  const reader: WorkReader | undefined = local
    ? localReader(local.path, git, cfg.base)
    : repo && available.has("bitbucket.branch.commits")
      ? bitbucketReader((n, a) => call(ctx, n, a), repo, cfg.base)
      : undefined;
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
    work = await reader.read(name, issue.key);
  } catch (error) {
    work = undefined;
    return {
      ...base,
      found: "jira-dev-info",
      contract: [],
      note: `could not read the branch: ${String(error).slice(0, 160)}`,
    };
  }
  if (!work) return { ...base, found: "jira-dev-info", contract: [], note: "the branch could not be read" };
  const contract: ContractChange[] = work.read.flatMap((f) => contractChanges(f.file, f.before, f.after));
  return {
    ...base,
    ...(work.commit ? { commit: work.commit.slice(0, 12) } : {}),
    ...(work.base ? { base: work.base } : {}),
    found: reader.found,
    contract,
    files: { contract: work.read.length, other: Math.max(0, work.files.length - work.read.length) },
  };
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
  const self = { ...issueFacts(got.text), key };
  const issues = (await relatedIssues(ctx, self)).filter((i): i is IssueFacts & { key: string } => !!i.key);
  const items: RelatedItem[] = [];
  for (const issue of issues) items.push(await itemOf(ctx, issue));
  const doc: RelatedWorkDoc = {
    about: RELATED_ABOUT,
    from: key,
    items: items.filter((i) => i.found !== "none" || i.note),
    notFound: items.filter((i) => i.found === "none" && !i.note).map((i) => i.issue),
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
  for (const item of doc.items) {
    if (!item.branch || !item.commit) {
      now.push(item);
      continue;
    }
    const fresh = await itemOf(ctx, {
      key: item.issue,
      links: [],
      ...(item.type ? { type: item.type } : {}),
    });
    const merged = /merged/i.test(fresh.pr?.state ?? "");
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
