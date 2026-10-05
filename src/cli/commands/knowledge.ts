import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { createRuntime, type Runtime } from "../../app/runtime.ts";
import { effectiveStacks } from "../../capabilities/detector.ts";
import { resolveActor } from "../../core/actor/resolve.ts";
import type { ArtifactVersion } from "../../core/domain/artifact.ts";
import { changedFiles, checkStandards } from "../../knowledge/check.ts";
import { resolvePackage } from "../../knowledge/resolver.ts";
import { loadSkills } from "../../knowledge/skills.ts";
import { knowledgeRootsOf } from "../../knowledge/sources.ts";
import { loadStandards } from "../../knowledge/standards.ts";
import { shortRunId } from "../../storage/runStore.ts";
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
    ctx.out.line(`${padEnd("id", w)}  v  ${padEnd("severity", 11)}  ${padEnd("verification", 13)}  scope`);
    for (const s of standards) {
      const scope = [
        s.scope.stacks.length > 0 ? `stacks ${s.scope.stacks.join(",")}` : "",
        s.scope.paths.length > 0 ? `paths ${s.scope.paths.join(",")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      ctx.out.line(
        `${padEnd(s.id, w)}  ${s.version}  ${padEnd(s.severity, 11)}  ${padEnd(s.verification.kind, 13)}  ${scope || "any"}${s.level === "user" ? "  (user)" : ""}`,
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
    ctx.out.line(
      `${report.files.length} file(s), ${report.checked.length} deterministic standard(s) checked`,
    );
    for (const v of report.violations) {
      ctx.out.line(
        `${v.severity === "required" ? "FAIL" : "warn"}  ${v.standardId}@${v.version}  ${v.file ?? ""}${v.line ? `:${v.line}` : ""}  ${v.detail.split("\n")[0]}`,
      );
    }
    for (const s of report.skipped) ctx.out.line(`skip  ${s.standard}  ${s.reason}`);
    if (report.violations.length === 0) ctx.out.line("no violations");
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
        ctx.out.line(
          `${selected.has(s.id) ? "*" : " "} ${padEnd(s.id, w)}  v${s.version}  ${padEnd(s.level, 8)}  ${applies}`,
        );
      }
      ctx.out.line(
        `* = selected for a generic change in this project (max ${loaded.config.knowledge.maxSkills})`,
      );
    },
  );
}

interface CandidateDoc {
  kind: "knowledge" | "standard" | "skill-improvement";
  title: string;
  rationale: string;
  evidence?: string[];
  proposal?: string;
  paths?: string[];
  from?: string;
  status?: string;
}

function candidatesOf(
  runtime: Runtime,
): Array<{ artifact: ArtifactVersion; doc: CandidateDoc; decision?: string }> {
  const out: Array<{ artifact: ArtifactVersion; doc: CandidateDoc; decision?: string }> = [];
  for (const run of runtime.runs.list({ includeTerminal: true })) {
    for (const artifact of runtime.artifacts.listLatest(run.id, "candidate")) {
      try {
        const doc = JSON.parse(runtime.artifacts.text(artifact)) as CandidateDoc;
        const decision = runtime.artifacts.approvalsFor(artifact.artifactId, artifact.version)[0]?.decision;
        out.push({ artifact, doc, ...(decision ? { decision } : {}) });
      } catch {
        // not a candidate document
      }
    }
  }
  return out;
}

/** `jarvis candidates list` */
export async function runCandidatesList(ctx: CliContext, options: { all?: boolean }): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const rows = candidatesOf(runtime)
      .filter((c) => options.all || !c.decision)
      .map((c) => ({
        id: c.artifact.artifactId,
        version: c.artifact.version,
        run: shortRunId(c.artifact.runId),
        kind: c.doc.kind,
        title: c.doc.title,
        rationale: c.doc.rationale,
        evidence: c.doc.evidence ?? [],
        decision: c.decision ?? "open",
      }));
    ctx.out.result({ candidates: rows }, () => {
      if (rows.length === 0) {
        ctx.out.line("no open candidates");
        return;
      }
      for (const r of rows) {
        ctx.out.line(`${r.id}  ${padEnd(r.kind, 17)}  ${padEnd(r.decision, 8)}  run ${r.run}  ${r.title}`);
        ctx.out.line(`${" ".repeat(r.id.length)}  ${r.rationale}`);
        if (r.evidence.length > 0)
          ctx.out.line(`${" ".repeat(r.id.length)}  evidence: ${r.evidence.join(", ")}`);
      }
    });
  } finally {
    await runtime.close();
  }
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * `jarvis candidates promote <artifactId> [--id <id>]` — writes the standard / knowledge file into the
 * project (to be committed through the usual review) and records the human decision (ADR-0020 §6).
 */
export async function runCandidatesPromote(
  ctx: CliContext,
  artifactId: string,
  options: { id?: string },
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const found = candidatesOf(runtime).find(
      (c) => c.artifact.artifactId === artifactId || c.artifact.artifactId.startsWith(artifactId),
    );
    if (!found) {
      ctx.out.error(`candidate "${artifactId}" not found (see \`jarvis candidates list\`)`);
      throw new CliExit(EXIT.error);
    }
    const resolved = await resolveActor(loaded.config, ctx.env, loaded.project?.root);
    if (!resolved.actor) {
      ctx.out.error("cannot determine the actor (ADR-0006)");
      throw new CliExit(EXIT.error);
    }
    const root = loaded.project?.root ?? ctx.cwd;
    const { doc, artifact } = found;
    const id = options.id ?? slug(doc.title);
    let file: string;
    if (doc.kind === "standard") {
      file = join(root, ".jarvis", "standards", `${id}.md`);
      const front = stringify({
        id,
        version: 1,
        title: doc.title,
        severity: "recommended",
        verification: { kind: "semantic" },
        source: { kind: "candidate", ref: `${artifact.artifactId}@${artifact.version}` },
        tags: [],
      });
      writeIfAbsent(ctx, file, `---\n${front}---\n${doc.proposal ?? doc.rationale}\n`);
    } else if (doc.kind === "knowledge") {
      file = join(root, ".jarvis", "knowledge", `${id}.md`);
      const source = `${artifact.artifactId}@${artifact.version}`;
      if (doc.proposal?.startsWith("---\n")) {
        // a ready document (agent-mapped module): keep its front matter, record where it came from
        writeIfAbsent(ctx, file, doc.proposal.replace(/^---\n/, `---\nsource: ${source}\n`));
      } else {
        const front = stringify({ tags: [], ...(doc.paths ? { paths: doc.paths } : {}), source });
        writeIfAbsent(ctx, file, `---\n${front}---\n# ${doc.title}\n\n${doc.proposal ?? doc.rationale}\n`);
      }
    } else {
      file = join(root, ".jarvis", "skills", id, "IMPROVEMENT.md");
      writeIfAbsent(ctx, file, `# ${doc.title}\n\n${doc.rationale}\n\n${doc.proposal ?? ""}\n`);
    }
    runtime.artifacts.approve({
      runId: artifact.runId,
      stepId: artifact.stepId ?? "candidates",
      artifactId: artifact.artifactId,
      version: artifact.version,
      actor: resolved.actor,
      decision: "approve",
      comment: `promoted to ${file}`,
    });
    ctx.out.result({ promoted: artifact.artifactId, file }, () =>
      ctx.out.line(`promoted ${doc.kind} "${doc.title}" → ${file}; review and commit it with the repository`),
    );
  } finally {
    await runtime.close();
  }
}

function writeIfAbsent(ctx: CliContext, file: string, content: string): void {
  if (existsSync(file)) {
    ctx.out.error(`${file} already exists; pass --id to choose another name`);
    throw new CliExit(EXIT.error);
  }
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

/** `jarvis candidates reject <artifactId> [--comment]` */
export async function runCandidatesReject(
  ctx: CliContext,
  artifactId: string,
  options: { comment?: string },
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const found = candidatesOf(runtime).find(
      (c) => c.artifact.artifactId === artifactId || c.artifact.artifactId.startsWith(artifactId),
    );
    if (!found) {
      ctx.out.error(`candidate "${artifactId}" not found`);
      throw new CliExit(EXIT.error);
    }
    const resolved = await resolveActor(loaded.config, ctx.env, loaded.project?.root);
    if (!resolved.actor) throw new CliExit(EXIT.error, "cannot determine the actor");
    runtime.artifacts.approve({
      runId: found.artifact.runId,
      stepId: found.artifact.stepId ?? "candidates",
      artifactId: found.artifact.artifactId,
      version: found.artifact.version,
      actor: resolved.actor,
      decision: "reject",
      ...(options.comment ? { comment: options.comment } : {}),
    });
    ctx.out.result({ rejected: found.artifact.artifactId }, () =>
      ctx.out.line(`rejected ${found.artifact.artifactId}`),
    );
  } finally {
    await runtime.close();
  }
}
