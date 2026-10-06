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

    // what the redactor masked in tool output: counts per step and the shape of high-entropy guesses
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    const runId = rt.runs.list({ includeTerminal: true })[0]?.id as string;
    rt.events.emit({
      kind: "security.redaction",
      runId,
      stepId: "write",
      payload: {
        boundary: "tool",
        count: 2,
        byType: { "high-entropy": 1, bearer: 1 },
        samples: [
          {
            placeholder: "[REDACTED:high-entropy:0a1b2c3d]",
            shape: "isC… 34 chars, mixed case",
            before: "const x = ",
          },
        ],
      },
    });
    rt.close();
    const masked = await jarvis(["show", id]);
    expect(masked.out).toContain("masked in what agents read");
    expect(masked.out).toContain("write  2 (high-entropy ×1, bearer ×1)");
    expect(masked.out).toContain("const x = [REDACTED:high-entropy:0a1b2c3d]  isC… 34 chars, mixed case");
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

  it("`jarvis fix` is the short workflow: no requirements, impact, plan, docs, telemetry, release notes", async () => {
    const { createEngine } = await import("../../src/app/engine.ts");
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    const steps = createEngine(rt)
      .workflow("fix")
      .steps.map((s) => s.id);
    rt.close();
    expect(steps).toEqual([
      "discover",
      "research",
      "spec",
      "approve-spec",
      "implementation",
      "verify",
      "standards",
      "checks",
      "review",
      "approve-impl",
      "review-analysis",
    ]);
    const created = await jarvis(["--json", "fix", "ABC-11"], { JARVIS_INTERACTIVE: "off" });
    expect(created.code).not.toBe(0); // no model configured: the research agent cannot run
    expect(created.err).toContain("▶ fix · ABC-11");
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
      content: '{"title":"Fix the form","summary":"Hide the fields.","requirements":[{"id":"R1","text":"Hide"}],"openQuestions":["Ever show them?","Which way?"],"risks":["The checkout may depend on the block."]}'
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
    expect(r.out).toContain("1 requirement · 1 risk · 2 open questions");
    expect(r.out).toContain("risk The checkout may depend on the block.");
    expect(r.out).toContain(
      "enter read it whole    a accept    c send back with changes    e …in $EDITOR    q decide later    ? help",
    );
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

  it("sends back with a comment written in $EDITOR from a template with the open questions", async () => {
    sb.write("project/.jarvis/workflows/reviewed.yaml", REVIEWED);
    // an "editor" that answers the first question and adds a note, as a person would
    sb.write(
      "editor.sh",
      `#!/bin/sh\ngrep -q '# 1) Ever show them?' "$1" || exit 1\nprintf '%s\\n' '# 1) Ever show them?' 'never' '# What else to change:' 'keep it small' > "$1"\n`,
    );
    const r = await jarvis(
      ["work", "ABC-9", "--workflow", "reviewed"],
      { ...ON, EDITOR: `sh ${sb.root}/editor.sh` },
      ["?", "e", "a"],
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("the same, written in your editor from a template with the questions");
    expect(r.out).toContain("↻ sent back spec/spec.json@1 with your changes");
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    const runId = rt.runs.list({ includeTerminal: true })[0]?.id as string;
    const spec = rt.artifacts.listLatest(runId, "spec")[0];
    const sentBack = rt.artifacts.approvalsFor(spec?.artifactId as string, 1)[0];
    rt.close();
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

  describe("an approved spec goes on to the implementation", () => {
    const SHORT = `name: short
entry: write
next: long
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
`;
    const LONG = `name: long
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
    transitions: { onSuccess: build }
  - id: build
    kind: deterministic
    tool: artifact.write
    args: { type: note, name: built.md, content: "built" }
    inputs: [spec]
    outputs: [note]
    transitions: { onSuccess: DONE }
`;
    beforeEach(() => {
      sb.write("project/.jarvis/workflows/short.yaml", SHORT);
      sb.write("project/.jarvis/workflows/long.yaml", LONG);
    });

    it("asks after the approval and goes on in the same command, from where the spec stopped", async () => {
      const r = await jarvis(["work", "ABC-9", "--workflow", "short"], ON, ["a", ""]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Go on to the implementation? build");
      expect(r.out).toMatch(/→ [0-9a-f]{8} long from build, with spec\.md of run [0-9a-f]{8}/);
      expect(r.err).toContain("▶ long · ABC-9");
      expect(r.err).toContain("✓ [3/3] build");
      // the spec is not written again: one write step in the whole session
      expect(r.err.match(/\] write /g)).toHaveLength(1);

      const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
      const rt = createRuntime(loaded, { env: {} });
      const long = rt.runs.list({ includeTerminal: true }).find((x) => x.workflow === "long");
      const spec = rt.artifacts.listLatest(long?.id as string, "spec")[0];
      expect(long?.state).toBe("COMPLETED");
      expect(spec?.provenance).toMatchObject({ kind: "import" });
      expect(rt.artifacts.isApproved(spec?.artifactId as string).approved).toBe(true);
      expect(rt.artifacts.listLatest(long?.id as string, "note")).toHaveLength(1);
      rt.close();
    });

    it("without a terminal: the summary says how, `continue <run>` goes on once", async () => {
      const OFF = { JARVIS_INTERACTIVE: "off" };
      const parked = await jarvis(["work", "ABC-10", "--workflow", "short"], OFF);
      const id = /run ([0-9a-f]{8})/.exec(parked.err)?.[1] as string;
      const approved = await jarvis(["approve", id, "--resume"], OFF);
      expect(approved.code).toBe(0);
      expect(approved.out).toContain(`jarvis continue ${id}`);
      expect(approved.out).toContain("go on as long: the implementation");
      expect(approved.out).not.toContain("Go on to the implementation?");

      const on = await jarvis(["continue", id], OFF);
      expect(on.code).toBe(0);
      expect(on.out).toContain("COMPLETED");
      const again = await jarvis(["continue", id], OFF);
      expect(again.out).toMatch(new RegExp(`run ${id} went on as [0-9a-f]{8}`));
    });
  });

  it("skips a step with nothing to do: `when: { affects: docs }` and an impact without docs", async () => {
    sb.write(
      "project/.jarvis/workflows/cond.yaml",
      `name: cond
entry: impact
steps:
  - id: impact
    kind: deterministic
    tool: artifact.write
    args:
      type: impact
      name: impact.json
      content: '{"affected":[{"path":"src/a.ts","kind":"code","reason":"r"}]}'
    outputs: [impact]
    transitions: { onSuccess: verify }
  - id: verify
    kind: composite
    children: [docs, notes]
    transitions: { onSuccess: DONE }
  - id: docs
    kind: deterministic
    tool: fail
    when: { affects: docs }
  - id: notes
    kind: deterministic
    tool: artifact.write
    when: { affects: code }
    args: { type: note, name: n.md, content: "n" }
`,
    );
    const r = await jarvis(["work", "C-1", "--workflow", "cond"], { JARVIS_INTERACTIVE: "off" });
    expect(r.code).toBe(0);
    expect(r.err).toContain("– [3/4] docs  skipped: the impact analysis names nothing of kind docs");
    expect(r.err).toMatch(/✓ \[4\/4\] notes/);
    expect(r.err).toMatch(/✓ \[2\/4\] verify/);
    expect(r.out).toContain("COMPLETED");
  });
});
