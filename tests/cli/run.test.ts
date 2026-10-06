import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app/runtime.ts";
import { run } from "../../src/cli/main.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
  // The sandbox has a bare `.git` directory, not a repository: use the checkout directly.
  sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
  // A project workflow with a human gate after a deterministic step.
  sb.write(
    "project/.jarvis/workflows/gated.yaml",
    `name: gated
entry: write
steps:
  - id: write
    kind: deterministic
    tool: artifact.write
    args: { type: spec, name: spec.md, content: "# spec" }
    outputs: [spec]
    transitions: { onSuccess: approve }
  - id: approve
    kind: approval
    artifactType: spec
    transitions: { onSuccess: DONE }
`,
  );
});
afterEach(() => sb.cleanup());

async function jarvis(args: string[], env: NodeJS.ProcessEnv = {}, input?: string[]) {
  let out = "";
  let err = "";
  const code = await run(["node", "jarvis", ...args], {
    ...(input ? { stdin: Readable.from([`${input.join("\n")}\n`]) } : {}),
    streams: {
      out: new Writable({
        write(c, _e, cb) {
          out += String(c);
          cb();
        },
      }),
      err: new Writable({
        write(c, _e, cb) {
          err += String(c);
          cb();
        },
      }),
    },
    context: { cwd: sb.project, homeDir: sb.home, env: { PATH: process.env.PATH ?? "", ...env } },
  });
  return { code, out, err };
}

describe("jarvis work / resume / approve / daemon", () => {
  it("runs the smoke workflow to completion with exit 0", async () => {
    const r = await jarvis(["work", "ABC-1", "--workflow", "smoke"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("state      COMPLETED");
    expect(r.out).toContain("note/hello.md@1");
  });

  it("narrates the run: a header, a line per finished step, the parking line, then a summary with next commands", async () => {
    const r = await jarvis(["work", "ABC-4", "--workflow", "gated"]);
    expect(r.code).toBe(10);
    const id = /run ([0-9a-z]{8})/.exec(r.err)?.[1] as string;
    expect(r.err).toContain(`▶ gated · ABC-4 · run ${id}`);
    expect(r.err).toContain("  write → approve");
    expect(r.err).toMatch(/✓ \[1\/2\] write {2}\s*\d+\.\ds\s+deterministic\s+→ spec\.md/);
    expect(r.err).toContain("⏸ [2/2] approve  waiting for approval — approve spec (spec.md@1)");
    expect(r.out).toContain(`run ${id}  WAITING_HUMAN`);
    expect(r.out).toContain("spec/spec.md@1  write  awaiting approval");
    expect(r.out).toContain("jarvis continue");
    expect(r.out).toContain(`jarvis show ${id} spec`);

    const list = await jarvis(["show", id]);
    expect(list.code).toBe(0);
    expect(list.out).toMatch(/spec\/spec\.md@1\s+write\s+awaiting approval/);
    const shown = await jarvis(["show", id, "spec"]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("# spec");
    expect(shown.out).toContain(`jarvis approve ${id} --resume`);
    expect((await jarvis(["show", id, "nope"])).err).toContain(`run ${id} has no artifact "nope"`);
  });

  it("parks at the human gate (exit 10), approves, resumes to completion; daemon picks up approved runs", async () => {
    const parked = await jarvis(["--json", "work", "ABC-2", "--workflow", "gated"]);
    expect(parked.code).toBe(10);
    const detail = JSON.parse(parked.out) as {
      run: { id: string; state: string };
      pendingApprovals: unknown[];
    };
    expect(detail.run.state).toBe("WAITING_HUMAN");
    expect(detail.pendingApprovals).toHaveLength(1);
    const id = detail.run.id;

    const tick = await jarvis(["--json", "daemon", "--once"]);
    expect(JSON.parse(tick.out)).toMatchObject({
      considered: 1,
      resumed: [],
      skipped: [{ reason: "waiting for a human decision" }],
    });

    const approved = await jarvis(["approve", id, "--comment", "lgtm"]);
    expect(approved.code).toBe(0);
    expect(approved.out).toContain("approve: spec/spec.md@1 by me@corp");

    const tick2 = await jarvis(["--json", "daemon", "--once"]);
    expect(JSON.parse(tick2.out)).toMatchObject({
      resumed: [{ runId: id, state: "COMPLETED", exitCode: 0 }],
    });
    const status = await jarvis(["--json", "status", id]);
    expect(JSON.parse(status.out)).toMatchObject({ run: { state: "COMPLETED" } });
  });

  it("approve --resume continues immediately; --reject fails the run", async () => {
    const parked = await jarvis(["--json", "work", "ABC-3", "--workflow", "gated"]);
    const id = (JSON.parse(parked.out) as { run: { id: string } }).run.id;
    const r = await jarvis(["approve", id.slice(4, 12), "--resume"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("state      COMPLETED");

    const parked2 = await jarvis(["--json", "work", "ABC-4", "--workflow", "gated"]);
    const id2 = (JSON.parse(parked2.out) as { run: { id: string } }).run.id;
    const rejected = await jarvis(["approve", id2, "--reject", "--comment", "wrong scope", "--resume"]);
    expect(rejected.code).toBe(1);
    expect(rejected.out).toContain("FAILED — spec rejected by me@corp: wrong scope");
  });

  it("refuses to resume a run held by a live lease and allows --steal", async () => {
    const created = await jarvis(["--json", "work", "ABC-5", "--workflow", "smoke", "--no-run"]);
    const id = (JSON.parse(created.out) as { id: string }).id;
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    rt.runs.acquireLease(id, "cli:elsewhere:1", 90_000);
    rt.close();
    const held = await jarvis(["resume", id]);
    expect(held.code).toBe(1);
    expect(held.err).toContain("held by cli:elsewhere:1");
    const stolen = await jarvis(["resume", id, "--steal"]);
    expect(stolen.code).toBe(0);
    expect(stolen.out).toContain("COMPLETED");
  });

  it("reports unknown workflows and runs", async () => {
    const r = await jarvis(["work", "X", "--workflow", "nope"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('unknown workflow "nope"');
    expect((await jarvis(["resume", "zzz"])).code).toBe(1);
  });
});

describe("a person at the terminal decides where the run stops", () => {
  const REVIEWED = `name: reviewed
entry: write
steps:
  - id: write
    kind: deterministic
    tool: artifact.write
    args:
      type: spec
      name: spec.json
      content: '{"title":"Fix the form","summary":"Hide the fields.","requirements":[{"id":"R1","text":"Hide"}],"openQuestions":["Ever show them?","Which way?"]}'
    outputs: [spec]
    transitions: { onSuccess: approve }
  - id: approve
    kind: approval
    artifactType: spec
    transitions:
      onSuccess: DONE
      onOutcome:
        request_changes: { to: write, maxIterations: 2 }
`;
  const ON = { JARVIS_INTERACTIVE: "on" };

  it("reads, sends back with answers to the open questions, then accepts — in one command", async () => {
    sb.write("project/.jarvis/workflows/reviewed.yaml", REVIEWED);
    const r = await jarvis(["work", "ABC-5", "--workflow", "reviewed"], ON, [
      "", // read it whole
      "c",
      "never", // 1/2
      "", // 2/2 skipped
      "keep it small",
      "", // send
      "a", // the second version
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Fix the form");
    expect(r.out).toContain("1 requirement · 2 open questions");
    expect(r.out).toContain("enter read it whole    a accept    c send back with changes    q decide later");
    expect(r.out).toContain("## Requirements");
    expect(r.out).toContain("1/2 Ever show them?");
    expect(r.out).toContain("↻ sent back spec/spec.json@1 with your changes");
    expect(r.out).toContain("✓ accepted spec/spec.json@2");
    expect(r.out).toContain("COMPLETED");
    expect(r.err).toContain("↻ approve → write request_changes, round 1/2");
    // one header: the run goes on in the same command
    expect(r.err.match(/▶ reviewed/g)).toHaveLength(1);

    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    const runId = rt.runs.list({ includeTerminal: true })[0]?.id as string;
    const spec = rt.artifacts.listLatest(runId, "spec")[0];
    const sentBack = rt.artifacts.approvalsFor(spec?.artifactId as string, 1)[0];
    rt.close();
    expect(sentBack?.decision).toBe("request_changes");
    expect(sentBack?.comment).toBe(
      "Answers to the open questions:\n1) Ever show them?\n   → never\n\nkeep it small",
    );
  });

  it("`jarvis continue` finds the waiting run without its id; q leaves it waiting", async () => {
    const parked = await jarvis(["work", "ABC-6", "--workflow", "gated"]);
    expect(parked.code).toBe(10);
    expect(parked.out).toContain("jarvis continue");

    const later = await jarvis(["continue"], ON, ["q"]);
    expect(later.code).toBe(10);
    expect(later.out).toContain("left waiting; come back with jarvis continue");

    const done = await jarvis(["c"], ON, ["a"]);
    expect(done.code).toBe(0);
    expect(done.out).toContain("✓ accepted spec/spec.md@1");
    expect(done.out).toContain("COMPLETED");
    expect(done.err).toContain("✓ [2/2] approve");
    expect(`${done.out}${done.err}`.match(/▶ gated/g)).toHaveLength(1);

    // interrupted (RUNNING, no process): continue resumes it (pilot: Ctrl-C, then "nothing waits")
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    const smoke = rt.runs.create({
      task: "ABC-8",
      workflow: "smoke",
      owner: { kind: "user", id: "me@corp", verified: false },
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "internal",
    });
    // as the engine leaves it: entered the first step, then the process died
    rt.runs.update(smoke.id, { currentStep: "hello", currentIteration: 1 });
    rt.runs.transition(smoke.id, "RUNNING");
    rt.runs.acquireLease(smoke.id, "cli:host:4242", -1000);
    rt.close();
    const resumed = await jarvis(["c"], ON, []);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toContain("COMPLETED");

    const none = await jarvis(["continue"], ON, []);
    expect(none.code).toBe(0);
    expect(none.out).toContain("nothing waits for you here");
  });

  it("without a person at the terminal nothing is asked", async () => {
    const r = await jarvis(["work", "ABC-7", "--workflow", "gated"], { JARVIS_INTERACTIVE: "off" }, ["a"]);
    expect(r.code).toBe(10);
    expect(r.out).not.toContain("decide later");
  });
});
