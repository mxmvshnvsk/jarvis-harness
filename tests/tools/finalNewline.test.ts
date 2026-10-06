import { describe, expect, it } from "vitest";
import { withFinalNewline } from "../../src/tools/local/provider.ts";

describe("text files end with a newline", () => {
  it("adds one to a new file and to a file that had one; leaves a file that had none", () => {
    expect(withFinalNewline("a\n});", undefined)).toBe("a\n});\n");
    expect(withFinalNewline("x", "old\n")).toBe("x\n");
    expect(withFinalNewline("x", "old without")).toBe("x");
    expect(withFinalNewline("done\n", undefined)).toBe("done\n");
    expect(withFinalNewline("", undefined)).toBe("");
  });
});
