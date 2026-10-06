import { describe, expect, it } from "vitest";
import type { CliContext } from "../../src/cli/context.ts";
import {
  notifyModeOf,
  notifySequence,
  passthrough,
  terminalSignals,
  titleSequence,
} from "../../src/cli/notify.ts";

describe("terminal signals", () => {
  it("picks OSC 9 where the terminal shows it, the bell elsewhere, and what JARVIS_NOTIFY says", () => {
    expect(notifyModeOf({ TERM_PROGRAM: "iTerm.app" })).toBe("osc9");
    expect(notifyModeOf({ TERM_PROGRAM: "WezTerm" })).toBe("osc9");
    expect(notifyModeOf({ TERM: "xterm-ghostty" })).toBe("osc9");
    expect(notifyModeOf({ TERM_PROGRAM: "Apple_Terminal" })).toBe("bel");
    expect(notifyModeOf({ TERM_PROGRAM: "iTerm.app", JARVIS_NOTIFY: "off" })).toBe("off");
    expect(notifyModeOf({ JARVIS_NOTIFY: "OSC777" })).toBe("osc777");
  });

  it("builds the sequences and keeps control characters out of them", () => {
    expect(notifySequence("osc9", "jarvis", "run 1a2b waits\u001b[31m;")).toBe(
      "\u001b]9;jarvis: run 1a2b waits [31m \u0007",
    );
    expect(notifySequence("osc777", "jarvis", "done")).toBe("\u001b]777;notify;jarvis;done\u0007");
    expect(notifySequence("bel", "x", "y")).toBe("\u0007");
    expect(notifySequence("off", "x", "y")).toBe("");
    expect(titleSequence("▶ jarvis 3/9 spec")).toBe("\u001b]2;▶ jarvis 3/9 spec\u0007");
    expect(passthrough("\u001b]9;a\u0007", { TMUX: "/tmp/tmux,1,0" })).toBe(
      "\u001bPtmux;\u001b\u001b]9;a\u0007\u001b\\",
    );
    expect(passthrough("\u0007", { TMUX: "x" })).toBe("\u0007");
  });

  it("notifies only about runs that took a while, and leaves the title alone when asked", () => {
    const written: string[] = [];
    let now = 0;
    const ctx = (env: NodeJS.ProcessEnv) =>
      ({ env, out: { terminal: (s: string) => written.push(s) } }) as unknown as CliContext;
    const signals = terminalSignals(ctx({ TERM_PROGRAM: "iTerm.app" }), () => now);
    signals.notify("jarvis", "quick");
    now = 31_000;
    signals.notify("jarvis", "slow");
    signals.title("✓ jarvis done");
    expect(written).toEqual(["\u001b]9;jarvis: slow\u0007", "\u001b]2;✓ jarvis done\u0007"]);
    written.length = 0;
    terminalSignals(ctx({ JARVIS_TITLE: "off" })).title("x");
    expect(written).toEqual([]);
  });
});
