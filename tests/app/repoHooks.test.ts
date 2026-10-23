import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitWithHooks, repoHooksOf, runHook } from "../../src/app/repoHooks.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import { prepareWorkspace } from "../../src/cli/commands/run.ts";
import type { DeterministicTool } from "../../src/orchestration/executors.ts";
import { BUILTIN_TOOLS } from "../../src/orchestration/tools/builtin.ts";
import type { Capability } from "../../src/tools/types.ts";
import { createRun, testRuntime } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** The repository's own hooks on Jarvis's work, and the run's base in the PR flow. */

const env = {
  PATH: process.env.PATH ?? "",
  HOME: "/nonexistent",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

function repo(): string {
  const dir = join(sb.root, "repo");
  execFileSync("git", ["init", "-q", "-b", "dev", dir], { env });
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}

function hook(dir: string, name: string, body: string): void {
  const path = join(dir, ".git", "hooks", name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

describe("the repository's hooks", () => {
  it("found when present and executable; run as git would run them", async () => {
    const dir = repo();
    expect(await repoHooksOf(dir)).toEqual({});
    hook(dir, "pre-commit", 'echo "lint: 2 problems in a.ts"; exit 1');
    hook(
      dir,
      "commit-msg",
      'grep -qE "^[a-z]+(\\([a-z-]+\\))?: [A-Z]+-[0-9]+ " "$1" || { echo "subject must be type(scope): KEY subject"; exit 1; }',
    );
    const hooks = await repoHooksOf(dir);
    expect(Object.keys(hooks).sort()).toEqual(["commit-msg", "pre-commit"]);
    const pre = await runHook(dir, "pre-commit", hooks["pre-commit"] as string, { env });
    expect(pre).toMatchObject({ ok: false });
    expect(pre.output).toContain("2 problems");
    expect(
      (await runHook(dir, "commit-msg", hooks["commit-msg"] as string, { env, message: "order totals" })).ok,
    ).toBe(false);
    expect(
      (
        await runHook(dir, "commit-msg", hooks["commit-msg"] as string, {
          env,
          message: "feat(orders): ABC-42 totals",
        })
      ).ok,
    ).toBe(true);
  });

  it("a real commit through them: refused — the branch as it was; made — base plus one commit, the history kept, the same again", async () => {
    const dir = repo();
    const base = sh(dir, "rev-parse", "HEAD");
    sh(dir, "checkout", "-q", "-b", "jarvis/abc-42");
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    sh(dir, "commit", "-q", "-am", "checkpoint 1");
    writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "checkpoint 2");
    const head = sh(dir, "rev-parse", "HEAD");
    hook(dir, "commit-msg", 'grep -q "ABC-42" "$1" || { echo "no issue key"; exit 1; }');
    const dates = {
      ...env,
      GIT_AUTHOR_DATE: "2026-10-22T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-10-22T12:00:00Z",
    };
    const refused = await commitWithHooks(dir, "jarvis/abc-42", base, "order totals", dates);
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { output: string }).output).toContain("no issue key");
    expect(sh(dir, "rev-parse", "HEAD")).toBe(head);
    const made = await commitWithHooks(dir, "jarvis/abc-42", base, "feat: ABC-42 order totals", dates);
    expect(made.ok).toBe(true);
    const commit = (made as { commit: string }).commit;
    expect(sh(dir, "rev-parse", `${commit}^`)).toBe(base);
    expect(sh(dir, "show", `${commit}:b.ts`)).toBe("export const b = 1;");
    expect(sh(dir, "rev-parse", "refs/jarvis/history/jarvis/abc-42")).toBe(head);
    expect(await commitWithHooks(dir, "jarvis/abc-42", base, "feat: ABC-42 order totals", dates)).toEqual({
      ok: true,
      commit,
    });
  });
});

describe("the run's base in the PR flow", () => {
  let rt: Runtime;
  afterEach(async () => {
    await rt?.close();
  });

  it("refused by a long hook: its error lines first, without the terminal's colours", async () => {
    const dir = repo();
    const base = sh(dir, "rev-parse", "HEAD");
    sh(dir, "checkout", "-q", "-b", "jarvis/abc-44");
    writeFileSync(join(dir, "a.ts"), "export const a = 3;\n");
    sh(dir, "commit", "-q", "-am", "checkpoint");
    // lefthook-like: the lint's errors early, then many passing tests and a coloured summary
    hook(
      dir,
      "pre-commit",
      [
        'printf "\\033[33mlib:lint: \\033[0m/w/src/form.test.tsx\\n"',
        'printf "\\033[33mlib:lint: \\033[0m  7:8  error  Expected a line break  object-curly-newline\\n"',
        'i=0; while [ $i -lt 80 ]; do printf "\\033[33mlib:test: \\033[0mPASS src/t$i.test.ts\\n"; i=$((i+1)); done',
        'printf "summary: \\342\\234\\224 run-test \\360\\237\\245\\212 run-lint\\n"',
        "exit 1",
      ].join("\n"),
    );
    const refused = await commitWithHooks(dir, "jarvis/abc-44", base, "feat: ABC-44 x", env);
    const output = (refused as { output: string }).output;
    expect(output.split("\n").slice(0, 3)).toEqual([
      "[failed — the lines that say error (1 of 83 lines):]",
      "lib:lint: /w/src/form.test.tsx",
      "lib:lint:   7:8  error  Expected a line break  object-curly-newline",
    ]);
    expect(output).toContain("run-lint");
    expect(output).not.toContain("\u001b[");
    expect(output).not.toContain("[the whole output:]");
  });

  it("the PR's target as the remote has it now, not the checkout's HEAD", async () => {
    const origin = join(sb.root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "dev", origin], { env });
    const dir = repo();
    sh(dir, "remote", "add", "origin", origin);
    sh(dir, "push", "-q", "origin", "dev");
    sh(dir, "remote", "set-head", "origin", "dev");
    // the remote's dev moves on; the checkout stays on an old commit of another branch
    const other = join(sb.root, "other");
    execFileSync("git", ["clone", "-q", origin, other], { env });
    writeFileSync(join(other, "c.ts"), "export const c = 1;\n");
    sh(other, "add", "-A");
    sh(other, "commit", "-q", "-m", "newer dev");
    sh(other, "push", "-q", "origin", "dev");
    const fresh = sh(other, "rev-parse", "HEAD");
    sh(dir, "checkout", "-q", "-b", "old-task");
    sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
    writeFileSync(join(dir, ".jarvis.yaml"), "");
    rt = await testRuntime({ ...sb, project: dir } as Sandbox, env);
    (rt.loaded as { project?: unknown }).project = { root: dir, isGitRepo: true };
    (rt.loaded.config.workspace as { mode: string }).mode = "worktree";
    const create: Capability = {
      name: "bitbucket.pr.create",
      description: "open a PR",
      network: "intranet",
      access: "write",
      effect: true,
      server: "bitbucket",
      parameters: { type: "object" },
      handler: async () => ({ ok: true }),
    };
    rt.registry.register({ name: "fake", capabilities: () => [create] });
    const notes: string[] = [];
    const style = new Proxy({}, { get: () => (s: string) => s });
    const ctx = {
      cwd: dir,
      env,
      out: {
        errStyle: style,
        style,
        note: (s: string) => notes.push(s),
        progress: () => {},
        error: () => {},
      },
    };
    const ws = await prepareWorkspace(
      ctx as never,
      rt,
      "run_1a2b3c4d5e6f",
      "ABC-42 totals",
      undefined,
      undefined,
      false,
    );
    expect(ws.baseRef).toBe("origin/dev");
    expect(ws.baseCommit).toBe(fresh);
    expect(notes.join("\n")).toContain("starts from origin/dev");
    expect(existsSync(ws.path)).toBe(true);
  });
});

describe("the repository's hooks among the project's checks", () => {
  let rt: Runtime;
  afterEach(async () => {
    await rt?.close();
  });

  it("pre-commit and pre-push failing are defects for the implementation; commit-msg only said", async () => {
    const dir = repo();
    const base = sh(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    hook(dir, "pre-commit", 'echo "eslint: a.ts no-unused-vars"; exit 1');
    hook(dir, "pre-push", 'echo "tests: 1 failed"; exit 1');
    hook(dir, "commit-msg", 'echo "type must be one of feat, fix"; exit 1');
    sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
    rt = await testRuntime(sb, env);
    const run = createRun(rt, "sdd", "ABC-42 totals");
    const checks = BUILTIN_TOOLS["project.checks"] as DeterministicTool;
    const out = await checks(
      {
        run,
        runtime: rt,
        step: { id: "checks" },
        iteration: 1,
        workspace: { ref: { mode: "worktree", repoRoot: dir, path: dir, baseRef: base, baseCommit: base } },
        tools: { invoke: async () => ({ ok: true, text: "" }), list: () => [] },
      } as never,
      {},
    );
    expect(out.outcome).toBe("defects_found");
    const doc = JSON.parse(rt.artifacts.text(rt.artifacts.listLatest(run.id, "checks")[0] as never)) as {
      results: Array<{ check: string; ok: boolean; advisory?: boolean }>;
      reasons: Array<{ summary: string }>;
    };
    expect(
      doc.results.filter((r) => r.check.startsWith("hook:")).map((r) => [r.check, r.ok, r.advisory ?? false]),
    ).toEqual([
      ["hook:pre-commit", false, false],
      ["hook:commit-msg", false, true],
      ["hook:pre-push", false, false],
    ]);
    expect(doc.reasons.map((r) => r.summary).join("\n")).toContain("no-unused-vars");
    expect(doc.reasons.map((r) => r.summary).join("\n")).not.toContain("type must be one of");
  });
});
