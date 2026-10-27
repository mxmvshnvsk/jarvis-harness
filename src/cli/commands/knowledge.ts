import { existsSync } from "node:fs";
import { detectStacks, effectiveStacks } from "../../capabilities/detector.ts";
import { changedFiles, checkStandards } from "../../knowledge/check.ts";
import { knowledgeProblems } from "../../knowledge/problems.ts";
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

type Loaded = Awaited<ReturnType<typeof loadForCli>>;

/**
 * `--service <name>` in a knowledge repository: that service's repository and stacks, to show what it
 * gets of the shared standards and skills. Undefined without the option.
 */
function serviceOf(
  ctx: CliContext,
  loaded: Loaded,
  name: string | undefined,
): { name: string; repo: string; stacks: string[] } | undefined {
  if (!name) return undefined;
  const repo = loaded.meta?.repos[name];
  if (!repo) {
    ctx.out.error(
      `${name} is not a service of the knowledge repository's map${loaded.meta ? ` (${Object.keys(loaded.meta.repos).sort().join(", ")})` : " (run it in the knowledge repository)"}`,
    );
    throw new CliExit(EXIT.error);
  }
  if (!existsSync(repo)) {
    ctx.out.error(`${name}: no repository at ${repo} — its stack is unknown here`);
    throw new CliExit(EXIT.error);
  }
  return { name, repo, stacks: detectStacks(repo) };
}

/**
 * In a knowledge repository of many services, a standard or skill that names no stack and lies in no
 * folder with a `_scope.yaml` reaches every service — the frontend got the Java rules (pilot).
 */
export function unscopedShared(
  loaded: Loaded,
  items: ReadonlyArray<{
    id: string;
    level: string;
    stacks: readonly string[];
    folderScoped?: boolean | undefined;
  }>,
): string[] {
  if (!loaded.meta || Object.keys(loaded.meta.repos).length < 2) return [];
  return items
    .filter((i) => i.level === "project" && i.stacks.length === 0 && !i.folderScoped)
    .map((i) => i.id);
}

const UNSCOPED_HINT =
  "reach every service of the map whatever its stack: put them in a folder with _scope.yaml ({ stacks: [java] }), or in common/ with an empty one to mean «everyone»";

const appliesToStacks = (stacks: readonly string[], have: readonly string[]) =>
  stacks.length === 0 || stacks.some((s) => have.includes(s));

/** `jarvis standards list [--service <name>]` */
export async function runStandardsList(ctx: CliContext, options: { service?: string } = {}): Promise<void> {
  const loaded = await loadForCli(ctx);
  const service = serviceOf(ctx, loaded, options.service);
  const all = loadStandards(rootsOf(loaded, ctx.cwd));
  const standards = service ? all.filter((s) => appliesToStacks(s.scope.stacks, service.stacks)) : all;
  const problems = knowledgeProblems();
  const unscoped = unscopedShared(
    loaded,
    all.map((s) => ({ id: s.id, level: s.level, stacks: s.scope.stacks, folderScoped: s.folderScoped })),
  );
  ctx.out.result(
    {
      standards,
      ...(service ? { service } : {}),
      ...(unscoped.length > 0 ? { unscoped } : {}),
      ...(problems.length > 0 ? { problems } : {}),
    },
    () => {
      for (const p of problems)
        ctx.out.line(`${ctx.out.style.warn("passed over:")} ${p.file} — ${p.message}`);
      if (service)
        ctx.out.line(
          `${service.name} (stacks: ${service.stacks.join(", ") || "none detected"}) gets ${standards.length} of ${all.length} standard(s)`,
        );
      if (unscoped.length > 0)
        ctx.out.line(
          `${ctx.out.style.warn(`${unscoped.length} standard(s) name no stack`)} (${unscoped.slice(0, 6).join(", ")}${unscoped.length > 6 ? ", …" : ""}) — ${UNSCOPED_HINT}`,
        );
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
          s.group ? `in ${s.group}/` : "",
        ]
          .filter(Boolean)
          .join("; ");
        ctx.out.line(
          `${st.name(padEnd(s.id, w))}  ${s.version}  ${s.severity === "required" ? padEnd(s.severity, 11) : st.muted(padEnd(s.severity, 11))}  ${padEnd(s.verification.kind, 13)}  ${st.muted(`${scope || "any"}${s.level === "user" ? "  (user)" : ""}`)}`,
        );
        ctx.out.line(`${" ".repeat(w)}  ${s.title}`);
      }
    },
  );
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

/** `jarvis skills list [--agent <id>] [--service <name>]` — skills and which would be selected. */
export async function runSkillsList(
  ctx: CliContext,
  options: { agent?: string; service?: string },
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const service = serviceOf(ctx, loaded, options.service);
  const roots = service ? knowledgeRootsOf(loaded, service.repo) : rootsOf(loaded, ctx.cwd);
  const skills = loadSkills(roots);
  const stacks = service ? service.stacks : effectiveStacks(loaded.config.stack, roots.projectRoot);
  const unscoped = unscopedShared(
    loaded,
    skills.map((s) => ({
      id: s.id,
      level: s.level,
      stacks: s.appliesTo.stacks,
      folderScoped: s.folderScoped,
    })),
  );
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
        `${service ? `${service.name} — ` : ""}stacks: ${stacks.join(", ") || "(none detected)"}; agent: ${options.agent ?? "implementation"}`,
      );
      if (unscoped.length > 0)
        ctx.out.line(
          `${ctx.out.style.warn(`${unscoped.length} skill(s) name no stack`)} (${unscoped.slice(0, 6).join(", ")}${unscoped.length > 6 ? ", …" : ""}) — ${UNSCOPED_HINT}`,
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
