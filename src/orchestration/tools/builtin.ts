import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CapabilityRegistry } from "../../capabilities/registry.ts";
import { collectDesign } from "../../design/collect.ts";
import { changedFiles, checkStandards } from "../../knowledge/check.ts";
import { impactOf, repoIdOf, updateGraph } from "../../knowledge/graph/update.ts";
import { loadStandards } from "../../knowledge/standards.ts";
import type { DeterministicTool } from "../executors.ts";

/**
 * Deterministic tools that need nothing but the stores. Repository, git, test and typecheck
 * tools arrive with the Tool Platform (stage 4).
 */
/** What makes a change too big or too wide for an impact analysis without a model. */
export const QUICK_IMPACT = { maxFiles: 2, maxDependents: 15 } as const;
/** The spec talks about telemetry or documentation: the agent decides what of it is affected. */
const BEYOND_CODE =
  /\b(telemetry|metrics?|analytics|tracking|logging|events?|docs|documentation|readme|changelog)\b|метрик|аналитик|событи|документац/i;
const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|py|go|rs|java|kt|cs|rb|php|swift)$/;
const TEST_FILE = /(\.|_)(test|spec)\.[a-z]+$|(^|\/)(__tests__|tests?)\//;

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

export const BUILTIN_TOOLS: Record<string, DeterministicTool> = {
  noop: async () => ({ status: "success" }),

  /** The design frames of the task, read and described by code (src/design/collect.ts). */
  "design.collect": collectDesign,

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
    const caps = await registry.discover(ctx.runtime.loaded.config, ctx.workspace.ref.path);
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
   * changed file; jest runs only the tests related to the changed files (`--findRelatedTests`).
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
    const results: Array<{ check: string; command: string; ok: boolean; skipped?: string; tail?: string }> =
      [];
    for (const [name, command] of Object.entries(ctx.runtime.loaded.config.tools.local)) {
      if (!/^(test|typecheck)/.test(name)) continue;
      const dir = /^\s*cd\s+([^\s&;]+)\s*&&/.exec(command)?.[1]?.replace(/\/+$/, "");
      const inScope = dir ? changed.filter((f) => f === dir || f.startsWith(`${dir}/`)) : changed;
      const code = inScope.filter((f) => /\.(tsx?|jsx?|mjs|cjs)$/.test(f));
      if (code.length === 0) {
        results.push({ check: name, command, ok: true, skipped: "no changed code in its scope" });
        continue;
      }
      const related =
        name.startsWith("test") && /\bjest\b/.test(command)
          ? ` --findRelatedTests ${code.map((f) => (dir ? f.slice(dir.length + 1) : f)).join(" ")}`
          : "";
      const r = await ctx.tools.invoke(`project.${name}`, related ? { args: related.trim() } : {});
      results.push({
        check: name,
        command: `${command}${related}`,
        ok: r.ok,
        ...(r.ok ? {} : { tail: (r.text ?? r.denied ?? "").split("\n").slice(-40).join("\n") }),
      });
    }
    const failed = results.filter((r) => !r.ok);
    const reasons = failed.map((r) => ({
      kind: "defects_found",
      summary: `${r.check} failed: ${(r.tail ?? "").split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 400)}`,
      sourceRefs: [`check:${r.check}`],
    }));
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
