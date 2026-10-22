import { branchOf, FormatError, headerOf, trailersOf } from "../../app/deliveryFormat.ts";
import { repoHooksOf, runHook } from "../../app/repoHooks.ts";
import { git } from "../../tools/local/exec.ts";
import type { StepContext } from "../types.ts";

/**
 * The repository's hooks among the project's checks (`delivery.hooks`): `pre-commit` on the run's whole
 * change staged (lint-staged sees it as in a person's commit; what it fixes stays), `pre-push` as at the
 * PR's push, `commit-msg` on the message the PR's commit will have — that one only said: the message is
 * the team's format (`delivery.commit`), not something the implementation fixes.
 */
export interface HookCheck {
  readonly check: string;
  readonly command: string;
  readonly ok: boolean;
  readonly tail?: string;
  readonly excerpt?: string;
  readonly advisory?: boolean;
}

function titleOf(ctx: StepContext): string {
  const spec = ctx.runtime.artifacts.listLatest(ctx.run.id, "spec")[0];
  if (spec) {
    try {
      const t = (JSON.parse(ctx.runtime.artifacts.text(spec)) as { title?: unknown }).title;
      if (typeof t === "string" && t.trim()) return t;
    } catch {
      // a spec in markdown: the task then
    }
  }
  return ctx.run.task.split("\n")[0] ?? ctx.run.task;
}

export async function hookChecks(ctx: StepContext, changed: readonly string[]): Promise<HookCheck[]> {
  if (changed.length === 0) return [];
  const checkout = ctx.workspace.ref.path;
  const hooks = await repoHooksOf(checkout);
  if (Object.keys(hooks).length === 0) return [];
  const cfg = ctx.runtime.loaded.config.delivery;
  const env = ctx.runtime.env;
  const timeoutMs = ctx.runtime.loaded.config.tools.commandTimeoutMs;
  const out: HookCheck[] = [];
  const input = {
    task: ctx.run.task,
    title: titleOf(ctx),
    ...(ctx.run.options?.kind ? { kind: ctx.run.options.kind } : {}),
    files: changed,
    runId: ctx.run.id,
  };
  if (hooks["pre-commit"]) {
    // the whole change staged, as `git commit -a` would give the hook
    await git(["add", "-A"], checkout);
    const r = await runHook(checkout, "pre-commit", hooks["pre-commit"], { env, timeoutMs });
    out.push({
      check: "hook:pre-commit",
      command: hooks["pre-commit"],
      ok: r.ok,
      ...(r.ok ? {} : { tail: r.output, excerpt: r.output.split("\n").slice(-12).join("\n") }),
    });
  }
  if (hooks["commit-msg"]) {
    try {
      const message = `${headerOf(cfg, input, cfg.commit.format)}\n\n${trailersOf(cfg, ctx.run.id)}`;
      const r = await runHook(checkout, "commit-msg", hooks["commit-msg"], { env, timeoutMs, message });
      out.push({
        check: "hook:commit-msg",
        command: `${hooks["commit-msg"]} «${message.split("\n")[0]}»`,
        ok: r.ok,
        ...(r.ok ? {} : { tail: r.output, advisory: true }),
      });
    } catch (error) {
      if (!(error instanceof FormatError)) throw error;
      out.push({
        check: "hook:commit-msg",
        command: "commit-msg",
        ok: false,
        tail: error.message,
        advisory: true,
      });
    }
  }
  if (hooks["pre-push"]) {
    let branch = ctx.workspace.ref.branch ?? "jarvis";
    try {
      branch = branchOf(cfg, input) ?? branch;
    } catch {
      // no key for the team's branch: the run's own name
    }
    const r = await runHook(checkout, "pre-push", hooks["pre-push"], {
      env,
      timeoutMs,
      push: { branch, remote: cfg.remote },
    });
    out.push({
      check: "hook:pre-push",
      command: hooks["pre-push"],
      ok: r.ok,
      ...(r.ok ? {} : { tail: r.output, excerpt: r.output.split("\n").slice(-12).join("\n") }),
    });
  }
  return out;
}
