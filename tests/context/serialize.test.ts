import { describe, expect, it } from "vitest";
import { prefixReuse, stableJson } from "../../src/context/serialize.ts";
import type { Message } from "../../src/models/types.ts";

describe("stable serialisation (ADR-0013 §4)", () => {
  it("renders the same value the same way whatever the key order", () => {
    expect(stableJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[{"x":2,"y":1}]},"b":1}',
    );
  });

  it("measures how much of a prompt repeats the previous one from the start", () => {
    const base: Message[] = [
      { role: "system", content: "rules" },
      { role: "user", content: "task" },
    ];
    const first = [
      ...base,
      { role: "assistant" as const, content: "", toolCalls: [{ id: "1", name: "a", arguments: "{}" }] },
    ];
    const appended = [...first, { role: "tool" as const, content: "result", toolCallId: "1" }];
    expect(prefixReuse(first, appended)).toEqual({ reusedChars: 9, totalChars: 15 });
    // a stable layer that changed: reuse stops inside it
    const changed: Message[] = [{ role: "system", content: "rules v2" }, ...appended.slice(1)];
    expect(prefixReuse(appended, changed)).toEqual({ reusedChars: 5, totalChars: 18, changedMessage: 0 });
  });
});

describe("trimming at the watch level", () => {
  it("counts the results a trim would shorten", async () => {
    const { trimmable } = await import("../../src/context/transcript.ts");
    const tool = (content: string) => ({ role: "tool" as const, content, toolCallId: "x" });
    const long = "x".repeat(700);
    const t = [tool(long), tool("short"), tool(`${long}[trimmed: …]`), tool(long), tool(long)];
    expect(trimmable(t, 2)).toBe(1);
    expect(trimmable(t, 0)).toBe(3);
  });
});
