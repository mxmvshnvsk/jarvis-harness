import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { createRuntime, type Runtime } from "../../app/runtime.ts";
import { resolveActor } from "../../core/actor/resolve.ts";
import type { ArtifactVersion } from "../../core/domain/artifact.ts";
import { markSweeping } from "../../onboarding/render.ts";
import { shortRunId } from "../../storage/runStore.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT } from "../output.ts";
import { renderMarkdown } from "../render.ts";
import { loadForCli } from "./config.ts";

/**
 * `jarvis candidates list|show|promote|reject` (ADR-0020 §6). Pilot: eight module maps waited as
 * `art_0f1e2d3c4b5a6978`-style rows with a wall of evidence; nobody could tell which was which or
 * what to read before promoting. A candidate now has a name taken from what it is about
 * (`shared-lib/billing`), every command accepts that name (or any unique part of it, or the
 * artifact id), and the list says where to look and what to check.
 */
interface CandidateDoc {
  kind: "knowledge" | "standard" | "skill-improvement";
  title: string;
  rationale: string;
  evidence?: string[];
  proposal?: string;
  paths?: string[];
  from?: string;
  status?: string;
  /** Agent-mapped module (onboard --module). */
  module?: string;
  claims?: { proposed: number; kept: number; dropped: number };
  /** Kept claims that generalise beyond their excerpts. */
  review?: string[];
}

export interface Candidate {
  readonly artifact: ArtifactVersion;
  readonly doc: CandidateDoc;
  readonly decision?: string;
  /** Human handle: unique within all candidates, stable while they exist. */
  readonly name: string;
  readonly claims?: { proposed: number; kept: number; dropped: number };
  readonly review: string[];
  /** Files the evidence quotes, most quoted first. */
  readonly files: string[];
}

/** `module packages/shared-lib/src/billing` → `shared-lib/billing`. */
export function nameOf(doc: Pick<CandidateDoc, "title" | "module" | "kind">): string {
  const module = doc.module ?? /^module\s+(.+)$/.exec(doc.title)?.[1];
  if (module) {
    const parts = module.split("/").filter((p) => p && p !== "src");
    if (parts[0] === "packages" || parts[0] === "apps" || parts[0] === "services" || parts[0] === "libs")
      parts.shift();
    return parts.join("/") || module;
  }
  return doc.title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Statements of a rendered module document that generalise (for candidates made before the marker). */
function reviewOf(doc: CandidateDoc): string[] {
  if (doc.review) return doc.review;
  return doc.proposal ? markSweeping(doc.proposal).sweeping : [];
}

/** The document `promote` writes: a module map gets the check markers it may predate. */
function documentOf(doc: CandidateDoc): string {
  const text = doc.proposal ?? doc.rationale;
  return doc.kind === "knowledge" && (doc.module || /^module\s/.test(doc.title))
    ? markSweeping(text).markdown
    : text;
}

function claimsOf(doc: CandidateDoc): Candidate["claims"] {
  if (doc.claims) return doc.claims;
  const m = /(\d+) of (\d+) claims were confirmed against the code, (\d+) dropped/.exec(doc.rationale);
  return m ? { kept: Number(m[1]), proposed: Number(m[2]), dropped: Number(m[3]) } : undefined;
}

function filesOf(doc: CandidateDoc): string[] {
  const counts = new Map<string, number>();
  for (const e of doc.evidence ?? []) {
    const file = e.replace(/:\d+$/, "");
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([f]) => f);
}

export function candidatesOf(runtime: Runtime): Candidate[] {
  const raw: Array<{ artifact: ArtifactVersion; doc: CandidateDoc; decision?: string }> = [];
  // oldest run first (the store lists the latest 100 by default; candidates outlive that)
  const runs = runtime.runs.list({ includeTerminal: true, limit: 100_000 }).reverse();
  for (const run of runs) {
    for (const artifact of runtime.artifacts.listLatest(run.id, "candidate")) {
      try {
        const doc = JSON.parse(runtime.artifacts.text(artifact)) as CandidateDoc;
        const decision = runtime.artifacts.approvalsFor(artifact.artifactId, artifact.version)[0]?.decision;
        raw.push({ artifact, doc, ...(decision ? { decision } : {}) });
      } catch {
        // not a candidate document
      }
    }
  }
  // newest first gets the plain name; an older one about the same thing is told apart by its run
  const order = raw
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.artifact.createdAt.localeCompare(a.c.artifact.createdAt) || b.i - a.i);
  // (equal timestamps: the later one in `raw` is the newer one)
  const names = new Map<number, string>();
  const taken = new Set<string>();
  for (const { c, i } of order) {
    let name = nameOf(c.doc);
    if (taken.has(name)) name = `${name}@${shortRunId(c.artifact.runId)}`;
    taken.add(name);
    names.set(i, name);
  }
  // listed oldest first: the newest lands next to the prompt
  return raw
    .map((c, i) => {
      const claims = claimsOf(c.doc);
      const name = names.get(i) ?? nameOf(c.doc);
      return { ...c, name, ...(claims ? { claims } : {}), review: reviewOf(c.doc), files: filesOf(c.doc) };
    })
    .sort((a, b) => a.artifact.createdAt.localeCompare(b.artifact.createdAt));
}

/** A candidate by name, unique part of a name, or artifact id (prefix). */
function find(ctx: CliContext, all: readonly Candidate[], ref: string): Candidate {
  const exact = all.find((c) => c.name === ref || c.artifact.artifactId === ref);
  if (exact) return exact;
  const matches = all.filter((c) => c.artifact.artifactId.startsWith(ref) || c.name.includes(ref));
  const open = matches.filter((c) => !c.decision);
  const pick = open.length === 1 ? open : matches;
  if (pick.length === 1) return pick[0] as Candidate;
  if (pick.length === 0) ctx.out.error(`no candidate "${ref}" (see \`jarvis candidates list\`)`);
  else ctx.out.error(`"${ref}" matches ${pick.length} candidates: ${pick.map((c) => c.name).join(", ")}`);
  throw new CliExit(EXIT.error);
}

function ago(iso: string, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function short(file: string): string {
  return file.split("/").slice(-2).join("/");
}

/** `jarvis candidates list [--all]` */
export async function runCandidatesList(ctx: CliContext, options: { all?: boolean }): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const all = candidatesOf(runtime);
    const shown = all.filter((c) => options.all || !c.decision);
    const rows = shown.map((c) => ({
      name: c.name,
      id: c.artifact.artifactId,
      version: c.artifact.version,
      run: shortRunId(c.artifact.runId),
      kind: c.doc.kind,
      title: c.doc.title,
      rationale: c.doc.rationale,
      paths: c.doc.paths ?? [],
      claims: c.claims,
      review: c.review,
      files: c.files,
      evidence: c.doc.evidence ?? [],
      decision: c.decision ?? "open",
      createdAt: c.artifact.createdAt,
    }));
    ctx.out.result({ candidates: rows }, () => {
      const st = ctx.out.style;
      if (rows.length === 0) {
        ctx.out.line(options.all ? "no candidates" : "no open candidates (--all shows decided ones)");
        return;
      }
      const open = rows.filter((r) => r.decision === "open").length;
      ctx.out.line(
        st.heading(
          `${rows.length} ${options.all ? "" : "open "}candidate${rows.length === 1 ? "" : "s"}${options.all ? `, ${open} open` : ""}`,
        ),
      );
      const label = (text: string) => st.muted(text.padEnd(9));
      for (const r of rows) {
        ctx.out.line();
        const status =
          r.decision === "open"
            ? ""
            : `  ${r.decision === "approve" ? st.ok("[promoted]") : st.bad("[rejected]")}`;
        ctx.out.line(`${st.muted("●")} ${st.name(r.name)}${status}`);
        ctx.out.line(`  ${st.muted(`${r.kind} · ${r.title} · run ${r.run} · ${ago(r.createdAt)}`)}`);
        if (r.claims) {
          const parts = [`${st.ok(`${r.claims.kept}/${r.claims.proposed}`)} confirmed`];
          if (r.claims.dropped) parts.push(`${st.bad(String(r.claims.dropped))} dropped`);
          if (r.review.length > 0) parts.push(st.warn(`${r.review.length} to check`));
          ctx.out.line(`  ${label("claims")} ${parts.join(st.muted(" · "))}`);
        } else ctx.out.line(`  ${label("why")} ${r.rationale}`);
        if (r.paths.length > 0) ctx.out.line(`  ${label("code")} ${r.paths.join(", ")}`);
        if (r.files.length > 0) {
          const more = r.files.length > 3 ? st.muted(` +${r.files.length - 3} more`) : "";
          ctx.out.line(`  ${label("evidence")} ${r.files.slice(0, 3).map(short).join(", ")}${more}`);
        }
        for (const s of r.review.slice(0, 3))
          ctx.out.line(`  ${st.warn("?")} ${s.length > 110 ? `${s.slice(0, 109)}…` : s}`);
        if (r.review.length > 3)
          ctx.out.line(
            `  ${st.warn("?")} ${st.muted(`… ${r.review.length - 3} more:`)} ${st.cmd(`jarvis candidates show ${r.name}`)}`,
          );
      }
      ctx.out.line();
      const hint = (what: string, cmd: string, note: string) =>
        ctx.out.line(`${st.muted(what.padEnd(8))} ${st.cmd(cmd.padEnd(36))} ${st.muted(note)}`);
      hint("read", "jarvis candidates show <name>", "the document as it would be written");
      hint("accept", "jarvis candidates promote <name>", "writes it into .jarvis/; edit it there freely");
      hint("decline", "jarvis candidates reject <name>", "[--comment …]");
      ctx.out.line(st.muted("<name>: any unique part of a name (`billing`) or the artifact id"));
    });
  } finally {
    await runtime.close();
  }
}

/** `jarvis candidates show <name>` — the document as `promote` would write it, with what to check. */
export async function runCandidatesShow(ctx: CliContext, ref: string): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const c = find(ctx, candidatesOf(runtime), ref);
    ctx.out.result(
      {
        name: c.name,
        id: c.artifact.artifactId,
        kind: c.doc.kind,
        title: c.doc.title,
        decision: c.decision ?? "open",
        claims: c.claims,
        review: c.review,
        files: c.files,
        target: targetOf(loaded.project?.root ?? ctx.cwd, c, undefined),
        proposal: documentOf(c.doc),
      },
      () => {
        const st = ctx.out.style;
        const state = c.decision
          ? c.decision === "approve"
            ? st.ok("promoted")
            : st.bad("rejected")
          : "open";
        ctx.out.line(`${st.name(c.name)}  ${st.muted(`${c.doc.kind} ·`)} ${state}`);
        ctx.out.line(st.muted(c.doc.rationale));
        ctx.out.line(
          `${st.muted("promote writes")} ${targetOf(loaded.project?.root ?? ctx.cwd, c, undefined)}`,
        );
        if (c.review.length > 0) {
          ctx.out.line();
          ctx.out.line(
            st.heading(
              `Check before promoting ${st.muted(`— ${c.review.length} generalisation${c.review.length === 1 ? "" : "s"} the quoted lines cannot prove`)}`,
            ),
          );
          for (const s of c.review) ctx.out.line(`  ${st.warn("?")} ${s}`);
        }
        ctx.out.line();
        ctx.out.line(st.muted("─".repeat(60)));
        ctx.out.raw(renderMarkdown(documentOf(c.doc).trimEnd(), st));
        ctx.out.line(st.muted("─".repeat(60)));
        ctx.out.line(`${st.muted("accept ")} ${st.cmd(`jarvis candidates promote ${c.name}`)}`);
        ctx.out.line(`${st.muted("decline")} ${st.cmd(`jarvis candidates reject ${c.name}`)}`);
      },
    );
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

/** Where `promote` writes, from the kind and the id (`--id`, or one derived from the name). */
function targetOf(root: string, c: Candidate, id: string | undefined): string {
  const fileId =
    id ??
    (c.doc.module || /^module\s/.test(c.doc.title)
      ? `module-${slug(c.name.replace(/@.*$/, ""))}`
      : slug(c.doc.title));
  if (c.doc.kind === "standard") return join(root, ".jarvis", "standards", `${fileId}.md`);
  if (c.doc.kind === "knowledge") return join(root, ".jarvis", "knowledge", `${fileId}.md`);
  return join(root, ".jarvis", "skills", fileId, "IMPROVEMENT.md");
}

/**
 * `jarvis candidates promote <name> [--id <id>]` — writes the standard / knowledge file into the
 * project (to be committed through the usual review) and records the human decision (ADR-0020 §6).
 */
export async function runCandidatesPromote(
  ctx: CliContext,
  ref: string,
  options: { id?: string },
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const found = find(ctx, candidatesOf(runtime), ref);
    const resolved = await resolveActor(loaded.config, ctx.env, loaded.project?.root);
    if (!resolved.actor) {
      ctx.out.error("cannot determine the actor (ADR-0006)");
      throw new CliExit(EXIT.error);
    }
    const root = loaded.project?.root ?? ctx.cwd;
    const { doc, artifact } = found;
    const file = targetOf(root, found, options.id);
    const id = file.replace(/^.*[\\/]/, "").replace(/\.md$/, "");
    if (doc.kind === "standard") {
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
      const source = `${artifact.artifactId}@${artifact.version}`;
      if (doc.proposal?.startsWith("---\n")) {
        // a ready document (agent-mapped module): keep its front matter, record where it came from
        writeIfAbsent(ctx, file, documentOf(doc).replace(/^---\n/, `---\nsource: ${source}\n`));
      } else {
        const front = stringify({ tags: [], ...(doc.paths ? { paths: doc.paths } : {}), source });
        writeIfAbsent(ctx, file, `---\n${front}---\n# ${doc.title}\n\n${doc.proposal ?? doc.rationale}\n`);
      }
    } else {
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
    ctx.out.result({ promoted: artifact.artifactId, name: found.name, file }, () => {
      const st = ctx.out.style;
      ctx.out.line(`${st.ok("✓")} promoted ${st.name(found.name)} ${st.muted("→")} ${file}`);
      if (found.review.length > 0)
        ctx.out.line(
          `  ${st.warn(`${found.review.length} generalisation${found.review.length === 1 ? "" : "s"} still to check there`)}; edit the file freely, it is yours now`,
        );
      ctx.out.line(st.muted("  review and commit it with the repository"));
    });
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

/** `jarvis candidates reject <name> [--comment]` */
export async function runCandidatesReject(
  ctx: CliContext,
  ref: string,
  options: { comment?: string },
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const found = find(ctx, candidatesOf(runtime), ref);
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
    ctx.out.result({ rejected: found.artifact.artifactId, name: found.name }, () =>
      ctx.out.line(`${ctx.out.style.bad("✗")} rejected ${ctx.out.style.name(found.name)}`),
    );
  } finally {
    await runtime.close();
  }
}
