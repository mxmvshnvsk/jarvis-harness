import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createOutput } from "../../src/cli/output.ts";
import { renderDiff, renderMarkdown } from "../../src/cli/render.ts";
import { colorEnabled, createStyle, padStyled, stripAnsi, visibleLength } from "../../src/cli/style.ts";

function sink(isTTY: boolean) {
  let text = "";
  const s = new Writable({
    write(c, _e, cb) {
      text += String(c);
      cb();
    },
  }) as Writable & { isTTY?: boolean };
  s.isTTY = isTTY;
  return { s, text: () => text };
}

describe("colour", () => {
  it("is on for a terminal only, never in --json; flags, NO_COLOR, FORCE_COLOR and TERM=dumb decide first", () => {
    const tty = { isTTY: true };
    const pipe = { isTTY: false };
    expect(colorEnabled({ stream: tty })).toBe(true);
    expect(colorEnabled({ stream: pipe })).toBe(false);
    expect(colorEnabled({ stream: tty, json: true })).toBe(false);
    expect(colorEnabled({ stream: tty, flag: false })).toBe(false);
    expect(colorEnabled({ stream: pipe, flag: true })).toBe(true);
    expect(colorEnabled({ stream: tty, env: { NO_COLOR: "1" } })).toBe(false);
    expect(colorEnabled({ stream: tty, env: { NO_COLOR: "" } })).toBe(true);
    expect(colorEnabled({ stream: pipe, env: { FORCE_COLOR: "1" } })).toBe(true);
    expect(colorEnabled({ stream: tty, env: { FORCE_COLOR: "0" } })).toBe(false);
    expect(colorEnabled({ stream: tty, env: { TERM: "dumb" } })).toBe(false);
  });

  it("plain style changes nothing; coloured style keeps the visible text", () => {
    const plain = createStyle(false);
    expect(plain.name("x") + plain.cmd("y") + plain.inline("run `jarvis status`")).toBe(
      "xyrun `jarvis status`",
    );
    const st = createStyle(true);
    expect(st.name("billing")).toBe("\u001b[1m\u001b[36mbilling\u001b[39m\u001b[22m");
    expect(stripAnsi(st.inline("run `jarvis status` now"))).toBe("run jarvis status now");
    expect(stripAnsi(st.state("WAITING_HUMAN"))).toBe("WAITING_HUMAN");
    expect(st.state("FAILED")).toContain("\u001b[31m");
    expect(st.byState("success", "ok   ")).toBe("\u001b[32mok   \u001b[39m");
    expect(visibleLength(st.warn("абв"))).toBe(3);
    expect(visibleLength(padStyled(st.ok("ab"), 5))).toBe(5);
  });

  it("output: errors get an `error:` prefix, notices keep their glyph, stdout styles backticked commands", () => {
    const out = sink(true);
    const err = sink(true);
    const o = createOutput(false, { out: out.s, err: err.s }, { progress: false, env: {} });
    o.line("see `jarvis candidates list`");
    o.raw("a `b`");
    o.error("no such run");
    o.note("⚠ 10:00 model: HTTP 500 — retry 1/3");
    expect(out.text()).toBe("see \u001b[36mjarvis candidates list\u001b[39m\na `b`\n");
    expect(stripAnsi(err.text())).toBe("error: no such run\n⚠ 10:00 model: HTTP 500 — retry 1/3\n");
    expect(err.text()).toContain("\u001b[33m⚠\u001b[39m");

    const pOut = sink(false);
    const pErr = sink(false);
    const p = createOutput(false, { out: pOut.s, err: pErr.s }, { env: {} });
    p.line("see `jarvis candidates list`");
    p.error("no such run");
    expect(pOut.text()).toBe("see `jarvis candidates list`\n");
    expect(pErr.text()).toBe("error: no such run\n");
  });

  it("renders markdown and diffs, and leaves them as is without colour", () => {
    const st = createStyle(true);
    const md = "---\nkind: module\n---\n# Title\n- rule **[check: a generalisation]**\n";
    const shown = renderMarkdown(md, st);
    expect(stripAnsi(shown)).toBe("---\nkind: module\n---\n# Title\n- rule [check: a generalisation]\n");
    expect(shown).toContain("\u001b[33m[check: a generalisation]\u001b[39m");
    expect(renderMarkdown(md, createStyle(false))).toBe(md);
    const diff = "diff --git a/x b/x\n@@ -1 +1 @@ ctx\n-old\n+new\n same";
    const d = renderDiff(diff, st);
    expect(stripAnsi(d)).toBe(diff);
    expect(d).toContain("\u001b[31m-old\u001b[39m");
    expect(d).toContain("\u001b[32m+new\u001b[39m");
    expect(renderDiff(diff, createStyle(false))).toBe(diff);
  });
});

describe("result documents", () => {
  it("read as markdown: title, summary, sections, nested acceptance, sources last", async () => {
    const { documentToMarkdown } = await import("../../src/cli/render.ts");
    const md = documentToMarkdown({
      $schema: "x",
      summary: "Why it breaks.",
      sources: ["a.ts:1"],
      title: "Bug",
      goals: ["Fix it"],
      requirements: [{ id: "R1", text: "Do X", acceptance: ["one", "two"] }],
      openQuestions: [],
      outcome: "ok",
    });
    expect(md).toBe(
      [
        "# Bug",
        "",
        "Why it breaks.",
        "",
        "## Goals",
        "",
        "- Fix it",
        "",
        "## Requirements",
        "",
        "- **R1** Do X",
        "  - Acceptance:",
        "    - one",
        "    - two",
        "",
        "## Sources",
        "",
        "- `a.ts:1`",
      ].join("\n"),
    );
  });
});
