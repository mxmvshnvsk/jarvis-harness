import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRegistry } from "../../capabilities/registry.ts";
import { collectSources } from "../../design/collect.ts";
import { changedFiles, checkStandards } from "../../knowledge/check.ts";
import { impactOf, repoIdOf, updateGraph } from "../../knowledge/graph/update.ts";
import { loadStandards } from "../../knowledge/standards.ts";
import { verifyModuleStep } from "../../onboarding/moduleRun.ts";
import { git } from "../../tools/local/exec.ts";
import { filesFor, packageDirOf, rulesFor } from "../../tools/local/fix.ts";
import type { DeterministicTool } from "../executors.ts";
import { failingOnBase, junitFailures } from "./baseline.ts";
import { CROSS_TOOLS } from "./cross.ts";
import { excerptText } from "./excerpt.ts";
import { hookChecks } from "./hookChecks.ts";
import { PR_FIX_TOOLS } from "./prFix.ts";
import { rebuildsFor } from "./rebuild.ts";
import { RELATED_TOOLS } from "./related.ts";
import { classSelection, coveringTests, fileSelection, testRunnerOf } from "./relatedTests.ts";
import {
  changedLinesOf,
  failureReasons,
  junitTestFailures,
  type PlacedFailure,
  placeFailure,
  type TestFailure,
} from "./testReport.ts";

/**
 * Deterministic tools that need nothing but the stores. Repository, git, test and typecheck
 * tools arrive with the Tool Platform (stage 4).
 */
/** What makes a change too big or too wide for an impact analysis without a model. */
export const QUICK_IMPACT = { maxFiles: 2, maxDependents: 15 } as const;
/** The spec talks about telemetry or documentation: the agent decides what of it is affected. */
const BEYOND_CODE =
  /\b(telemetry|metrics?|analytics|tracking|logging|events?|docs|documentation|readme|changelog)\b|метрик|аналитик|событи|документац/i;
const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|py|go|rs|java|kt|kts|groovy|scala|cs|rb|php|swift)$/;
const TEST_FILE = /(\.|_)(test|spec)\.[a-z]+$|(^|\/)(__tests__|tests?)\//;
/** The whole output of a failed check (`project.checks`), for a person; not carried to a run that goes on. */
export const CHECK_LOG = "check-log";
/** Failed tests kept on a check result: enough to see why, not a report of a broken suite. */
const MAX_FAILURES = 20;

/** Repository files named in a text: `src/a.ts`, `src/a.ts:89`, `apps/web/src/x.tsx:12-20`. */
export function filesNamedIn(text: string, workspace: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(
    /(?:^|[\s`'"([])((?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z]{1,6})(?::\d+(?:-\d+)?)?/g,
  )) {
    const path = (m[1] as string).replace(/^\.\//, "");
    if (path.includes("..") || path.startsWith("/")) continue;
    const abs = join(workspace, path);
    if (existsSync(abs) && statSync(abs).isFile()) found.add(path);
  }
  return [...found].sort();
}

/**
 * Of the test classes a check failed on, those that fail on the run's base commit too; `excused` when
 * that is all of them. Nothing is excused when the reports name no class (a compile error) or the base
 * cannot be checked.
 */
async function preexistingOf(
  ctx: Parameters<DeterministicTool>[0],
  runner: "gradle" | "maven",
  command: string,
  failing: readonly string[],
): Promise<{ classes: string[]; excused: boolean } | undefined> {
  const ref = ctx.workspace.ref;
  if (failing.length === 0) return undefined;
  // a checkout of the project itself (cwd mode) has its base at the ref it started from
  const resolved = ref.baseCommit
    ? undefined
    : await git(["rev-parse", "--verify", `${ref.baseRef}^{commit}`], ref.repoRoot);
  const baseCommit = ref.baseCommit ?? (resolved?.code === 0 ? resolved.stdout.trim() : undefined);
  if (!baseCommit) return undefined;
  const loaded = ctx.runtime.loaded;
  const onBase = await failingOnBase({
    repoRoot: ref.repoRoot,
    baseCommit,
    runner,
    command,
    classes: failing,
    worktreesDir: loaded.home.worktreesDir,
    cacheDir: loaded.home.cacheDir,
    repoId: repoIdOf(ref.repoRoot),
    setup: loaded.config.workspace.setup,
    checkout: loaded.config.workspace.checkout,
    depsCache: loaded.config.workspace.cache
      ? { dir: join(loaded.home.cacheDir, "deps"), ...loaded.config.workspace.cache }
      : undefined,
    timeoutMs: loaded.config.tools.commandTimeoutMs,
    env: process.env,
  });
  if (!onBase) return undefined;
  const classes = failing.filter((c) => onBase.has(c));
  ctx.runtime.events.emit({
    kind: "checks.baseline",
    runId: ctx.run.id,
    stepId: ctx.step.id,
    iteration: ctx.iteration,
    payload: { failing: failing.length, preexisting: classes.length, base: baseCommit.slice(0, 10) },
  });
  return { classes, excused: classes.length === failing.length };
}

export const BUILTIN_TOOLS: Record<string, DeterministicTool> = {
  noop: async () => ({ status: "success" }),

  /** A task across services (ADR-0025 §6): catalog, spawn, wait, contract check, delivery. */
  ...CROSS_TOOLS,

  /** The work of related tasks (ADR-0026): read before the spec, checked again before implementation. */
  ...RELATED_TOOLS,
  ...PR_FIX_TOOLS,

  /** The task's inputs read by code (src/design/collect.ts): its issues and pages, API methods, design frames. */
  "sources.collect": collectSources,
  /** The step's first name, when it read only design frames: workflows of a project may still use it. */
  "design.collect": collectSources,

  /** The onboarding mapper's claims against the code; the survivors become a candidate. */
  "onboard.verify": verifyModuleStep,

  fail: async (_ctx, args) => ({ status: "failure", reason: String(args.reason ?? "failed on purpose") }),

  /** Writes a static artifact — used by the smoke workflow and by tests. */
  "artifact.write": async (ctx, args) => {
    const type = String(args.type ?? "note");
    const name = String(args.name ?? `${type}.md`);
    const content = String(args.content ?? "");
    const artifact = ctx.runtime.artifacts.put({
      runId: ctx.run.id,
      type,
      name,
      content,
      provenance: { kind: "tool", capability: "artifact.write" },
      stepId: ctx.step.id,
      iteration: ctx.iteration,
    });
    return { status: "success", outputs: [`${artifact.artifactId}@${artifact.version}`] };
  },

  /** ADR-0021 §3: stack detection and the capability level, recorded before any agent runs. */
  "project.discover": async (ctx) => {
    const registry = ctx.runtime.capabilities ?? new CapabilityRegistry();
    const meta = ctx.runtime.loaded.meta;
    const caps = await registry.discover(ctx.runtime.loaded.config, ctx.workspace.ref.path, {
      knowledgeRepo: !!meta && !meta.service,
    });
    // The project graph is what impact analysis stands on: bring it up to date for this tree (cheap when
    // nothing changed — facts come from the content-addressed cache) so agents never meet a stale or missing one.
    try {
      const extractors = (ctx.runtime.capabilities ?? registry)
        .list()
        .map((adapter) => adapter.graphExtractor?.())
        .filter((e) => e !== undefined);
      if (extractors.length > 0) {
        const started = Date.now();
        const result = await updateGraph({
          workspace: ctx.workspace.ref.path,
          repoId: repoIdOf(ctx.workspace.ref.path),
          cacheRoot: ctx.runtime.loaded.home.cacheDir,
          extractors,
          store: ctx.runtime.graph,
        });
        ctx.runtime.events.emit({
          kind: "graph.update",
          runId: ctx.run.id,
          stepId: ctx.step.id,
          payload: {
            snapshot: result.snapshot.id,
            reused: result.reused,
            extracted: result.extracted,
            cacheHits: result.cacheHits,
            ms: Date.now() - started,
            trigger: "discover",
          },
        });
      }
    } catch (error) {
      ctx.runtime.events.emit({
        kind: "graph.update_failed",
        runId: ctx.run.id,
        stepId: ctx.step.id,
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
    }
    const artifact = ctx.runtime.artifacts.put({
      runId: ctx.run.id,
      type: "project-capabilities",
      name: "project-capabilities.json",
      content: JSON.stringify(caps, null, 2),
      mediaType: "application/json",
      provenance: { kind: "tool", capability: "project.discover" },
      stepId: ctx.step.id,
      iteration: ctx.iteration,
    });
    ctx.runtime.events.emit({
      kind: "stack_detected",
      runId: ctx.run.id,
      stepId: ctx.step.id,
      payload: { stacks: caps.stacks, level: caps.level, adapters: caps.adapters.map((a) => a.id) },
    });
    if (caps.level === "UNSUPPORTED") {
      return {
        status: "failure",
        reason: `policy: capability level UNSUPPORTED — ${caps.reasons.join("; ")}`,
        outputs: [`${artifact.artifactId}@${artifact.version}`],
      };
    }
    if (caps.level === "BASIC") {
      ctx.runtime.events.emit({
        kind: "language_adapter_degraded",
        runId: ctx.run.id,
        stepId: ctx.step.id,
        payload: { reasons: caps.reasons },
      });
    }
    return { status: "success", outputs: [`${artifact.artifactId}@${artifact.version}`] };
  },

  /**
   * Deterministic standards verification (ADR-0020 §2): pattern and tool checks over the files
   * changed in the workspace. Required violations → outcome `standards_violation` with reasons.
   */
  "standards.check": async (ctx) => {
    const workspace = ctx.workspace.ref.path;
    const standards = loadStandards({ projectRoot: workspace, userRoot: ctx.runtime.loaded.home.root });
    // The base commit, not the ref: in a worktree HEAD moves with every checkpoint (ADR-0003 §3).
    const base = ctx.workspace.ref.baseCommit ?? ctx.workspace.ref.baseRef;
    const files = await changedFiles(workspace, base);
    const report = await checkStandards({
      standards,
      workspace,
      files,
      baseRef: base,
      runTool: async (capability, args) => {
        const r = await ctx.tools.invoke(capability, args);
        return { ok: r.ok, text: r.text, ...(r.denied ? { denied: r.denied } : {}) };
      },
    });
    const required = report.violations.filter((v) => v.severity === "required");
    // `reasons` in the shape agents use, so the loop context quotes them (ADR-0004 §4).
    const reasons = required.map((v) => ({
      kind: "standards_violation",
      summary: `${v.standardId}@${v.version}${v.file ? ` ${v.file}${v.line ? `:${v.line}` : ""}` : ""}: ${v.detail.split("\n")[0]}`,
      sourceRefs: [`standard:${v.standardId}@${v.version}`, ...(v.file ? [v.file] : [])],
    }));
    const artifact = ctx.runtime.artifacts.put({
      runId: ctx.run.id,
      type: "standards-check",
      name: "standards-check.json",
      content: JSON.stringify({ ...report, reasons }, null, 2),
      mediaType: "application/json",
      provenance: { kind: "tool", capability: "standards.check" },
      sourceRefs: report.checked,
      stepId: ctx.step.id,
      iteration: ctx.iteration,
    });
    ctx.runtime.events.emit({
      kind: "standards.checked",
      runId: ctx.run.id,
      stepId: ctx.step.id,
      iteration: ctx.iteration,
      payload: {
        checked: report.checked.length,
        violations: report.violations.length,
        required: required.length,
      },
    });
    const outputs = [`${artifact.artifactId}@${artifact.version}`];
    if (required.length === 0) return { status: "success", outputs };
    return {
      status: "success",
      outcome: "standards_violation",
      outputs,
      reason: reasons
        .slice(0, 10)
        .map((r) => r.summary)
        .join("; "),
    };
  },

  /**
   * The project's own checks on what the run changed, without a model (stage of `verify`): every
   * `tools.local` command named `test*` or `typecheck*` whose package (`cd <dir> && …`) holds a
   * changed file; jest runs only the tests related to the changed files (`--findRelatedTests`), a
   * Gradle or Maven test task only the test classes the project graph says cover them.
   * A failing check → outcome `defects_found` with the command and the tail of its output, so the
   * implementation goes back with the evidence. Pilot: tests were "verified" by an agent, with no
   * plain run of jest or tsc.
   */
  /**
   * Impact of a small change without a model (`quick:` of the impact step): the files the approved
   * spec names, their dependents from the project graph and the tests that cover them. Anything else
   * — no file named, more than two, a wide reach, telemetry or documentation in the spec — is
   * `needs_agent` and the impact agent does it. Pilot: impact was one more model call of up to five
   * minutes for a one-line fix whose file the spec already named.
   */
  "impact.quick": async (ctx) => {
    const latest = (type: string) => {
      const a = ctx.runtime.artifacts.listLatest(ctx.run.id, type)[0];
      // a name, not the artifact id: the document goes into later prompts and must not change from run to run
      return a ? { ref: `${a.type}/${a.name}@${a.version}`, text: ctx.runtime.artifacts.text(a) } : undefined;
    };
    const spec = latest("spec");
    if (!spec) return { status: "success", outcome: "needs_agent", reason: "no spec to take the files from" };
    const research = latest("research");
    const workspace = ctx.workspace.ref.path;
    const named = filesNamedIn(spec.text, workspace);
    const code = named.filter((f) => CODE_FILE.test(f) && !TEST_FILE.test(f));
    const why =
      code.length === 0
        ? "the spec names no code file"
        : code.length > QUICK_IMPACT.maxFiles
          ? `the spec names ${code.length} code files`
          : BEYOND_CODE.test(spec.text)
            ? "the spec touches telemetry or documentation"
            : undefined;
    if (why) return { status: "success", outcome: "needs_agent", reason: why };
    const extractors = (ctx.runtime.capabilities ?? new CapabilityRegistry())
      .list()
      .map((adapter) => adapter.graphExtractor?.())
      .filter((e) => e !== undefined);
    if (extractors.length === 0)
      return { status: "success", outcome: "needs_agent", reason: "no project graph for this stack" };
    const graph = await updateGraph({
      workspace,
      repoId: repoIdOf(workspace),
      cacheRoot: ctx.runtime.loaded.home.cacheDir,
      extractors,
      store: ctx.runtime.graph,
    });
    const reach = impactOf(graph.snapshot, code, 2);
    // a test that imports the code is a test of it, not a dependent
    const dependents = reach.dependents.filter((d) => !TEST_FILE.test(d.file));
    if (dependents.length > QUICK_IMPACT.maxDependents)
      return {
        status: "success",
        outcome: "needs_agent",
        reason: `${dependents.length} files depend on the change`,
      };
    const tests = [
      ...new Set([
        ...reach.tests,
        ...reach.dependents.filter((d) => TEST_FILE.test(d.file)).map((d) => d.file),
        ...named.filter((f) => TEST_FILE.test(f)),
      ]),
    ].sort();
    const doc = {
      summary: `Derived without a model from the files the approved spec names (${code.join(", ")}), their dependents in the project graph and the tests that cover them.`,
      sources: [spec.ref, ...(research ? [research.ref] : []), ...code],
      reasons: [],
      affected: [
        ...code.map((path) => ({ path, kind: "code" as const, reason: "named in the approved spec" })),
        ...tests.map((path) => ({ path, kind: "test" as const, reason: "covers the changed code" })),
      ],
      dependencies: dependents.map((d) => (d.distance === 1 ? d.file : `${d.file} (via another file)`)),
      risks:
        dependents.length > 0
          ? [`${dependents.length} file(s) import the changed code; their behaviour may change with it`]
          : [],
      unknowns: reach.unresolved.length > 0 ? [`unresolved imports: ${reach.unresolved.join(", ")}`] : [],
      outcome: "ok",
    };
    const artifact = ctx.runtime.artifacts.put({
      runId: ctx.run.id,
      type: "impact",
      name: "impact.json",
      content: JSON.stringify(doc, null, 2),
      mediaType: "application/json",
      provenance: { kind: "tool", capability: "impact.quick" },
      stepId: ctx.step.id,
      iteration: ctx.iteration,
    });
    return {
      status: "success",
      outputs: [`${artifact.artifactId}@${artifact.version}`],
      reason: `impact from the spec's ${code.length === 1 ? "file" : "files"} and the code graph, no model call`,
    };
  },

  "project.checks": async (ctx) => {
    const workspace = ctx.workspace.ref.path;
    const base = ctx.workspace.ref.baseCommit ?? ctx.workspace.ref.baseRef;
    const changed = await changedFiles(workspace, base);
    const results: Array<{
      check: string;
      command: string;
      ok: boolean;
      skipped?: string;
      tail?: string;
      fixed?: string[];
      /** Test classes that fail on the base commit too: not the run's (src/orchestration/tools/baseline.ts). */
      preexisting?: string[];
      /** The failed command's whole output: a `check-log` artifact (`artifactId@version`). */
      log?: string;
      /** Why the tests failed, from the runner's reports (src/orchestration/tools/testReport.ts). */
      failures?: Array<TestFailure & { preexisting?: boolean }>;
      tests?: { failed: number; total?: number };
      /** A test check that ran no test: the build or the environment broke before (src/app/rounds.ts). */
      notStarted?: boolean;
      /** What broke, from the whole output, when the runner wrote no report: the agent's reason. */
      excerpt?: string;
      /** Said, not a defect: the commit-msg hook on the message the PR's commit will have. */
      advisory?: boolean;
    }> = [];
    const tools = ctx.runtime.loaded.config.tools;
    const tail = (r: { text?: string; denied?: string }): string =>
      (r.text ?? r.denied ?? "").split("\n").slice(-40).join("\n");
    // a failed command's whole output, kept: the tail above is for the agent's reasons, a person
    // reading why tests failed needs all of it (pilot: the tail held the summary, not the failure)
    const logOf = (check: string, r: { ok: boolean; text?: string; denied?: string }) => {
      const text = r.text ?? r.denied ?? "";
      if (r.ok || text.split("\n").length <= 40) return {};
      const log = ctx.runtime.artifacts.put({
        runId: ctx.run.id,
        type: CHECK_LOG,
        name: `${check.replace(/[^\w.-]+/g, "-")}.log`,
        content: text,
        mediaType: "text/plain",
        provenance: { kind: "tool", capability: `project.${check}` },
        stepId: ctx.step.id,
        iteration: ctx.iteration,
      });
      return { log: `${log.artifactId}@${log.version}` };
    };
    // the fixers first (tools.fix): what they fix is no defect, what they cannot is lint's to report
    for (const { run, files } of rulesFor(
      tools.fix,
      changed.filter((f) => existsSync(join(workspace, f))),
    )) {
      const command = tools.local[run];
      if (!command) {
        results.push({
          check: `fix:${run}`,
          command: run,
          ok: false,
          tail: `no tools.local command "${run}"`,
        });
        continue;
      }
      const read = () => files.map((f) => readFileSync(join(workspace, f), "utf8"));
      const before = read();
      await ctx.tools.invoke(`project.${run}`, { args: filesFor(command, files) });
      const after = read();
      const fixed = files.filter((_, i) => before[i] !== after[i]);
      results.push({
        check: `fix:${run}`,
        command: `${command} ${filesFor(command, files)}`,
        ok: true,
        ...(fixed.length > 0 ? { fixed } : {}),
      });
    }
    // what the checks read built: rebuilt first, from the run's sources
    const rebuilt: string[] = [];
    for (const name of rebuildsFor(tools, changed)) {
      const command = tools.local[name];
      if (!command) {
        results.push({
          check: `rebuild:${name}`,
          command: name,
          ok: false,
          tail: `no tools.local command "${name}"`,
        });
        continue;
      }
      const r = await ctx.tools.invoke(`project.${name}`, {});
      results.push({
        check: `rebuild:${name}`,
        command,
        ok: r.ok,
        ...(r.ok ? {} : { tail: tail(r), ...logOf(`rebuild-${name}`, r) }),
      });
      if (r.ok) rebuilt.push(name);
    }
    // the stacks' test runners that say why a run failed (an adapter's testReporter)
    const reporters = (ctx.runtime.capabilities ?? new CapabilityRegistry())
      .list()
      .map((adapter) => adapter.testReporter?.())
      .filter((r) => r !== undefined);
    const reportingRunnerOf = (command: string) => {
      for (const reporter of reporters) {
        const found = reporter.runnerOf(command, workspace);
        if (found) return { ...found, reporter };
      }
      return undefined;
    };
    // the tests that cover the change (project graph), asked once and only by a runner that takes classes
    let coveringOnce: Promise<string[] | undefined> | undefined;
    const covering = () => {
      coveringOnce ??= coveringTests({
        workspace,
        store: ctx.runtime.graph,
        extractors: (ctx.runtime.capabilities ?? new CapabilityRegistry())
          .list()
          .map((adapter) => adapter.graphExtractor?.())
          .filter((e) => e !== undefined),
        changed: changed.filter((f) => CODE_FILE.test(f)),
      }).catch(() => undefined);
      return coveringOnce;
    };
    // the checks side by side, each in its own lane: Gradle and Maven share one (their daemon and
    // build directory lock each other out), the rest run at once; the document keeps the config's order
    type CheckResult = (typeof results)[number];
    const one = async (name: string, command: string, out: CheckResult[]): Promise<void> => {
      if (!/^(test|typecheck|lint)/.test(name)) return;
      const dir = packageDirOf(command);
      const inScope = dir ? changed.filter((f) => f === dir || f.startsWith(`${dir}/`)) : changed;
      const code = inScope.filter((f) => CODE_FILE.test(f));
      // a package that reads what was rebuilt: its types may break with no file of its own changed
      if (code.length === 0 && name.startsWith("typecheck") && rebuilt.length > 0) {
        const r = await ctx.tools.invoke(`project.${name}`, {});
        out.push({
          check: name,
          command,
          ok: r.ok,
          ...(r.ok ? {} : { tail: tail(r), ...logOf(name, r) }),
        });
        return;
      }
      if (code.length === 0) {
        out.push({ check: name, command, ok: true, skipped: "no changed code in its scope" });
        return;
      }
      const present = code.filter((f) => existsSync(join(workspace, f)));
      // a JavaScript runner writes a JSON report besides its usual output: why the tests failed
      const js = name.startsWith("test") ? reportingRunnerOf(command) : undefined;
      const runner = name.startsWith("test") ? testRunnerOf(command) : undefined;
      // a runner the stack's adapter can narrow (behind a package script too): the changed files, or
      // the test files that cover them (project graph) as its filters
      const narrow = runner ? undefined : js?.reporter.selection?.(js.runner);
      const byTests =
        narrow?.by === "tests"
          ? fileSelection((await covering())?.filter((t) => !dir || t.startsWith(`${dir}/`)))
          : undefined;
      if (byTests && "skip" in byTests) {
        out.push({ check: name, command, ok: true, skipped: byTests.skip });
        return;
      }
      // a class-taking runner: the test classes that cover the change, from the project graph
      const selection =
        runner === "gradle" || runner === "maven"
          ? classSelection(
              runner,
              (await covering())?.filter((t) => !dir || t.startsWith(`${dir}/`)),
            )
          : undefined;
      if (selection && "skip" in selection) {
        out.push({ check: name, command, ok: true, skipped: selection.skip });
        return;
      }
      const related =
        selection && "args" in selection
          ? ` ${selection.args}`
          : byTests && "files" in byTests && narrow
            ? ` ${narrow.args(filesFor(command, byTests.files))}`
            : narrow?.by === "changed"
              ? ` ${narrow.args(filesFor(command, code))}`
              : runner === "jest"
                ? // no test relates to the changed files: not a failure (pilot: jest exited 1 on «0 matches»)
                  ` --passWithNoTests --findRelatedTests ${filesFor(command, code)}`
                : // the linter on the changed files only: errors elsewhere in the repo are not this run's
                  // (pilot: `yarn lint` failed on a package the run never touched, and agents could not tell)
                  name.startsWith("lint") && present.length > 0
                  ? ` ${filesFor(command, present)}`
                  : "";
      if (name.startsWith("lint") && present.length === 0) {
        out.push({
          check: name,
          command,
          ok: true,
          skipped: "the changed code in its scope was deleted",
        });
        return;
      }
      const started = Date.now() - 1000;
      const reportFile = js
        ? join(tmpdir(), `jarvis-${ctx.run.id}-${name.replace(/[^\w.-]+/g, "-")}-${Date.now()}.json`)
        : undefined;
      const argsWith = (extra: string) => {
        const all = [related.trim(), extra].filter(Boolean).join(" ");
        return all && js?.dashDash && !/(^|\s)--(\s|$)/.test(command) ? `-- ${all}` : all;
      };
      const firstArgs = argsWith(js && reportFile ? js.reporter.reporterArgs(js.runner, reportFile) : "");
      let r = await ctx.tools.invoke(`project.${name}`, firstArgs ? { args: firstArgs } : {});
      // a runner that does not know the reporter's options: once more as the command was
      if (
        js &&
        reportFile &&
        !r.ok &&
        !existsSync(reportFile) &&
        js.reporter.unknownOption.test(r.text ?? "")
      ) {
        const args = argsWith("");
        r = await ctx.tools.invoke(`project.${name}`, args ? { args } : {});
      }
      const jsReport =
        js && !r.ok ? js.reporter.failures(js.runner, reportFile, r.text ?? "", workspace) : undefined;
      const wroteReport = reportFile ? existsSync(reportFile) : false;
      if (reportFile) rmSync(reportFile, { force: true });
      // failing tests that fail on the base commit too are not this run's defects
      // why the tests failed, from the reports the runner wrote
      const report =
        !r.ok && (runner === "gradle" || runner === "maven")
          ? junitTestFailures(workspace, started)
          : jsReport;
      const preexisting =
        !r.ok && (runner === "gradle" || runner === "maven")
          ? await preexistingOf(ctx, runner, command, junitFailures(workspace, started))
          : undefined;
      const excused = new Set(preexisting?.classes ?? []);
      const failures = (report?.failures ?? [])
        .map((f) => (f.suite && excused.has(f.suite) ? { ...f, preexisting: true } : f))
        .slice(0, MAX_FAILURES);
      // no report at all from a runner that writes one: no test ran
      const notStarted =
        !r.ok &&
        !preexisting?.excused &&
        (((runner === "gradle" || runner === "maven") && report === undefined) ||
          (js !== undefined && reportFile !== undefined && !wroteReport));
      out.push({
        check: name,
        // as it ran: an npm script gets its runner's arguments after `--`
        command: ((a) => (a ? `${command} ${a}` : command))(argsWith("")),
        ok: r.ok || preexisting?.excused === true,
        ...(r.ok || preexisting?.excused ? {} : { tail: tail(r), ...logOf(name, r) }),
        ...(notStarted ? { notStarted: true } : {}),
        ...(!r.ok && !preexisting?.excused && failures.length === 0
          ? { excerpt: excerptText(r.text ?? r.denied ?? "") }
          : {}),
        ...(preexisting && preexisting.classes.length > 0 ? { preexisting: preexisting.classes } : {}),
        ...(failures.length > 0 && !(r.ok || preexisting?.excused)
          ? {
              failures,
              tests: {
                failed: report?.failures.length ?? failures.length,
                ...(report?.total ? { total: report.total } : {}),
              },
            }
          : {}),
      });
    };
    const checks = Object.entries(tools.local).filter(([name]) => /^(test|typecheck|lint)/.test(name));
    const found = checks.map((): CheckResult[] => []);
    const lanes = new Map<string, Array<() => Promise<void>>>();
    for (const [i, [name, command]] of checks.entries()) {
      const jvm = testRunnerOf(command);
      const lane = jvm === "gradle" || jvm === "maven" ? "jvm" : name;
      lanes.set(lane, [...(lanes.get(lane) ?? []), () => one(name, command, found[i] as CheckResult[])]);
    }
    await Promise.all(
      [...lanes.values()].map(async (lane) => {
        for (const work of lane) await work();
      }),
    );
    results.push(...found.flat());
    // tools.checks: a command of its own when the run changed what it checks
    for (const { run } of rulesFor(tools.checks, changed)) {
      if (results.some((r) => r.check === run)) continue;
      const command = tools.local[run];
      if (!command) {
        results.push({ check: run, command: run, ok: false, tail: `no tools.local command "${run}"` });
        continue;
      }
      const r = await ctx.tools.invoke(`project.${run}`, {});
      results.push({
        check: run,
        command,
        ok: r.ok,
        ...(r.ok ? {} : { tail: tail(r), excerpt: excerptText(r.text ?? r.denied ?? ""), ...logOf(run, r) }),
      });
    }
    // the repository's own hooks, as a person's commit and push would meet them (src/app/repoHooks.ts)
    if (ctx.runtime.loaded.config.delivery.hooks) results.push(...(await hookChecks(ctx, changed)));
    // failed tests placed in the project: their frames in its files, the lines the run changed
    if (results.some((r) => r.failures && r.failures.length > 0)) {
      const tracked = await git(["ls-files", "--cached", "--others", "--exclude-standard"], workspace);
      const files = tracked.stdout.split("\n").filter(Boolean);
      const diff = await git(["diff", "-U0", "--no-color", base, "--"], workspace);
      const lines = changedLinesOf(diff.stdout);
      for (const r of results)
        if (r.failures) r.failures = r.failures.map((f) => placeFailure(f, files, lines) as never);
    }
    // commit-msg only warns here: the message is the team's format, not the code
    const failed = results.filter((r) => !r.ok && !r.advisory);
    const reasons = failed.flatMap((r) => {
      const placed = (r.failures ?? []) as unknown as PlacedFailure[];
      const own = placed.length > 0 ? failureReasons(r.check, placed) : [];
      return own.length > 0
        ? own
        : [
            {
              kind: "defects_found",
              // what broke, from the whole output — not the runner's last summary lines
              summary: `${r.check} failed${r.notStarted ? " before any test ran (the build or the environment)" : ""}:\n${r.excerpt ?? (r.tail ?? "").split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 400)}`,
              sourceRefs: [`check:${r.check}`],
            },
          ];
    });
    const artifact = ctx.runtime.artifacts.put({
      runId: ctx.run.id,
      type: "checks",
      name: "checks.json",
      content: JSON.stringify({ changed, results, reasons }, null, 2),
      mediaType: "application/json",
      provenance: { kind: "tool", capability: "project.checks" },
      stepId: ctx.step.id,
      iteration: ctx.iteration,
    });
    const outputs = [`${artifact.artifactId}@${artifact.version}`];
    if (failed.length === 0) return { status: "success", outputs };
    return {
      status: "success",
      outcome: "defects_found",
      outputs,
      reason: reasons.map((r) => r.summary).join("; "),
    };
  },
};
