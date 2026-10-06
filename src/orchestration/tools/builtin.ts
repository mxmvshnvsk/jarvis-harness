import { CapabilityRegistry } from "../../capabilities/registry.ts";
import { changedFiles, checkStandards } from "../../knowledge/check.ts";
import { repoIdOf, updateGraph } from "../../knowledge/graph/update.ts";
import { loadStandards } from "../../knowledge/standards.ts";
import type { DeterministicTool } from "../executors.ts";

/**
 * Deterministic tools that need nothing but the stores. Repository, git, test and typecheck
 * tools arrive with the Tool Platform (stage 4).
 */
export const BUILTIN_TOOLS: Record<string, DeterministicTool> = {
  noop: async () => ({ status: "success" }),

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
