import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportRun } from "../../src/app/bundle.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import { createRun, testRuntime } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let rt: Runtime;
beforeEach(async () => {
  sb = sandbox();
  rt = await testRuntime(sb);
});
afterEach(async () => {
  await rt.close();
  sb.cleanup();
});

describe("a run bundle", () => {
  it("carries the agents' last conversation of each round and what it cut, not every checkpoint", async () => {
    const run = createRun(rt, "w");
    const lint = rt.blobs.put("src/a.ts:3 error no-unused-vars\n".repeat(50), "text/plain").contentRef;
    const trimmed = rt.blobs.put("the original of a git.diff", "text/plain").contentRef;
    const old = rt.blobs.put(
      JSON.stringify([{ role: "user", content: "round 1, early" }]),
      "application/json",
    );
    const last = rt.blobs.put(
      JSON.stringify([
        {
          role: "tool",
          content: `[project.lint] error: exit 1\n…[truncated: full output 1600 bytes, blob ${lint.slice(0, 12)}]`,
        },
      ]),
      "application/json",
    );
    const save = (ref: string) =>
      rt.checkpoints.save({
        runId: run.id,
        stepId: "implementation",
        iteration: 3,
        kind: "intra",
        state: { transcriptRef: ref },
      });
    save(old.contentRef);
    await new Promise((r) => setTimeout(r, 5));
    save(last.contentRef);
    rt.events.emit({
      kind: "context.trimmed",
      runId: run.id,
      stepId: "implementation",
      payload: { originals: [{ ref: trimmed, call: "git.diff" }] },
    });
    const bundle = await exportRun(rt, run.id);
    const keys = Object.keys(bundle.blobs);
    expect(keys).toContain(last.contentRef);
    expect(keys).toContain(lint);
    expect(keys).toContain(trimmed);
    expect(keys).not.toContain(old.contentRef);
    expect(Buffer.from(bundle.blobs[lint] as string, "base64").toString()).toContain("no-unused-vars");
  });
});
