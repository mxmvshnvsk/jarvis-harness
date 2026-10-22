import { existsSync } from "node:fs";
import { type Actor, formatActor } from "../core/domain/actor.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import type { Run } from "../core/domain/run.ts";
import type { WorkflowDefinition } from "../core/domain/workflow.ts";
import { runEffect } from "../orchestration/effects.ts";
import { HeldLease, leaseOwner } from "../orchestration/lease.ts";
import { gitIdentityEnv, WorktreeWorkspace } from "../orchestration/worktree.ts";
import { untrustedSourceOf } from "../security/policy/untrusted.ts";
import { effectMarker } from "../storage/effects.ts";
import { shortRunId } from "../storage/runStore.ts";
import { actingAs } from "../telemetry/events.ts";
import { git } from "../tools/local/exec.ts";
import { capabilityMatches } from "../tools/registry.ts";
import type { Capability, ToolContext, ToolOutput } from "../tools/types.ts";
import { removeReviewMarkers } from "./applyRun.ts";
import { branchOf, commitMessageOf, FormatError, headerOf } from "./deliveryFormat.ts";
import type { Runtime } from "./runtime.ts";

/**
 * A finished run delivered as a pull request (ADR-0003 §4): the run's own changes as one commit on
 * its base, pushed to the remote as its `jarvis/…` branch, and the PR opened through the MCP server
 * that has `*.pr.create` (Bitbucket today). Both are effects under the journal (ADR-0002): a second
 * try replays what was done instead of pushing or opening again.
 *
 * Credentials are never ours to pass: the push goes through the person's own git (its credential
 * helper, ssh agent), the PR through the MCP server's `keychain:` auth (ADR-0006 §4). Nothing secret is
 * in an argument, the journal or an event.
 *
 * Who asks: a person (`jarvis apply --pr`, «Create PR» on the run page) or the run itself when it
 * delivers itself (`--deliver pr`, workflow `deliver: pr`) — then possibly the daemon, on behalf of the
 * run's owner (ADR-0006 §2).
 */

/** The artifact a delivered run keeps: where its PR is. */
export const PR_ARTIFACT = "pull-request";
/** What is to be sent: the PR's title, description and branches — what a person approves (`approve`). */
export const PR_REQUEST = "pr-request";
/** The journal's step of the delivery effects: outside the workflow's steps. */
export const DELIVERY_STEP = "deliver";

export type DeliveryChannel = "cli" | "ui" | "run";

export type DeliveryErrorCode =
  | "denied"
  | "approval"
  | "rejected"
  | "credentials"
  | "no-capability"
  | "no-branch"
  | "format"
  | "empty"
  | "held"
  | "push"
  | "pr";

/** Why the PR was not made, with what to do. */
export class DeliveryError extends Error {
  readonly code: DeliveryErrorCode;
  /** The request a person approves, for `approval`. */
  readonly request?: ArtifactVersion;
  constructor(code: DeliveryErrorCode, message: string, request?: ArtifactVersion) {
    super(message);
    this.name = "DeliveryError";
    this.code = code;
    if (request) this.request = request;
  }
}

export interface PrRequest {
  readonly title: string;
  readonly description: string;
  /** The branch pushed: `delivery.branch` filled, else the run's own `jarvis/…`. */
  readonly source: string;
  readonly target: string;
  readonly remote: string;
  /** The repository on the server (project key or workspace, and slug). */
  readonly workspace?: string;
  readonly repo?: string;
  /** The commit pushed: the run's changes as one commit on its base. */
  readonly commit: string;
  readonly files: readonly string[];
}

export interface Delivered {
  readonly url?: string;
  readonly id?: string;
  readonly title: string;
  readonly source: string;
  readonly target: string;
  readonly commit: string;
  readonly capability: string;
  readonly actor: string;
  readonly onBehalfOf?: string;
  readonly at: string;
  /** It was there already: nothing was sent this time. */
  readonly already?: boolean;
}

/** The project's policy on PRs (`delivery.pr`). */
export function prPolicy(runtime: Runtime): "allow" | "approve" | "deny" {
  return runtime.loaded.config.delivery.pr;
}

/** The run delivers itself as a PR when its workflow is done: its own option, else its workflow's. */
export function deliversItself(run: Run, workflow?: WorkflowDefinition): boolean {
  return run.options?.delivery === "pr" || workflow?.deliver === "pr";
}

/**
 * Why the PR flow cannot be on here: PRs are off for the project, or no MCP server allowed here opens
 * them (`*.pr.create`, its `allow`). Undefined — it can.
 */
export function prFlowUnavailable(runtime: Runtime): "deny" | "no-server" | undefined {
  if (prPolicy(runtime) === "deny") return "deny";
  const opens = runtime.registry
    .list()
    .some(
      (c) => c.effect && capabilityMatches(c.name, "*.pr.create") && runtime.tools.policy(c, ["*"]).allowed,
    );
  return opens ? undefined : "no-server";
}

/** The PR flow by default for new runs: `delivery.flow.enabled`, where it can be on. */
export function prFlowDefault(runtime: Runtime): boolean {
  return runtime.loaded.config.delivery.flow.enabled && !prFlowUnavailable(runtime);
}

/** The run is in the PR flow: its own choice, else the project's; a run in its own checkout only. */
export function prFlowOn(runtime: Runtime, run: Run): boolean {
  return (
    run.workspace.mode === "worktree" &&
    (run.options?.prFlow ?? runtime.loaded.config.delivery.flow.enabled) &&
    !prFlowUnavailable(runtime)
  );
}

/** The context of the change in a word, as the run's implementation named it (`{scope}`). */
export function scopeNamed(runtime: Runtime, runId: string): string | undefined {
  const a = runtime.artifacts.listLatest(runId, "implementation")[0];
  if (!a) return undefined;
  try {
    const scope = (JSON.parse(runtime.artifacts.text(a)) as { scope?: unknown }).scope;
    return typeof scope === "string" && scope.trim() ? scope.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** The PR a run was delivered as, if it was. */
export function prOf(runtime: Runtime, run: Run): Delivered | undefined {
  const artifact = runtime.artifacts.listLatest(run.id, PR_ARTIFACT)[0];
  if (!artifact) return undefined;
  try {
    return JSON.parse(runtime.artifacts.text(artifact)) as Delivered;
  } catch {
    return undefined;
  }
}

/** The request waiting for a person's approval, when the policy wants one and it is not given yet. */
export function pendingPrRequest(
  runtime: Runtime,
  run: Run,
): { artifact: ArtifactVersion; request: PrRequest } | undefined {
  if (prPolicy(runtime) !== "approve" || prOf(runtime, run)) return undefined;
  const artifact = runtime.artifacts.listLatest(run.id, PR_REQUEST)[0];
  if (!artifact || runtime.artifacts.isApproved(artifact.artifactId).approved) return undefined;
  if (runtime.artifacts.approvalsFor(artifact.artifactId, artifact.version)[0]) return undefined;
  return { artifact, request: requestOf(runtime, artifact) };
}

/**
 * The PR as it will go out, prepared and not sent yet: the card before the PR (branch, target, title,
 * description), whatever the policy — a person sees what goes out before anything is pushed.
 */
export function prDraftOf(
  runtime: Runtime,
  run: Run,
): { artifact: ArtifactVersion; request: PrRequest } | undefined {
  if (prOf(runtime, run)) return undefined;
  const artifact = runtime.artifacts.listLatest(run.id, PR_REQUEST)[0];
  return artifact ? { artifact, request: requestOf(runtime, artifact) } : undefined;
}

export function requestOf(runtime: Runtime, artifact: ArtifactVersion): PrRequest {
  return JSON.parse(runtime.artifacts.text(artifact)) as PrRequest;
}

/**
 * The capability that opens PRs: `delivery.capability`, else the one `*.pr.create` effect the
 * configured servers have. Several and none named — the person names one.
 */
export function prCapability(runtime: Runtime): Capability {
  const named = runtime.loaded.config.delivery.capability;
  if (named) {
    const capability = runtime.registry.get(named);
    if (!capability?.effect)
      throw new DeliveryError(
        "no-capability",
        `delivery.capability "${named}" is not an effect any configured MCP server has (\`jarvis mcp list\`)`,
      );
    return capability;
  }
  const found = runtime.registry.list().filter((c) => c.effect && capabilityMatches(c.name, "*.pr.create"));
  if (found.length === 1) return found[0] as Capability;
  if (found.length === 0)
    throw new DeliveryError(
      "no-capability",
      "no MCP server here opens pull requests (*.pr.create): add one with the bitbucket profile to mcp.servers, or deliver with `jarvis apply` and push yourself",
    );
  throw new DeliveryError(
    "no-capability",
    `several servers open pull requests (${found.map((c) => c.name).join(", ")}): name one in delivery.capability`,
  );
}

/**
 * What the PR will be: the run's changes as one commit on its base (the branch's checkpoints are the
 * run's own history, ADR-0003 §3), the title and description from its spec and implementation. Kept as
 * the `pr-request` artifact: a new version only when something changed, so an approval stays valid.
 */
export async function preparePr(
  runtime: Runtime,
  run: Run,
  options: { title?: string; target?: string; source?: string; description?: string } = {},
): Promise<{ artifact: ArtifactVersion; request: PrRequest }> {
  const ws = run.workspace;
  const branch = ws.branch;
  if (ws.mode !== "worktree" || !branch)
    throw new DeliveryError(
      "no-branch",
      "this run works in the current checkout (cwd mode): there is no branch to push",
    );
  const exists = await git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], ws.repoRoot);
  if (exists.code !== 0)
    throw new DeliveryError("no-branch", `the run's branch ${branch} is gone (removed with its checkout?)`);
  const owner = run.owner;
  await removeReviewMarkers(runtime, run, new WorktreeWorkspace(ws, runtime.env, identityOf(owner)));
  const config = runtime.loaded.config.delivery;
  const remote = config.remote;
  const base =
    ws.baseCommit ?? (await must(git(["merge-base", branch, "HEAD"], ws.repoRoot), "find the base"));
  const files = (
    await must(git(["diff", "--name-only", `${base}..${branch}`], ws.repoRoot), "list the changes")
  )
    .split("\n")
    .filter(Boolean);
  if (files.length === 0)
    throw new DeliveryError(
      "empty",
      `the run changed nothing since ${base.slice(0, 10)}: nothing to deliver`,
    );
  const docs = documentsOf(runtime, run);
  // the team's formats (`delivery`): the branch pushed, the commit's message, the PR's title
  const format = {
    task: run.task,
    title: options.title?.trim() || docs.title || subjectOf(run.task),
    ...(run.options?.kind ? { kind: run.options.kind } : {}),
    files,
    // a service of a map of services: its name is the scope
    ...((s) => (s ? { scope: s } : {}))(scopeNamed(runtime, run.id)),
    runId: run.id,
  };
  let title: string;
  let message: string;
  let source: string;
  try {
    title = (options.title?.trim() || headerOf(config, format, config.prTitle)).slice(0, 200);
    message = commitMessageOf(config, format);
    source = options.source?.trim() || branchOf(config, format) || branch;
  } catch (error) {
    if (error instanceof FormatError) throw new DeliveryError("format", error.message);
    throw error;
  }
  // a branch the person typed: one git takes (no spaces, no `..`, not ending in `.lock`)
  if ((await git(["check-ref-format", "--branch", source], ws.repoRoot)).code !== 0)
    throw new DeliveryError("format", `"${source}" is not a branch name git takes`);
  const target = options.target?.trim();
  if (target && (await git(["check-ref-format", "--branch", target], ws.repoRoot)).code !== 0)
    throw new DeliveryError("format", `"${target}" is not a branch name git takes`);
  const commit = await squashed(runtime, run, base, branch, message);
  const coordinates = await repositoryOf(ws.repoRoot, remote);
  const request: PrRequest = {
    title,
    description: options.description?.trim() || descriptionOf(run, docs, files),
    source,
    // a task in a Story goes into the Story's branch the run started from (`relatedWork.story`)
    target:
      options.target?.trim() ||
      (ws.story?.based ? ws.story.branch : undefined) ||
      config.target ||
      (await defaultBranchOf(ws.repoRoot, remote)),
    remote,
    ...((config.workspace ?? coordinates.workspace)
      ? { workspace: config.workspace ?? coordinates.workspace }
      : {}),
    ...((config.repo ?? coordinates.repo) ? { repo: config.repo ?? coordinates.repo } : {}),
    commit,
    files,
  };
  const content = JSON.stringify(request, null, 2);
  const latest = runtime.artifacts.listLatest(run.id, PR_REQUEST)[0];
  if (latest && runtime.artifacts.text(latest) === content) return { artifact: latest, request };
  const artifact = runtime.artifacts.put({
    runId: run.id,
    type: PR_REQUEST,
    name: "pr-request.json",
    content,
    mediaType: "application/json",
    provenance: { kind: "tool", capability: "runtime.delivery" },
    stepId: DELIVERY_STEP,
  });
  return { artifact, request };
}

export interface DeliverOptions {
  /** Who asks: a person, the run's owner going on, the daemon. */
  readonly actor: Actor;
  /** Whose run it is, when the actor is not its owner (the daemon). */
  readonly onBehalfOf?: Actor;
  readonly channel: DeliveryChannel;
  readonly title?: string;
  readonly target?: string;
  /** The branch pushed, as the person set it on the card before the PR. */
  readonly source?: string;
  readonly description?: string;
  /** The run's lease when the engine delivers; otherwise one is taken for the two effects. */
  readonly lease?: HeldLease;
}

/**
 * Pushes the branch and opens the PR, both journalled. Throws `DeliveryError` when the policy refuses
 * or wants an approval first, when the daemon may not use the owner's credentials, or when a step of
 * it failed; `UnresolvedEffectError` when an effect's outcome cannot be told (ADR-0002 §2).
 */
export async function deliverPr(runtime: Runtime, run: Run, options: DeliverOptions): Promise<Delivered> {
  const known = prOf(runtime, run);
  if (known) return { ...known, already: true };
  const policy = prPolicy(runtime);
  if (policy === "deny")
    throw new DeliveryError(
      "denied",
      "pull requests are off for this project (delivery.pr: deny): Apply it and push yourself",
    );
  const actor = formatActor(options.actor);
  const onBehalfOf = options.onBehalfOf ? formatActor(options.onBehalfOf) : undefined;
  if (options.actor.kind === "service" && !runtime.loaded.config.daemon.actAsOwner)
    throw new DeliveryError(
      "credentials",
      `the push and the PR need ${formatActor(run.owner)}'s credentials and the daemon does not act as the owner (daemon.actAsOwner: false): \`jarvis continue ${shortRunId(run.id)}\` creates it as you`,
    );
  const capability = prCapability(runtime);
  const allowed = runtime.tools.policy(capability, ["*"]);
  if (!allowed.allowed)
    throw new DeliveryError(
      "denied",
      `${capability.name} is not allowed here: ${allowed.reason ?? "denied"}`,
    );
  const { artifact, request } = await preparePr(runtime, run, {
    ...(options.title ? { title: options.title } : {}),
    ...(options.target ? { target: options.target } : {}),
    ...(options.source ? { source: options.source } : {}),
    ...(options.description ? { description: options.description } : {}),
  });
  const decision = runtime.artifacts.approvalsFor(artifact.artifactId, artifact.version)[0];
  if (decision && decision.decision !== "approve")
    throw new DeliveryError(
      "rejected",
      `the PR was not approved by ${decision.actor.id}${decision.comment ? `: ${decision.comment}` : ""}`,
      artifact,
    );
  // ADR-0016 §4: what the run read from the internet may have steered it — its own PR waits for a person
  const unattended = options.channel === "run" && untrustedSourceOf(runtime.events, run.id) !== undefined;
  if ((policy === "approve" || unattended) && !runtime.artifacts.isApproved(artifact.artifactId).approved)
    throw new DeliveryError(
      "approval",
      policy === "approve"
        ? `the project wants a person to approve a PR first (delivery.pr: approve): ${request.title} → ${request.target}`
        : `the run read untrusted content from the internet: a person approves its PR first (ADR-0016 §4)`,
      artifact,
    );

  const lease =
    options.lease ?? HeldLease.acquire(runtime.runs, run.id, leaseOwner("cli"), { heartbeatMs: 0 });
  if (!lease)
    throw new DeliveryError("held", "the run is being executed elsewhere: create its PR once it stops");
  try {
    return await actingAs({ actor, ...(onBehalfOf ? { onBehalfOf } : {}) }, async () => {
      const base = { runId: run.id, stepId: DELIVERY_STEP, iteration: 1 };
      await runEffect(runtime.effects, lease, runtime.events, {
        ...base,
        capability: "git.push",
        args: { remote: request.remote, branch: request.source, commit: request.commit },
        seq: 0,
        execute: () => push(runtime, run, request),
        verify: () => pushed(run, request),
      });
      const args = prArgs(request);
      const ctx = toolContext(runtime, run, lease);
      const opened = await runEffect<ToolOutput>(runtime.effects, lease, runtime.events, {
        ...base,
        capability: capability.name,
        args,
        seq: 1,
        execute: async (record) => {
          const out = await capability.handler(args, {
            ...ctx,
            effect: { key: record.key, marker: effectMarker(run.id, record.key) },
          });
          if (!out.ok)
            throw new DeliveryError("pr", `the PR was not created: ${out.error ?? out.text ?? "?"}`);
          return out;
        },
        ...(capability.verify
          ? {
              verify: (record) =>
                (capability.verify as NonNullable<Capability["verify"]>)(args, record, {
                  ...ctx,
                  effect: { key: record.key, marker: effectMarker(run.id, record.key) },
                }),
            }
          : {}),
      });
      const found = linkOf(opened.result);
      const delivered: Delivered = {
        ...(found.url ? { url: found.url } : {}),
        ...(found.id ? { id: found.id } : {}),
        title: request.title,
        source: request.source,
        target: request.target,
        commit: request.commit,
        capability: capability.name,
        actor,
        ...(onBehalfOf ? { onBehalfOf } : {}),
        at: new Date().toISOString(),
      };
      runtime.artifacts.put({
        runId: run.id,
        type: PR_ARTIFACT,
        name: "pull-request.json",
        content: JSON.stringify(delivered, null, 2),
        mediaType: "application/json",
        provenance: { kind: "tool", capability: capability.name },
        stepId: DELIVERY_STEP,
      });
      runtime.events.emit({
        kind: "run.delivered",
        runId: run.id,
        payload: {
          ...(found.url ? { url: found.url } : {}),
          capability: capability.name,
          source: request.source,
          target: request.target,
          channel: options.channel,
        },
      });
      return delivered;
    });
  } finally {
    if (!options.lease) lease.release();
  }
}

/* ---- the push ---- */

function identityOf(actor: Actor): { name: string; email: string } {
  return { name: actor.display ?? actor.id, email: actor.id };
}

/**
 * The run's tree as one commit on its base. Its dates are those of the branch's last commit, so the
 * same run makes the same commit every time it is asked (the journal's key does not change).
 */
async function squashed(
  runtime: Runtime,
  run: Run,
  base: string,
  branch: string,
  message: string,
): Promise<string> {
  const repo = run.workspace.repoRoot;
  const tree = await must(git(["rev-parse", `${branch}^{tree}`], repo), "read the run's tree");
  const date = await must(git(["log", "-1", "--format=%cI", branch], repo), "read the branch's date");
  const env = {
    ...gitIdentityEnv(runtime.env, identityOf(run.owner)),
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
  return must(git(["commit-tree", tree, "-p", base, "-m", message], repo, { env }), "make the PR's commit");
}

async function push(runtime: Runtime, run: Run, request: PrRequest): Promise<{ pushed: string }> {
  // the person's own git: its credential helper or ssh agent; no token is ever an argument
  const r = await git(
    ["push", "--porcelain", request.remote, `${request.commit}:refs/heads/${request.source}`],
    run.workspace.repoRoot,
    { env: runtime.env, timeoutMs: 300_000 },
  );
  if (r.code !== 0) {
    const why = runtime.redactor.redact(
      (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-3).join(" "),
    ).text;
    throw new DeliveryError("push", `git push to ${request.remote} failed: ${why}`);
  }
  return { pushed: request.commit };
}

/** ADR-0002 §3: the remote's branch is the marker — at our commit, the push happened. */
async function pushed(run: Run, request: PrRequest): Promise<{ pushed: string } | "not-found" | undefined> {
  const r = await git(["ls-remote", request.remote, `refs/heads/${request.source}`], run.workspace.repoRoot);
  if (r.code !== 0) return undefined;
  const sha = r.stdout.trim().split(/\s+/)[0];
  return sha === request.commit ? { pushed: sha } : "not-found";
}

/* ---- the PR ---- */

function prArgs(request: PrRequest): Record<string, unknown> {
  return {
    ...(request.workspace ? { workspace: request.workspace } : {}),
    ...(request.repo ? { repo: request.repo } : {}),
    title: request.title,
    description: request.description,
    source: request.source,
    target: request.target,
  };
}

function toolContext(runtime: Runtime, run: Run, lease: HeldLease): ToolContext {
  return {
    run,
    stepId: DELIVERY_STEP,
    iteration: 1,
    lease,
    workspacePath: existsSync(run.workspace.path) ? run.workspace.path : run.workspace.repoRoot,
    runtime,
    redactor: runtime.redactor,
    pathPolicy: runtime.pathPolicy,
    env: runtime.env,
  };
}

/** The PR's link and id from what the server answered: its JSON (`links.html.href`, `url`), else the text. */
export function linkOf(out: ToolOutput): { url?: string; id?: string } {
  const parsed = (() => {
    if (out.data && typeof out.data === "object") return out.data as Record<string, unknown>;
    try {
      const v = JSON.parse(out.text ?? "") as unknown;
      return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  })();
  const str = (v: unknown) =>
    typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined;
  const links = parsed?.links as Record<string, unknown> | undefined;
  const html = links?.html as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  const self = links?.self as Array<Record<string, unknown>> | undefined;
  const url =
    str((Array.isArray(html) ? html[0] : html)?.href) ??
    str(Array.isArray(self) ? self[0]?.href : undefined) ??
    str(parsed?.html_url) ??
    str(parsed?.url) ??
    /https?:\/\/\S*pull[^\s"')\]]*/i.exec(out.text ?? "")?.[0] ??
    /https?:\/\/[^\s"')\]]+/.exec(out.text ?? "")?.[0];
  const id = str(parsed?.id) ?? str(parsed?.number);
  return { ...(url ? { url } : {}), ...(id ? { id } : {}) };
}

/* ---- what the PR says ---- */

interface RunDocuments {
  readonly title?: string;
  readonly summary?: string;
  readonly goals: readonly string[];
  readonly changes?: string;
}

function json(runtime: Runtime, run: Run, type: string): Record<string, unknown> | undefined {
  const artifact = runtime.artifacts.listLatest(run.id, type)[0];
  if (!artifact) return undefined;
  try {
    const v = JSON.parse(runtime.artifacts.text(artifact)) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function documentsOf(runtime: Runtime, run: Run): RunDocuments {
  const spec = json(runtime, run, "spec");
  const impl = json(runtime, run, "implementation");
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const title = text(spec?.title);
  const summary = text(spec?.summary);
  const changes = text(impl?.summary);
  return {
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    goals: Array.isArray(spec?.goals) ? spec.goals.filter((g): g is string => typeof g === "string") : [],
    ...(changes ? { changes } : {}),
  };
}

/** The task's first line, short: the title when the run has no spec. */
function subjectOf(task: string): string {
  const first = (task.split("\n")[0] ?? task).trim();
  return first.length > 72 ? `${first.slice(0, 69).trimEnd()}…` : first;
}

const MAX_FILES = 30;

function descriptionOf(run: Run, docs: RunDocuments, files: readonly string[]): string {
  const parts: string[] = [docs.summary ?? run.task.trim()];
  if (docs.goals.length > 0) parts.push(`Goals:\n${docs.goals.map((g) => `- ${g}`).join("\n")}`);
  if (docs.changes) parts.push(`Changes:\n${docs.changes}`);
  const shown = files.slice(0, MAX_FILES).map((f) => `- ${f}`);
  if (files.length > MAX_FILES) shown.push(`- … and ${files.length - MAX_FILES} more`);
  parts.push(`Files (${files.length}):\n${shown.join("\n")}`);
  // neutral: who prepared it, no links anywhere
  parts.push(`Prepared by Jarvis, run ${shortRunId(run.id)}.`);
  return parts.join("\n\n");
}

/* ---- where ---- */

/** `acme/orders-api` from the remote's URL: ssh, https, Bitbucket Server's `/scm/<project>/<repo>`. */
export function repositoryFromUrl(url: string): { workspace?: string; repo?: string } {
  const path = url
    .trim()
    .replace(/\.git$/, "")
    .replace(/^[a-z+]+:\/\/[^/]+\//i, "")
    .replace(/^[^@/]+@[^:/]+:/, "")
    .replace(/\/+$/, "");
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) return {};
  return { workspace: segments.at(-2) as string, repo: segments.at(-1) as string };
}

async function repositoryOf(
  repoRoot: string,
  remote: string,
): Promise<{ workspace?: string; repo?: string }> {
  const r = await git(["remote", "get-url", remote], repoRoot);
  return r.code === 0 ? repositoryFromUrl(r.stdout) : {};
}

/** The remote's default branch as git knows it (`origin/HEAD`), else `main`. */
async function defaultBranchOf(repoRoot: string, remote: string): Promise<string> {
  const r = await git(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], repoRoot);
  const name = r.code === 0 ? r.stdout.trim().replace(new RegExp(`^${remote}/`), "") : "";
  return name || "main";
}

async function must(promise: ReturnType<typeof git>, what: string): Promise<string> {
  const r = await promise;
  if (r.code !== 0)
    throw new DeliveryError("push", `${what}: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}
