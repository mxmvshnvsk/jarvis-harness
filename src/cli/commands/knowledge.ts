import { effectiveStacks } from "../../capabilities/detector.ts";
import { changedFiles, checkStandards } from "../../knowledge/check.ts";
import { resolvePackage } from "../../knowledge/resolver.ts";
import { loadSkills } from "../../knowledge/skills.ts";
import { knowledgeRootsOf } from "../../knowledge/sources.ts";
import { loadStandards } from "../../knowledge/standards.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT, padEnd } from "../output.ts";
import { loadForCli } from "./config.ts";

function rootsOf(loaded: Awaited<ReturnType<typeof loadForCli>>, cwd: string) {
  return knowledgeRootsOf(loaded, loaded.project?.root ?? cwd);
}

/** `jarvis standards list` */
export async function runStandardsList(ctx: CliContext): Promise<void> {
  const loaded = await loadForCli(ctx);
  const standards = loadStandards(rootsOf(loaded, ctx.cwd));
  ctx.out.result({ standards }, () => {
    if (standards.length === 0) {
      ctx.out.line("no standards (.jarvis/standards/<id>.md, ADR-0020 §1)");
      return;
    }
    const w = Math.max(...standards.map((s) => s.id.length), 2);
    const st = ctx.out.style;
    ctx.out.line(
      st.heading(`${padEnd("id", w)}  v  ${padEnd("severity", 11)}  ${padEnd("verification", 13)}  scope`),
    );
    for (const s of standards) {
      const scope = [
        s.scope.stacks.length > 0 ? `stacks ${s.scope.stacks.join(",")}` : "",
        s.scope.paths.length > 0 ? `paths ${s.scope.paths.join(",")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      ctx.out.line(
        `${st.name(padEnd(s.id, w))}  ${s.version}  ${s.severity === "required" ? padEnd(s.severity, 11) : st.muted(padEnd(s.severity, 11))}  ${padEnd(s.verification.kind, 13)}  ${st.muted(`${scope || "any"}${s.level === "user" ? "  (user)" : ""}`)}`,
      );
      ctx.out.line(`${" ".repeat(w)}  ${s.title}`);
    }
  });
}

/** `jarvis standards check [--base <ref>]` — deterministic checks against the current checkout. */
export async function runStandardsCheck(ctx: CliContext, options: { base?: string }): Promise<void> {
  const loaded = await loadForCli(ctx);
  const root = loaded.project?.root ?? ctx.cwd;
  const standards = loadStandards(rootsOf(loaded, ctx.cwd));
  const base = options.base ?? "HEAD";
  const files = await changedFiles(root, base);
  const report = await checkStandards({ standards, workspace: root, files, baseRef: base });
  const required = report.violations.filter((v) => v.severity === "required");
  ctx.out.result(report, () => {
    const st = ctx.out.style;
    ctx.out.line(
      st.muted(`${report.files.length} file(s), ${report.checked.length} deterministic standard(s) checked`),
    );
    for (const v of report.violations) {
      ctx.out.line(
        `${v.severity === "required" ? st.bad("FAIL") : st.warn("warn")}  ${st.name(`${v.standardId}@${v.version}`)}  ${v.file ?? ""}${v.line ? st.muted(`:${v.line}`) : ""}  ${v.detail.split("\n")[0]}`,
      );
    }
    for (const s of report.skipped) ctx.out.line(st.muted(`skip  ${s.standard}  ${s.reason}`));
    if (report.violations.length === 0) ctx.out.line(`${st.ok("✓")} no violations`);
  });
  if (required.length > 0) throw new CliExit(EXIT.error);
}

/** `jarvis skills list [--agent <id>]` — skills and which would be selected for the project. */
export async function runSkillsList(ctx: CliContext, options: { agent?: string }): Promise<void> {
  const loaded = await loadForCli(ctx);
  const roots = rootsOf(loaded, ctx.cwd);
  const skills = loadSkills(roots);
  const stacks = effectiveStacks(loaded.config.stack, roots.projectRoot);
  const pkg = resolvePackage({
    roots,
    config: loaded.config.knowledge,
    task: { kind: "change", affectedPaths: [], stacks, agentId: options.agent ?? "implementation" },
  });
  const selected = new Set(pkg.skills.map((s) => s.id));
  ctx.out.result(
    { stacks, skills, selected: [...selected], standards: pkg.standards.map((s) => s.id) },
    () => {
      ctx.out.line(
        `stacks: ${stacks.join(", ") || "(none detected)"}; agent: ${options.agent ?? "implementation"}`,
      );
      const w = Math.max(...skills.map((s) => s.id.length), 2);
      for (const s of skills) {
        const applies = [
          s.appliesTo.stacks.length > 0 ? `stacks ${s.appliesTo.stacks.join(",")}` : "",
          s.appliesTo.kinds.length > 0 ? `kinds ${s.appliesTo.kinds.join(",")}` : "",
          s.appliesTo.paths.length > 0 ? `paths ${s.appliesTo.paths.join(",")}` : "",
          `agents ${s.appliesTo.agents.join(",") || "implementation"}`,
        ]
          .filter(Boolean)
          .join("; ");
        const st = ctx.out.style;
        ctx.out.line(
          `${selected.has(s.id) ? st.ok("*") : " "} ${selected.has(s.id) ? st.name(padEnd(s.id, w)) : padEnd(s.id, w)}  ${st.muted(`v${s.version}`)}  ${st.muted(padEnd(s.level, 8))}  ${st.muted(applies)}`,
        );
      }
      ctx.out.line(
        `* = selected for a generic change in this project (max ${loaded.config.knowledge.maxSkills})`,
      );
    },
  );
}
