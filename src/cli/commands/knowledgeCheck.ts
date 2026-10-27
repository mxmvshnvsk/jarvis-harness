import { existsSync } from "node:fs";
import { join } from "node:path";
import { rootRelative } from "../../core/paths.ts";
import { checkKnowledge, type KnowledgeCheck, needsAttention } from "../../knowledge/docCheck.ts";
import { knowledgeRootsOf } from "../../knowledge/sources.ts";
import { git } from "../../tools/local/exec.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT } from "../output.ts";
import { loadForCli } from "./config.ts";

export interface KnowledgeCheckOptions {
  readonly fix?: boolean;
  /** In a knowledge repository: only this service. */
  readonly service?: string;
  /** Skip the folders without a document (the module tree). */
  readonly tree?: boolean;
}

/**
 * `jarvis knowledge check [--fix] [--service <name>]`: the knowledge documents against the code,
 * without a model — what they cite is there, line numbers that moved (put right with --fix), quoted
 * lines that are gone, maps the code moved on from, copies, the wrong language, and the biggest
 * folders no document is about. In a knowledge repository: every service, each in its repository.
 */
export async function runKnowledgeCheck(ctx: CliContext, options: KnowledgeCheckOptions): Promise<void> {
  const loaded = await loadForCli(ctx);
  if (loaded.meta && !loaded.meta.service) {
    const names = Object.keys(loaded.meta.repos).sort();
    if (options.service && !loaded.meta.repos[options.service]) {
      ctx.out.error(`${options.service} is not a service of the map (${names.join(", ") || "none"})`);
      throw new CliExit(EXIT.error);
    }
    const results: KnowledgeCheck[] = [];
    let attention = 0;
    for (const name of options.service ? [options.service] : names) {
      const path = loaded.meta.repos[name] as string;
      if (!existsSync(path) || existsSync(join(path, ".jarvis", "project.yaml"))) continue;
      const one = await checkOne({ ...ctx, cwd: path }, options, name);
      if (one) {
        results.push(one);
        attention += one.docs.filter(needsAttention).length + one.duplicates.length;
      }
    }
    if (ctx.out.json) ctx.out.result({ services: results }, () => {});
    if (attention > 0) throw new CliExit(EXIT.error);
    return;
  }
  const one = await checkOne(ctx, options);
  if (!one) throw new CliExit(EXIT.error);
  if (ctx.out.json) ctx.out.result(one, () => {});
  if (one.docs.some(needsAttention) || one.duplicates.length > 0) throw new CliExit(EXIT.error);
}

async function checkOne(
  ctx: CliContext,
  options: KnowledgeCheckOptions,
  service?: string,
): Promise<KnowledgeCheck | undefined> {
  const loaded = await loadForCli(ctx);
  const root = loaded.project?.root ?? ctx.cwd;
  if ((await git(["rev-parse", "--is-inside-work-tree"], root)).code !== 0) {
    ctx.out.error(`${service ?? root}: not a git repository`);
    return undefined;
  }
  const result = await checkKnowledge(knowledgeRootsOf(loaded, root), {
    fix: options.fix === true,
    language: loaded.config.language,
    tree: options.tree !== false,
  });
  if (ctx.out.json) return result;
  const st = ctx.out.style;
  if (service) ctx.out.line(`== ${service}`);
  ctx.out.line(st.muted(`${result.docs.length} documents in ${result.knowledgeDir}`));
  let clean = 0;
  for (const d of result.docs) {
    const notes: string[] = [];
    if (d.lost.length > 0) notes.push(st.bad(`${d.lost.length} quoted line(s) gone from the code`));
    if (d.missingPaths.length > 0)
      notes.push(st.bad(`${d.missingPaths.length} path(s) not in the repository`));
    if (d.staleCommits)
      notes.push(st.warn(`${d.staleCommits} commit(s) under its paths since it was mapped`));
    if (d.moved > 0)
      notes.push(
        d.fixed ? st.ok(`${d.moved} line number(s) put right`) : st.warn(`${d.moved} line number(s) moved`),
      );
    if (d.language)
      notes.push(st.warn(`written in ${d.language.found}, the team's language is ${d.language.expected}`));
    if (d.missingSymbols.length > 0)
      notes.push(st.muted(`${d.missingSymbols.length} symbol(s) not in the code`));
    if (notes.length === 0) {
      clean += 1;
      continue;
    }
    ctx.out.line(
      `${needsAttention(d) ? st.bad("✗") : st.warn("~")} ${d.doc}${d.generated ? st.muted(" (generated)") : ""}: ${notes.join("; ")}`,
    );
    for (const l of d.lost.slice(0, 5))
      ctx.out.line(st.muted(`    gone: ${l.ref} \`${l.text.slice(0, 100)}\``));
    for (const p of d.missingPaths.slice(0, 5)) ctx.out.line(st.muted(`    no such path: ${p}`));
    if (d.missingSymbols.length > 0)
      ctx.out.line(
        st.muted(
          `    symbols: ${d.missingSymbols.slice(0, 8).join(", ")}${d.missingSymbols.length > 8 ? ", …" : ""}`,
        ),
      );
  }
  if (clean > 0) ctx.out.line(`${st.ok("✓")} ${clean} document(s): what they cite is in the code`);
  for (const [a, b] of result.duplicates) ctx.out.line(`${st.bad("✗")} ${a} and ${b} say the same: keep one`);
  if (result.uncovered.length > 0) {
    ctx.out.line(st.heading("folders no document is about (biggest first):"));
    for (const u of result.uncovered) ctx.out.line(`  ${u.path} ${st.muted(`· ${u.files} files`)}`);
  }
  const moved = result.docs.reduce((n, d) => n + (d.fixed ? 0 : d.moved), 0);
  const remap = result.docs.filter((d) => d.generated && (d.lost.length > 0 || d.staleCommits || d.language));
  if (moved > 0)
    ctx.out.line(st.muted(`put the moved line numbers right: ${st.cmd("jarvis knowledge check --fix")}`));
  if (remap.length > 0)
    ctx.out.line(
      st.muted(
        `map again what the code moved on from (${remap.length}): ${st.cmd("jarvis onboard --stale")} in ${service ? `${service}'s repository` : rootRelative(ctx.cwd, root) || "this repository"}`,
      ),
    );
  ctx.out.line();
  return result;
}
