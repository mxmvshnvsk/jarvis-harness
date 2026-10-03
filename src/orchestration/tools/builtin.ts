import { CapabilityRegistry } from "../../capabilities/registry.ts";
import { changedFiles, checkStandards } from "../../knowledge/check.ts";
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
    const files = await changedFiles(workspace, ctx.workspace.ref.baseCommit ?? ctx.workspace.ref.baseRef);
    const report = await checkStandards({
      standards,
      workspace,
      files,
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
};
