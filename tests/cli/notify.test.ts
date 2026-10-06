import { describe, expect, it } from "vitest";
import type { CliContext } from "../../src/cli/context.ts";
import {
  hyperlink,
  notifyModeOf,
  notifySequence,
  passthrough,
  supportsHyperlinks,
  supportsMarks,
  supportsTabProgress,
  tabProgressSequence,
  terminalOf,
  terminalSignals,
  titleSequence,
} from "../../src/cli/notify.ts";
import { createStyle, stripAnsi, visibleLength } from "../../src/cli/style.ts";

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

describe("terminal capabilities", () => {
  it("knows the terminal from its environment", () => {
    expect(terminalOf({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.6.2" })).toEqual({
      program: "iterm",
      version: "3.6.2",
      tmux: false,
    });
    expect(terminalOf({ WT_SESSION: "x" }).program).toBe("windows-terminal");
    expect(terminalOf({ TERM: "xterm-kitty" }).program).toBe("kitty");
    expect(terminalOf({ VTE_VERSION: "7600" }).program).toBe("vte");
    expect(terminalOf({ TERM_PROGRAM: "tmux", TMUX: "/tmp/x" })).toMatchObject({
      program: "other",
      tmux: true,
    });
  });

  it("sends tab progress only where it is known to work", () => {
    expect(
      supportsTabProgress(terminalOf({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.6.0" }), {}),
    ).toBe(true);
    // an older iTerm2 shows OSC 9 as a notification: 9;4 would pop up as one
    expect(
      supportsTabProgress(terminalOf({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5.4" }), {}),
    ).toBe(false);
    expect(supportsTabProgress(terminalOf({ WT_SESSION: "1" }), {})).toBe(true);
    expect(supportsTabProgress(terminalOf({}), { JARVIS_TAB_PROGRESS: "on" })).toBe(true);
    expect(tabProgressSequence("normal", 42.4)).toBe("\u001b]9;4;1;42\u0007");
    expect(tabProgressSequence("hide")).toBe("\u001b]9;4;0;0\u0007");
  });

  it("links and marks where the terminal knows them", () => {
    expect(supportsHyperlinks(terminalOf({ TERM_PROGRAM: "WezTerm" }), {})).toBe(true);
    expect(supportsHyperlinks(terminalOf({ TERM_PROGRAM: "Apple_Terminal" }), {})).toBe(false);
    expect(supportsHyperlinks(terminalOf({ TERM_PROGRAM: "WezTerm" }), { FORCE_HYPERLINK: "0" })).toBe(false);
    expect(supportsMarks(terminalOf({ TERM_PROGRAM: "WezTerm", TMUX: "x" }), {})).toBe(false);
    expect(hyperlink("file:///a.md", "a.md")).toBe("\u001b]8;;file:///a.md\u0007a.md\u001b]8;;\u0007");
    const linked = createStyle(true, { links: true }).link("file:///a.md", "a.md");
    expect(stripAnsi(linked)).toBe("a.md");
    expect(visibleLength(linked)).toBe(4);
    expect(createStyle(true).link("file:///a.md", "a.md")).toBe("a.md");
  });
});
