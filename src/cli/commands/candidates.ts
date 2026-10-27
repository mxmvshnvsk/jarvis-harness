import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  addCandidate,
  type Candidate,
  type CandidateDoc,
  CandidateInvalid,
  CandidateNotPromotable,
  CandidateTargetTaken,
  candidatesOf,
  documentOf,
  promoteCandidate,
  rejectCandidate,
  skillEditOf,
  targetOf,
} from "../../app/candidates.ts";
import { createRuntime } from "../../app/runtime.ts";
import { resolveActor } from "../../core/actor/resolve.ts";
import { loadSkills } from "../../knowledge/skills.ts";
import { knowledgeRootsOf } from "../../knowledge/sources.ts";
import { shortRunId } from "../../storage/runStore.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT } from "../output.ts";
import { renderMarkdown } from "../render.ts";
import { loadForCli } from "./config.ts";

/**
 * `jarvis candidates add|list|show|promote|reject` (ADR-0020 §6): the terminal over src/app/candidates.ts,
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
    const root = loaded.project?.root ?? ctx.cwd;
    // a skill improvement is an edit of its skill: what the instructions get, from which version to which
    const skillEdit = (() => {
      if (c.doc.kind !== "skill-improvement") return undefined;
      try {
        return skillEditOf(root, c.doc);
      } catch (error) {
        if (error instanceof CandidateNotPromotable) return error;
        throw error;
      }
    })();
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
        ...(skillEdit instanceof CandidateNotPromotable
          ? { cannotPromote: skillEdit.message }
          : skillEdit
            ? {
                skill: {
                  id: skillEdit.skill,
                  from: skillEdit.version.from,
                  to: skillEdit.version.to,
                  fromBuiltin: skillEdit.fromBuiltin,
                },
              }
            : {}),
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
        if (skillEdit instanceof CandidateNotPromotable) ctx.out.line(st.bad(skillEdit.message));
        else if (skillEdit)
          ctx.out.line(
            `${st.muted("promote edits")} skill ${st.name(skillEdit.skill)} v${skillEdit.version.from} → v${skillEdit.version.to}: ${relative(root, skillEdit.instructions)}${skillEdit.fromBuiltin ? st.muted(" (a project copy of the built-in, which then overrides it)") : ""}`,
          );
        else ctx.out.line(`${st.muted("promote writes")} ${targetOf(root, c, undefined)}`);
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
        if (skillEdit && !(skillEdit instanceof CandidateNotPromotable)) {
          // the end of the instructions as they are, then what is added
          for (const l of skillEdit.before.trimEnd().split("\n").slice(-4)) ctx.out.line(st.muted(`  ${l}`));
          for (const l of skillEdit.after.slice(skillEdit.before.trimEnd().length).trim().split("\n"))
            ctx.out.line(st.ok(`+ ${l}`));
        } else ctx.out.raw(renderMarkdown(documentOf(c.doc).trimEnd(), st));
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
      if (error instanceof CandidateNotPromotable) {
        ctx.out.error(error.message);
        throw new CliExit(EXIT.error);
      }
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
        ...(promoted.renamedFrom ? { renamedFrom: promoted.renamedFrom } : {}),
      },
      () => {
        const st = ctx.out.style;
        ctx.out.line(`${st.ok("✓")} promoted ${st.name(found.name)} ${st.muted("→")} ${file}`);
        if (promoted.skill)
          ctx.out.line(
            st.muted(
              `  skill ${promoted.skill.id} v${promoted.skill.from} → v${promoted.skill.to}${promoted.skill.fromBuiltin ? " — a project copy of the built-in, which it overrides from now on" : ""}; agents get it from the next run`,
            ),
          );
        if (promoted.replaced)
          ctx.out.line(
            st.muted(
              `  replaced the document ${promoted.replaced === "generated" ? "jarvis generated there" : "a person wrote there"}${promoted.renamedFrom ? ` (${promoted.renamedFrom}, removed: the same module under its old name)` : ""}`,
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

const KINDS: readonly CandidateDoc["kind"][] = ["standard", "knowledge", "skill-improvement"];

/** Says what is wrong and exits (a CliExit's message is not printed). */
function fail(ctx: CliContext, message: string): never {
  ctx.out.error(message);
  throw new CliExit(EXIT.error);
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += String(chunk);
  return text;
}

/** The candidate's text: the argument, `--file`, or what is piped in (never a terminal's input). */
async function textOf(ctx: CliContext, words: readonly string[], file: string | undefined): Promise<string> {
  if (words.length > 0 && file) fail(ctx, "give the text as an argument or --file, not both");
  if (words.length > 0) return words.join(" ");
  if (file) {
    const path = resolve(ctx.cwd, file);
    if (!existsSync(path)) fail(ctx, `no file ${file}`);
    return readFileSync(path, "utf8");
  }
  const stdin = ctx.stdin as (NodeJS.ReadableStream & { isTTY?: boolean }) | undefined;
  if (!stdin || stdin.isTTY) fail(ctx, "the text: an argument, --file <path>, or piped on stdin");
  return readAll(stdin);
}

/**
 * `jarvis candidates add <kind> <title> [text…] [--file] [--skill] [--path…] [--evidence…] [--why]` — a
 * person proposes a candidate by hand; it waits for promote or reject like one review proposed.
 */
export async function runCandidatesAdd(
  ctx: CliContext,
  kind: string,
  title: string,
  words: readonly string[],
  options: { file?: string; skill?: string; path?: string[]; evidence?: string[]; why?: string },
): Promise<void> {
  if (!KINDS.includes(kind as CandidateDoc["kind"])) fail(ctx, `kind is one of ${KINDS.join(", ")}`);
  if (kind === "skill-improvement" && !options.skill)
    fail(ctx, "a skill improvement needs --skill <id>: the skill it improves");
  if (kind !== "skill-improvement" && options.skill) fail(ctx, "--skill is for a skill-improvement");
  const text = await textOf(ctx, words, options.file);
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const resolved = await resolveActor(loaded.config, ctx.env, loaded.project?.root);
    if (!resolved.actor) fail(ctx, "cannot determine the actor (ADR-0006)");
    const root = loaded.project?.root ?? ctx.cwd;
    let added: Candidate;
    try {
      added = addCandidate(runtime, {
        root,
        actor: resolved.actor,
        kind: kind as CandidateDoc["kind"],
        title,
        text,
        rationale: options.why,
        paths: options.path,
        evidence: options.evidence,
        skill: options.skill,
        skills: loadSkills(knowledgeRootsOf(loaded, root)).map((s) => s.id),
        channel: "cli",
      });
    } catch (error) {
      if (error instanceof CandidateInvalid) fail(ctx, error.message);
      throw error;
    }
    ctx.out.result(
      {
        added: added.artifact.artifactId,
        name: added.name,
        kind: added.doc.kind,
        run: added.artifact.runId,
        ...(added.doc.skill ? { skill: added.doc.skill } : {}),
      },
      () => {
        const st = ctx.out.style;
        ctx.out.line(`${st.ok("+")} candidate ${st.name(added.name)} ${st.muted(`· ${added.doc.kind}`)}`);
        ctx.out.line(`${st.muted("read   ")} ${st.cmd(`jarvis candidates show ${added.name}`)}`);
        ctx.out.line(`${st.muted("accept ")} ${st.cmd(`jarvis candidates promote ${added.name}`)}`);
      },
    );
  } finally {
    await runtime.close();
  }
}
