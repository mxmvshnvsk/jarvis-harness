import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app/runtime.ts";
import { run } from "../../src/cli/main.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
  sb.write("project/.jarvis/project.yaml", "version: 1\n");
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

async function jarvis(args: string[], env: NodeJS.ProcessEnv = {}) {
  let out = "";
  let err = "";
  const code = await run(["node", "jarvis", ...args], {
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
