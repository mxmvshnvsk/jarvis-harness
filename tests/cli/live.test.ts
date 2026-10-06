import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { activityOf, formatRecent } from "../../src/app/activity.ts";
import { createOutput } from "../../src/cli/output.ts";
import { charColumns, cutStyled, stripAnsi, visibleLength } from "../../src/cli/style.ts";
import type { StoredEvent } from "../../src/telemetry/events.ts";

function tty(columns: number) {
  let written = "";
  const err = Object.assign(
    new Writable({
      write(c, _e, cb) {
        written += String(c);
        cb();
      },
    }),
    { isTTY: true, columns },
  );
  const out = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  return { output: createOutput(false, { out, err }), written: () => written };
}

describe("the live region", () => {
  it("counts wide characters as two columns and cuts styled lines without breaking escapes", () => {
    expect(charColumns("a")).toBe(1);
    expect(charColumns("界")).toBe(2);
    expect(charColumns("́")).toBe(0);
    expect(visibleLength("\u001b[36m界a\u001b[39m")).toBe(3);
    const cut = cutStyled(`\u001b[36m${"x".repeat(30)}\u001b[39m`, 10);
    expect(stripAnsi(cut)).toBe(`${"x".repeat(9)}…`);
    expect(cut.startsWith("\u001b[36m")).toBe(true);
    expect(cutStyled("short", 10)).toBe("short");
  });

  it("redraws several lines as one synchronized frame, and erases all of them", () => {
    const { output, written } = tty(40);
    output.progress(["first line", `second ${"y".repeat(60)}`]);
    const frame = written();
    expect(frame.startsWith("\u001b[?2026h")).toBe(true);
    expect(frame.endsWith("\u001b[?2026l")).toBe(true);
    // the second line is cut to the terminal's width, so the region never wraps
    expect(
      Math.max(
        ...stripAnsi(frame.slice(8, -8))
          .split("\n")
          .map((l) => visibleLength(l.replace(/\r/g, ""))),
      ),
    ).toBeLessThanOrEqual(39);
    output.progress(["one"]);
    // the next frame first erases both lines of the previous one
    expect(written().slice(frame.length)).toContain("\r\u001b[2K\u001b[1A\u001b[2K");
    output.note("done");
    expect(written().endsWith("done\n")).toBe(true);
  });

  it("shows the step's last tool calls on a line of their own while the agent works", () => {
    let seq = 0;
    const ev = (kind: string, payload: Record<string, unknown>, at: number): StoredEvent =>
      ({
        seq: ++seq,
        ts: new Date(Date.parse("2026-10-06T10:00:00Z") + at * 1000).toISOString(),
        runId: "run_1",
        stepId: "spec",
        kind,
        payload,
      }) as StoredEvent;
    const events = [
      ev("step.start", { stepId: "spec", iteration: 1 }, 0),
      ev("agent.start", { agent: "specification" }, 1),
      ev("tool.call", { capability: "repo.read", ok: true, args: '{"path":"src/order-form.ts"}' }, 2),
      ev("tool.call", { capability: "repo.search", ok: false, args: '{"pattern":"isCompact"}' }, 3),
    ];
    const a = activityOf(events, new Date(Date.parse("2026-10-06T10:00:10Z")));
    expect(formatRecent(a as NonNullable<typeof a>)).toBe("  ↳ read src/order-form.ts · search isCompact ✗");
  });
});
