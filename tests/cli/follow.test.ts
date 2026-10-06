import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app/runtime.ts";
import { runLogs } from "../../src/cli/commands/logs.ts";
import { runFollow } from "../../src/cli/commands/run.ts";
import { type CliContext, defaultContext } from "../../src/cli/context.ts";
import { run as cli } from "../../src/cli/main.ts";
import { CliExit, createOutput } from "../../src/cli/output.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
  sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
});
afterEach(() => sb.cleanup());

function context(): { ctx: CliContext; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  const w = (f: (s: string) => void) =>
    new Writable({
      write(c, _e, cb) {
        f(String(c));
        cb();
      },
    });
  const output = createOutput(
    false,
    { out: w((s) => (out += s)), err: w((s) => (err += s)) },
    { color: false },
  );
  return {
    ctx: defaultContext(output, { cwd: sb.project, homeDir: sb.home, env: { PATH: process.env.PATH ?? "" } }),
    out: () => out,
    err: () => err,
  };
}

async function runtime() {
  const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
  return createRuntime(loaded, { env: {} });
}

describe("following what goes on elsewhere", () => {
  it("`jarvis follow` shows the run's course so far, then live, until it stops; then the summary", async () => {
    const rt = await runtime();
    const r = rt.runs.create({
      task: "ABC-11",
      workflow: "smoke",
      owner: { kind: "user", id: "me@corp", verified: false },
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "internal",
    });
    rt.runs.update(r.id, { currentStep: "hello", currentIteration: 1 });
    rt.runs.transition(r.id, "RUNNING");
    rt.runs.acquireLease(r.id, "cli:elsewhere:1", 60_000);
    rt.events.emit({
      kind: "step.start",
      runId: r.id,
      stepId: "hello",
      payload: { stepId: "hello", iteration: 1, kind: "deterministic" },
    });
    rt.events.emit({
      kind: "step.finish",
      runId: r.id,
      stepId: "hello",
      payload: { stepId: "hello", iteration: 1, status: "success" },
    });
    // the other process finishes the run a moment later
    setTimeout(() => {
      rt.runs.transition(r.id, "COMPLETED", { reason: "workflow done" });
      rt.events.emit({ kind: "run.state", runId: r.id, payload: { state: "COMPLETED" } });
    }, 80);
    const { ctx, out, err } = context();
    const exit = await runFollow(ctx, undefined, { pollMs: 20 }).catch((e: unknown) => e);
    rt.close();
    expect(exit).toBeInstanceOf(CliExit);
    expect((exit as CliExit).code).toBe(0);
    expect(err()).toMatch(/✓ \[1\/2\] hello/);
    expect(out()).toContain("COMPLETED");
  });

  it("says when nothing runs here", async () => {
    const { ctx, out } = context();
    await runFollow(ctx, undefined, { pollMs: 10 });
    expect(out()).toContain("nothing runs here now");
  });

  it("`jarvis logs -f` prints what is written after it started", async () => {
    const dir = join(sb.home, ".jarvis", "logs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `jarvis-${new Date().toISOString().slice(0, 10)}.ndjson`);
    writeFileSync(
      file,
      `${JSON.stringify({ ts: new Date(Date.now() - 1000).toISOString(), level: "info", event: "old.one" })}\n`,
    );
    const { ctx, out } = context();
    let polls = 0;
    setTimeout(() => {
      appendFileSync(
        file,
        `${JSON.stringify({ ts: new Date().toISOString(), level: "info", event: "new.one" })}\n`,
      );
    }, 30);
    await runLogs(ctx, undefined, { follow: true, pollMs: 20, until: () => ++polls > 6 });
    expect(out()).toContain("old.one");
    expect(out()).toContain("new.one");
    expect(out().match(/old\.one/g)).toHaveLength(1);
  });

  it("`jarvis status` lists what needs a person first", async () => {
    const rt = await runtime();
    const make = (task: string) =>
      rt.runs.create({
        task,
        workflow: "smoke",
        owner: { kind: "user", id: "me@corp", verified: false },
        workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
        dataClass: "internal",
      });
    const waiting = make("needs a decision");
    make("just created");
    rt.runs.transition(waiting.id, "RUNNING");
    rt.runs.transition(waiting.id, "WAITING_HUMAN", { reason: "approve spec" });
    rt.close();
    let out = "";
    await cli(["node", "jarvis", "status"], {
      streams: {
        out: new Writable({
          write(c, _e, cb) {
            out += String(c);
            cb();
          },
        }),
        err: new Writable({
          write(_c, _e, cb) {
            cb();
          },
        }),
      },
      context: { cwd: sb.project, homeDir: sb.home, env: {} },
    });
    const rows = out.split("\n").filter((l) => /needs a decision|just created/.test(l));
    expect(rows[0]).toContain("needs a decision");
  });
});
