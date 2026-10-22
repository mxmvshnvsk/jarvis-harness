import { describe, expect, it } from "vitest";
import { REFORMAT_SHOWN, reformatted } from "../../src/tools/local/provider.ts";

describe("reformatted: what a fixer changed, shown with the write", () => {
  it("the changed span with its line numbers", () => {
    const r = reformatted("a\nb  \nc\nd\n", "a\nb\nc\nd\n");
    expect(r).toEqual({ from: 2, to: 2, text: "    2  b" });
  });
  it("removed lines are said", () => {
    expect(reformatted("a\n\n\nb\n", "a\n\nb\n")?.text).toBe("(1 line removed after line 2)");
  });
  it("too large a span: read the file again", () => {
    const many = Array.from({ length: REFORMAT_SHOWN + 5 }, (_, i) => `x${i}`);
    expect(reformatted(many.join("\n"), many.map((l) => `${l};`).join("\n"))).toBeUndefined();
  });
});
