import { describe, expect, it } from "vitest";
import { CHURN_WRITES, WriteLedger } from "../../src/agents/writes.ts";

describe("writes going round (WriteLedger)", () => {
  it("says so when a file is written back to an earlier content, once", () => {
    const w = new WriteLedger();
    const path = "src/banner/banner.tsx";
    expect(w.note("repo.write", { path, content: "export {};\n" }, "c1")).toBeUndefined();
    expect(w.note("repo.write", { path, content: "" }, "c2")).toBeUndefined();
    // the same again: not «back», just once more
    expect(w.note("repo.write", { path, content: "" }, "c3")).toBeUndefined();
    const back = w.note("repo.write", { path: `./${path}`, content: "export {};\n" }, "c4");
    expect(back?.back).toBe("c1");
    expect(back?.text).toContain("now back to what call c1 wrote — this is going round");
    expect(w.note("repo.write", { path, content: "" }, "c5")?.back).toBeUndefined();
  });

  it("says so at the fifth write of a file, and again at the tenth; reads and other files are not counted", () => {
    const w = new WriteLedger();
    const notes: Array<string | undefined> = [];
    for (let i = 1; i <= CHURN_WRITES * 2; i++) {
      w.note("repo.read", { path: "a.ts" }, `r${i}`);
      w.note("repo.edit", { path: "b.ts", oldText: "x", newText: `y${i}` }, `b${i}`);
      notes.push(w.note("repo.edit", { path: "a.ts", oldText: `${i}`, newText: `${i + 1}` }, `a${i}`)?.text);
    }
    expect(notes.filter(Boolean)).toHaveLength(2);
    expect(notes[CHURN_WRITES - 1]).toContain("a.ts: written 5 times in this step");
    expect(notes[CHURN_WRITES * 2 - 1]).toContain("written 10 times");
  });
});
