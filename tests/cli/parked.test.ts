import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app/runtime.ts";
import type { CliContext } from "../../src/cli/context.ts";
import { createOutput } from "../../src/cli/output.ts";
import { outageOf, waitParked } from "../../src/cli/parked.ts";
import { createRun, testRuntime } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let rt: Runtime;
beforeEach(async () => {
  sb = sandbox();
  sb.write("project/.jarvis/project.yaml", "version: 1\n");
  rt = await testRuntime(sb);
});
afterEach(async () => {
  await rt.close();
  sb.cleanup();
});

function context(): { ctx: CliContext; err: () => string } {
  let err = "";
  const sink = (fn: (s: string) => void) =>
    new Writable({
      write(chunk, _enc, cb) {
        fn(String(chunk));
        cb();
      },
    });
  const out = createOutput(
    false,
    {
      out: sink(() => {}),
      err: sink((s) => {
        err += s;
      }),
    },
    { progress: false, color: false },
  );
  return { ctx: { out } as unknown as CliContext, err: () => err };
}

/** A run parked for model `flash` at T, to be checked at T+5m. */
function parkedRun(at: number) {
  const run = createRun(rt, "smoke");
  rt.runs.transition(run.id, "RUNNING");
  rt.checkpoints.save({
    runId: run.id,
    stepId: "hello",
    iteration: 1,
    kind: "suspend",
    state: {
      resumeAfter: new Date(at + 300_000).toISOString(),
      modelUnavailable: { since: new Date(at).toISOString(), reason: "provider error (500)", checks: 1 },
    },
  });
  return rt.runs.transition(run.id, "WAITING_BUDGET", {
    reason: "model flash is unavailable",
    waitingFor: { kind: "model", detail: "flash" },
  });
}

describe("waiting for a parked run", () => {
  it("counts down, pings the model once per check and goes on when it answers", async () => {
    const t0 = Date.parse("2026-10-06T15:00:00Z");
    let now = t0 + 60_000;
    const run = parkedRun(t0);
    expect(outageOf(rt, run)).toMatchObject({ modelId: "flash", checks: 1, resumeAfter: t0 + 300_000 });
    const pings: number[] = [];
    const { ctx, err } = context();
    const result = await waitParked(ctx, rt, run, {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      tickMs: 60_000,
      alive: async () => {
        pings.push(now);
        return pings.length === 1
          ? { ok: false, reason: "model flash: provider error (500): upstream" }
          : { ok: true, latencyMs: 4_000 };
      },
    });
    expect(result).toBe("ready");
    // the first check when the run's own time came, the next one modelWait.checkEveryMinutes later
    expect(pings).toEqual([t0 + 300_000, t0 + 600_000]);
    expect(err()).toContain("model flash is unavailable since");
    expect(err()).toContain("check 2: still unavailable (provider error (500): upstream)");
    expect(err()).toContain("✓ model flash answers again (0:04) — going on");
  });

  it("leaves the run parked when the person stops waiting", async () => {
    const t0 = Date.now();
    const run = parkedRun(t0);
    const { ctx, err } = context();
    let ticks = 0;
    const result = await waitParked(ctx, rt, run, {
      sleep: async () => {
        ticks += 1;
      },
      interrupted: () => ticks >= 2,
      alive: async () => ({ ok: true, latencyMs: 1 }),
    });
    expect(result).toBe("left");
    expect(err()).toContain("left waiting; come back with jarvis continue");
    expect(rt.runs.require(run.id).state).toBe("WAITING_BUDGET");
  });
});
