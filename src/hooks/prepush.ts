import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine } from "../app/engine.ts";
import type { Runtime } from "../app/runtime.ts";
import { resolveActor } from "../core/actor/resolve.ts";
import type { ResolvedConfig } from "../core/config/schema.ts";
import { checkStandards, type Violation } from "../knowledge/check.ts";
import { globMatches } from "../knowledge/frontmatter.ts";
import { impactOf, repoIdOf, updateGraph } from "../knowledge/graph/update.ts";
import { loadStandards, type Standard } from "../knowledge/standards.ts";
import { leaseOwner } from "../orchestration/lease.ts";
import { newRunId } from "../storage/runStore.ts";
import { git, runShell } from "../tools/local/exec.ts";
import type { CommitRange } from "./range.ts";

/**
 * `jarvis prepush` core (ADR-0001 §16): everything that can be decided without a model comes first
 * — standards, project checks, graph impact — and the review agent is called only when that
 * evidence says a human-like read is worth the tokens.
 */
export type Severity = "blocker" | "major" | "minor" | "nit";
const SEVERITY_RANK: Record<Severity, number> = { blocker: 3, major: 2, minor: 1, nit: 0 };

export interface CheckResult {
  readonly name: string;
  readonly command?: string;
  readonly ok: boolean;
  readonly skipped?: string;
  readonly ms: number;
  readonly output?: string;
}

export interface ReviewFinding {
  readonly severity: Severity;
  readonly file?: string;
  readonly line?: number;
  readonly issue: string;
  readonly suggestion?: string;
}

export type ReviewDecision = "ran" | "not-needed" | "disabled" | "skipped" | "unavailable";

export interface RangeReport {
  readonly branch: string;
  readonly base: string;
  readonly head: string;
  readonly baseLabel: string;
  readonly files: string[];
  readonly standards: {
    readonly checked: number;
    readonly violations: Violation[];
    readonly skipped: Array<{ standard: string; reason: string }>;
  };
  readonly checks: CheckResult[];
  readonly impact:
    | { readonly available: true; readonly untouchedDependents: string[]; readonly untouchedTests: string[] }
    | { readonly available: false; readonly reason: string };
  readonly review: {
    readonly decision: ReviewDecision;
    readonly reasons: string[];
    readonly runId?: string;
    readonly state?: string;
    readonly verdict?: string;
    readonly findings: ReviewFinding[];
  };
  /** Why this range blocks the push, in `block` mode. */
  readonly blocking: string[];
  readonly notes: string[];
}

export interface PrePushOptions {
  readonly semantic?: "auto" | "never" | "always";
  readonly cwd: string;
  readonly projectRoot: string;
  readonly env: NodeJS.ProcessEnv;
}

function tail(text: string, max = 1500): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}

/** The pushed commit as a directory: the checkout itself when it is already there, else a temporary worktree. */
async function materialise(
  projectRoot: string,
  head: string,
): Promise<{ path: string; temporary: boolean; dirty: boolean; cleanup: () => Promise<void> }> {
  const current = await git(["rev-parse", "HEAD"], projectRoot);
  const status = await git(["status", "--porcelain", "--untracked-files=no"], projectRoot);
  const dirty = status.code === 0 && status.stdout.trim().length > 0;
  if (current.code === 0 && current.stdout.trim() === head)
    return { path: projectRoot, temporary: false, dirty, cleanup: async () => {} };
  const dir = mkdtempSync(join(tmpdir(), "jarvis-prepush-"));
  const added = await git(["worktree", "add", "--detach", "--quiet", dir, head], projectRoot);
  if (added.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`cannot check out ${head.slice(0, 10)}: ${added.stderr.trim()}`);
  }
  return {
    path: dir,
    temporary: true,
    dirty: false,
    cleanup: async () => {
      await git(["worktree", "remove", "--force", dir], projectRoot);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function appliesTo(standard: Standard, files: readonly string[]): boolean {
  const paths = standard.scope.paths;
  return paths.length === 0 || files.some((f) => globMatches(f, paths));
}

export async function analyseRange(
  runtime: Runtime,
  range: CommitRange,
  options: PrePushOptions,
): Promise<RangeReport> {
  const config: ResolvedConfig = runtime.loaded.config;
  const policy = config.hooks.prePush;
  const notes: string[] = [];
  const blocking: string[] = [];
  const diff = await git(
    ["diff", "--name-only", "--diff-filter=ACMR", `${range.base}..${range.head}`, "--"],
    options.projectRoot,
  );
  const files = diff.code === 0 ? diff.stdout.split("\n").filter(Boolean).sort() : [];
  const empty: RangeReport["review"] = { decision: "not-needed", reasons: [], findings: [] };
  const base = {
    branch: range.branch,
    base: range.base,
    head: range.head,
    baseLabel: range.baseLabel,
    files,
  };
  if (diff.code !== 0) notes.push(`git diff failed: ${diff.stderr.trim()}`);
  if (files.length === 0) {
    return {
      ...base,
      standards: { checked: 0, violations: [], skipped: [] },
      checks: [],
      impact: { available: false, reason: "no changed files" },
      review: { ...empty, reasons: ["no changed files"] },
      blocking,
      notes,
    };
  }

  const workspace = await materialise(options.projectRoot, range.head);
  try {
    if (workspace.dirty)
      notes.push(
        "the working tree has uncommitted changes; checks run against it, not only the pushed commit",
      );

    /* 1. standards — deterministic */
    const standards = loadStandards({ projectRoot: workspace.path, userRoot: runtime.loaded.home.root });
    let standardsReport: RangeReport["standards"] = { checked: 0, violations: [], skipped: [] };
    if (policy.standards) {
      const report = await checkStandards({
        standards,
        workspace: workspace.path,
        files,
        baseRef: range.base,
        runTool: async (capability, args) => {
          const name = capability.startsWith("project.") ? capability.slice(8) : undefined;
          const command = name ? config.tools.local[name] : undefined;
          if (!command) return { ok: false, text: "", denied: "not available in a pre-push check" };
          const extra = typeof args.args === "string" ? ` ${args.args}` : "";
          const r = await runShell(`${command}${extra}`, {
            cwd: workspace.path,
            timeoutMs: config.tools.commandTimeoutMs,
            env: options.env,
          });
          return { ok: r.code === 0, text: tail(`${r.stdout}\n${r.stderr}`) };
        },
      });
      standardsReport = {
        checked: report.checked.length,
        violations: report.violations,
        skipped: report.skipped,
      };
      for (const v of report.violations.filter((x) => x.severity === "required"))
        blocking.push(
          `standard ${v.standardId}@${v.version}${v.file ? ` ${v.file}${v.line ? `:${v.line}` : ""}` : ""}: ${v.detail.split("\n")[0]}`,
        );
    }

    /* 2. project checks (typecheck, lint, tests …) — only where the dependencies are */
    const checks: CheckResult[] = [];
    for (const name of policy.checks) {
      const command = config.tools.local[name];
      if (!command) {
        checks.push({ name, ok: false, ms: 0, output: `no tools.local.${name} command is configured` });
        blocking.push(`check ${name}: not configured in tools.local`);
        continue;
      }
      if (workspace.temporary) {
        checks.push({ name, command, ok: true, skipped: "the pushed branch is not checked out", ms: 0 });
        continue;
      }
      const r = await runShell(command, {
        cwd: workspace.path,
        timeoutMs: config.tools.commandTimeoutMs,
        env: options.env,
      });
      const ok = r.code === 0 && !r.timedOut;
      checks.push({
        name,
        command,
        ok,
        ms: r.durationMs,
        ...(ok ? {} : { output: tail(`${r.stdout}\n${r.stderr}`) }),
      });
      if (!ok) blocking.push(`check ${name} ${r.timedOut ? "timed out" : `failed (exit ${r.code})`}`);
    }
    if (workspace.temporary && policy.checks.length > 0)
      notes.push("project checks were skipped: they run only for the checked-out branch");

    /* 3. graph impact — what the change reaches that the change did not touch */
    let impact: RangeReport["impact"];
    try {
      const extractors = runtime.capabilities
        .list()
        .map((a) => a.graphExtractor?.())
        .filter((e) => e !== undefined);
      if (extractors.length === 0) {
        impact = { available: false, reason: "no language adapter with a project graph for this stack" };
      } else {
        const result = await updateGraph({
          workspace: workspace.path,
          repoId: repoIdOf(options.projectRoot),
          cacheRoot: runtime.loaded.home.cacheDir,
          extractors,
          store: runtime.graph,
        });
        const reach = impactOf(result.snapshot, files);
        const touched = new Set(files);
        impact = {
          available: true,
          untouchedDependents: reach.dependents.map((d) => d.file).filter((f) => !touched.has(f)),
          untouchedTests: reach.tests.filter((t) => !touched.has(t)),
        };
      }
    } catch (error) {
      impact = { available: false, reason: error instanceof Error ? error.message : String(error) };
    }

    /* 4. is a semantic review worth it? */
    const mode = options.semantic ?? policy.semanticReview;
    const reasons: string[] = [];
    const semanticStandards = standards.filter(
      (s) => s.verification.kind !== "deterministic" && appliesTo(s, files),
    );
    if (mode === "always") reasons.push("semanticReview: always");
    if (semanticStandards.length > 0)
      reasons.push(`semantic standards apply: ${semanticStandards.map((s) => s.id).join(", ")}`);
    if (impact.available && impact.untouchedTests.length > 0)
      reasons.push(`${impact.untouchedTests.length} test file(s) cover the change but were not touched`);
    if (impact.available && impact.untouchedDependents.length > 0)
      reasons.push(`${impact.untouchedDependents.length} dependent file(s) were not touched`);

    let review: RangeReport["review"];
    if (mode === "never") review = { ...empty, decision: "disabled", reasons: ["semanticReview: never"] };
    else if (reasons.length === 0) review = { ...empty, reasons: ["no signal asks for a semantic review"] };
    else if (policy.mode === "block" && blocking.length > 0)
      review = { ...empty, decision: "skipped", reasons: ["deterministic failures come first", ...reasons] };
    else review = await runReview(runtime, range, workspace.path, workspace.temporary, reasons, options);

    for (const f of review.findings)
      if (SEVERITY_RANK[f.severity] >= SEVERITY_RANK[policy.blockOn])
        blocking.push(
          `review ${f.severity}${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : ""}: ${f.issue.split("\n")[0]}`,
        );

    return { ...base, standards: standardsReport, checks, impact, review, blocking, notes };
  } finally {
    await workspace.cleanup();
  }
}

/** Runs the `review-diff` workflow over the range. Infrastructure trouble never blocks a push. */
async function runReview(
  runtime: Runtime,
  range: CommitRange,
  workspacePath: string,
  temporary: boolean,
  reasons: string[],
  options: PrePushOptions,
): Promise<RangeReport["review"]> {
  const unavailable = (why: string): RangeReport["review"] => ({
    decision: "unavailable",
    reasons: [...reasons, why],
    findings: [],
  });
  try {
    const resolved = await resolveActor(runtime.loaded.config, options.env, runtime.loaded.project?.root);
    if (!resolved.actor)
      return unavailable("cannot determine the actor (JARVIS_ACTOR, actor.id or git config user.email)");
    const engine = createEngine(runtime);
    const run = runtime.runs.create({
      id: newRunId(),
      task: `pre-push review of ${range.branch} (${range.base.slice(0, 10)}..${range.head.slice(0, 10)})`,
      workflow: "review-diff",
      owner: resolved.actor,
      workspace: {
        mode: "cwd",
        repoRoot: options.projectRoot,
        path: workspacePath,
        baseRef: range.base,
        baseCommit: range.base,
        headCommit: range.head,
      },
      dataClass: runtime.loaded.config.dataClass,
      ...(runtime.loaded.config.profile ? { profile: runtime.loaded.config.profile } : {}),
    });
    runtime.events.emit({
      kind: "run.created",
      runId: run.id,
      actor: `${resolved.actor.kind}:${resolved.actor.id}`,
      payload: { task: run.task, workflow: "review-diff", trigger: "pre-push", temporary },
    });
    const result = await engine.execute(run.id, { owner: leaseOwner("ci"), steal: false });
    const artifact = runtime.artifacts.listLatest(run.id, "review").at(-1);
    if (result.run.state !== "COMPLETED" || !artifact)
      return {
        decision: "unavailable",
        reasons: [
          ...reasons,
          `the review run ended ${result.run.state}${result.run.stateReason ? `: ${result.run.stateReason}` : ""}`,
        ],
        runId: run.id,
        state: result.run.state,
        findings: [],
      };
    const doc = JSON.parse(runtime.artifacts.text(artifact)) as {
      verdict?: string;
      findings?: ReviewFinding[];
    };
    return {
      decision: "ran",
      reasons,
      runId: run.id,
      state: result.run.state,
      ...(doc.verdict ? { verdict: doc.verdict } : {}),
      findings: doc.findings ?? [],
    };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}
