import { readFileSync } from "node:fs";
import { createRuntime } from "../../app/runtime.ts";
import {
  currentEntry,
  HookError,
  hookState,
  installHook,
  jarvisOnPath,
  locateHook,
  uninstallHook,
} from "../../hooks/gitHooks.ts";
import { analyseRange, type RangeReport } from "../../hooks/prepush.ts";
import { type CommitRange, parsePushRefs, rangeForHead, rangesForPush } from "../../hooks/range.ts";
import { globMatches } from "../../knowledge/frontmatter.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT } from "../output.ts";
import { loadForCli } from "./config.ts";

async function locate(ctx: CliContext) {
  try {
    return await locateHook(ctx.cwd, ctx.env);
  } catch (error) {
    if (error instanceof HookError) {
      ctx.out.error(error.message);
      throw new CliExit(EXIT.error);
    }
    throw error;
  }
}

/** `jarvis hooks install [--force]` */
export async function runHooksInstall(ctx: CliContext, options: { force?: boolean }): Promise<void> {
  const location = await locate(ctx);
  try {
    const entry = currentEntry();
    const result = installHook(location, {
      ...(options.force ? { force: true } : {}),
      ...(entry ? { entry } : {}),
    });
    ctx.out.result({ ...result, customHooksPath: location.customHooksPath }, () => {
      ctx.out.line(`${result.action} ${result.path}`);
      if (result.backup)
        ctx.out.line(`previous hook kept as ${result.backup}; \`jarvis hooks uninstall\` restores it`);
      if (location.customHooksPath) ctx.out.line("note: core.hooksPath is set, the hook was written there");
      if (!jarvisOnPath(ctx.env))
        ctx.out.line("note: `jarvis` is not on PATH; the hook falls back to this installation's CLI");
      ctx.out.line(
        "configure it in .jarvis/project.yaml under hooks.prePush; skip once with JARVIS_SKIP_HOOKS=1",
      );
    });
  } catch (error) {
    if (error instanceof HookError) {
      ctx.out.error(error.message);
      throw new CliExit(EXIT.error);
    }
    throw error;
  }
}

/** `jarvis hooks uninstall` */
export async function runHooksUninstall(ctx: CliContext): Promise<void> {
  const location = await locate(ctx);
  try {
    const result = uninstallHook(location);
    ctx.out.result(result, () => {
      if (!result.removed) ctx.out.line(`no pre-push hook at ${result.path}`);
      else ctx.out.line(`removed ${result.path}${result.restored ? "; the previous hook was restored" : ""}`);
    });
  } catch (error) {
    if (error instanceof HookError) {
      ctx.out.error(error.message);
      throw new CliExit(EXIT.error);
    }
    throw error;
  }
}

/** `jarvis hooks status` */
export async function runHooksStatus(ctx: CliContext): Promise<void> {
  const location = await locate(ctx);
  const loaded = await loadForCli(ctx);
  const state = hookState(location.hookPath);
  const policy = loaded.config.hooks.prePush;
  const summary = {
    path: location.hookPath,
    state,
    customHooksPath: location.customHooksPath,
    jarvisOnPath: jarvisOnPath(ctx.env),
    prePush: policy,
  };
  ctx.out.result(summary, () => {
    ctx.out.line(`pre-push hook: ${state} (${location.hookPath})`);
    if (state === "foreign")
      ctx.out.line("  not written by jarvis; `jarvis hooks install --force` backs it up and replaces it");
    if (state === "missing") ctx.out.line("  `jarvis hooks install` adds it");
    ctx.out.line(
      `jarvis on PATH: ${summary.jarvisOnPath ? "yes" : "no (the hook uses this installation's CLI)"}`,
    );
    ctx.out.line(
      `policy: mode ${policy.mode}, standards ${policy.standards ? "on" : "off"}, checks [${policy.checks.join(", ")}], semantic review ${policy.semanticReview} (blocks on ${policy.blockOn})`,
    );
  });
}

export interface PrePushCliOptions {
  readonly base?: string;
  readonly head?: string;
  readonly hook?: boolean;
  readonly semantic?: boolean;
  readonly remote?: string;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function renderRange(ctx: CliContext, r: RangeReport): void {
  ctx.out.line(
    `${r.branch}: ${r.baseLabel} ${r.base.slice(0, 10)}..${r.head.slice(0, 10)}, ${r.files.length} file(s)`,
  );
  const s = r.standards;
  ctx.out.line(
    `  standards  ${s.checked} checked, ${s.violations.length} violation(s)${s.skipped.length > 0 ? `, ${s.skipped.length} skipped` : ""}`,
  );
  for (const v of s.violations)
    ctx.out.line(
      `    ${v.severity === "required" ? "FAIL" : "warn"}  ${v.standardId}@${v.version} ${v.file ?? ""}${v.line ? `:${v.line}` : ""}  ${v.detail.split("\n")[0]}`,
    );
  for (const c of r.checks)
    ctx.out.line(
      `  check ${c.name}  ${c.skipped ? `skipped (${c.skipped})` : c.ok ? `ok (${c.ms} ms)` : "FAILED"}`,
    );
  for (const c of r.checks.filter((x) => !x.ok && x.output))
    ctx.out.line(`${c.output}`.replace(/^/gm, "    "));
  if (r.impact.available)
    ctx.out.line(
      `  impact     ${r.impact.untouchedDependents.length} dependent file(s) and ${r.impact.untouchedTests.length} covering test(s) not touched`,
    );
  else ctx.out.line(`  impact     unavailable (${r.impact.reason})`);
  const rv = r.review;
  ctx.out.line(
    `  review     ${rv.decision}${rv.verdict ? ` — ${rv.verdict}` : ""}${rv.reasons.length > 0 ? ` (${rv.reasons.join("; ")})` : ""}`,
  );
  for (const f of rv.findings)
    ctx.out.line(
      `    ${f.severity}  ${f.file ?? ""}${f.line ? `:${f.line}` : ""}  ${f.issue.split("\n")[0]}`,
    );
  for (const n of r.notes) ctx.out.line(`  note: ${n}`);
}

/** `jarvis prepush` — also what the installed hook runs (ADR-0001 §16). */
export async function runPrePush(ctx: CliContext, options: PrePushCliOptions): Promise<void> {
  if (ctx.env.JARVIS_SKIP_HOOKS) {
    ctx.out.error("jarvis prepush: skipped (JARVIS_SKIP_HOOKS)");
    return;
  }
  const loaded = await loadForCli(ctx);
  const projectRoot = loaded.project?.root ?? ctx.cwd;
  if (!loaded.project?.isGitRepo) {
    ctx.out.error("jarvis prepush: not inside a git repository");
    throw new CliExit(EXIT.error);
  }
  const policy = loaded.config.hooks.prePush;

  let ranges: CommitRange[];
  if (options.hook) {
    ranges = await rangesForPush(projectRoot, parsePushRefs(await readStdin()), options.remote);
  } else {
    const range = await rangeForHead(projectRoot, options.base, options.head);
    if (!range) {
      ctx.out.error(
        options.base ? `cannot resolve --base ${options.base}` : "no commit to review (an empty repository?)",
      );
      throw new CliExit(EXIT.error);
    }
    ranges = [range];
  }
  const skipped = ranges.filter((r) => globMatches(r.branch, policy.skipBranches));
  ranges = ranges.filter((r) => !skipped.includes(r));

  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const reports: RangeReport[] = [];
    for (const range of ranges)
      reports.push(
        await analyseRange(runtime, range, {
          ...(options.semantic === undefined
            ? {}
            : { semantic: options.semantic ? ("always" as const) : ("never" as const) }),
          cwd: ctx.cwd,
          projectRoot,
          env: ctx.env,
        }),
      );
    const blocking = reports.flatMap((r) => r.blocking);
    const blocked = policy.mode === "block" && blocking.length > 0;
    runtime.events.emit({
      kind: "prepush.checked",
      payload: {
        ranges: reports.length,
        blocking: blocking.length,
        mode: policy.mode,
        review: reports.map((r) => r.review.decision),
      },
    });
    ctx.out.result(
      { ok: !blocked, mode: policy.mode, skipped: skipped.map((r) => r.branch), ranges: reports },
      () => {
        if (reports.length === 0)
          ctx.out.line(
            skipped.length > 0
              ? `jarvis prepush: ${skipped.map((r) => r.branch).join(", ")} skipped (hooks.prePush.skipBranches)`
              : "jarvis prepush: nothing to check",
          );
        for (const r of reports) renderRange(ctx, r);
        if (blocking.length > 0) {
          ctx.out.line();
          ctx.out.line(blocked ? "push blocked:" : "would block (advisory mode):");
          for (const b of blocking) ctx.out.line(`  - ${b}`);
          if (blocked)
            ctx.out.line("fix it, or bypass once with `git push --no-verify` / JARVIS_SKIP_HOOKS=1");
        } else if (reports.length > 0) ctx.out.line("\npre-push checks passed");
      },
    );
    if (blocked) throw new CliExit(EXIT.error);
  } finally {
    await runtime.close();
  }
}
