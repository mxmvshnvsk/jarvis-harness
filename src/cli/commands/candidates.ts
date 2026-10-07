import {
  type Candidate,
  CandidateTargetTaken,
  candidatesOf,
  documentOf,
  promoteCandidate,
  rejectCandidate,
  targetOf,
} from "../../app/candidates.ts";
import { createRuntime } from "../../app/runtime.ts";
import { resolveActor } from "../../core/actor/resolve.ts";
import { shortRunId } from "../../storage/runStore.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT } from "../output.ts";
import { renderMarkdown } from "../render.ts";
import { loadForCli } from "./config.ts";

/**
 * `jarvis candidates list|show|promote|reject` (ADR-0020 §6): the terminal over src/app/candidates.ts,
 * which the Modules page of `jarvis ui` uses too. Every command accepts a candidate's name (or any
 * unique part of it, or the artifact id).
 */
export { candidatesOf, nameOf } from "../../app/candidates.ts";

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

/**
 * `jarvis candidates promote <name> [--id <id>] [--replace]` — writes the standard / knowledge file
 * into the project (to be committed through the usual review) and records the human decision
 * (ADR-0020 §6). A file jarvis generated is replaced; one a person wrote only with `--replace`.
 */
export async function runCandidatesPromote(
  ctx: CliContext,
  ref: string,
  options: { id?: string; replace?: boolean },
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
    let promoted: ReturnType<typeof promoteCandidate>;
    try {
      promoted = promoteCandidate(runtime, {
        root,
        candidate: found,
        actor: resolved.actor,
        id: options.id,
        replace: options.replace,
        channel: "cli",
      });
    } catch (error) {
      if (!(error instanceof CandidateTargetTaken)) throw error;
      ctx.out.error(
        `${error.file} already exists and was written by a person; --replace replaces it, --id <id> writes another file`,
      );
      throw new CliExit(EXIT.error);
    }
    const { file } = promoted;
    ctx.out.result(
      {
        promoted: found.artifact.artifactId,
        name: found.name,
        file,
        ...(promoted.replaced ? { replaced: promoted.replaced } : {}),
      },
      () => {
        const st = ctx.out.style;
        ctx.out.line(`${st.ok("✓")} promoted ${st.name(found.name)} ${st.muted("→")} ${file}`);
        if (promoted.replaced)
          ctx.out.line(
            st.muted(
              `  replaced the document ${promoted.replaced === "generated" ? "jarvis generated there" : "a person wrote there"}`,
            ),
          );
        if (found.review.length > 0)
          ctx.out.line(
            `  ${st.warn(`${found.review.length} generalisation${found.review.length === 1 ? "" : "s"} still to check there`)}; edit the file freely, it is yours now`,
          );
        ctx.out.line(st.muted("  review and commit it with the repository"));
      },
    );
  } finally {
    await runtime.close();
  }
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
    rejectCandidate(runtime, found, resolved.actor, options.comment);
    ctx.out.result({ rejected: found.artifact.artifactId, name: found.name }, () =>
      ctx.out.line(`${ctx.out.style.bad("✗")} rejected ${ctx.out.style.name(found.name)}`),
    );
  } finally {
    await runtime.close();
  }
}
