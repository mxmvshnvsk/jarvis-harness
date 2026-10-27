import { describe, expect, it } from "vitest";
import { ASKED_ALREADY, RepeatLedger, repeatKey } from "../../src/agents/repeats.ts";
import type { Message } from "../../src/models/types.ts";

describe("the same read again in one step (pilot: its own issue three times, the same search twice)", () => {
  it("an issue by its key, a page by its id, the rest by every argument", () => {
    expect(repeatKey("jira.get", { key: "abc-1", fields: "*all" })).toBe(
      repeatKey("jira.get", { key: "ABC-1" }),
    );
    expect(repeatKey("confluence.get", { id: 42 })).toBe(repeatKey("confluence.get", { pageId: "42" }));
    expect(repeatKey("repo.search", { pattern: "a", path: "x" })).toBe(
      repeatKey("repo.search", { path: "x", pattern: "a" }),
    );
    expect(repeatKey("repo.search", { pattern: "a" })).not.toBe(repeatKey("repo.search", { pattern: "b" }));
    // its own ledger, or a marker
    expect(repeatKey("repo.read", { path: "a.ts" })).toBeUndefined();
    expect(repeatKey("plan.step", { step: "1", status: "done" })).toBeUndefined();
  });

  it("knows what the step answered, forgets the workspace's reads after a write", () => {
    const ledger = new RepeatLedger();
    ledger.answered("jira.get", { key: "ABC-1" }, "c1");
    ledger.answered("repo.search", { pattern: "flag" }, "c2");
    expect(ledger.first("jira.get", { key: "abc-1", fields: ["*all"] })).toBe("c1");
    expect(ledger.first("repo.search", { pattern: "flag" })).toBe("c2");
    ledger.changed();
    expect(ledger.first("repo.search", { pattern: "flag" })).toBeUndefined();
    expect(ledger.first("jira.get", { key: "ABC-1" })).toBe("c1");
    expect(RepeatLedger.text("jira.get", "c1")).toBe(
      `[jira.get] ok\n${ASKED_ALREADY}: the answer to call c1 above is the same — use it; this did not count against your tool calls)`,
    );
  });

  it("a resumed step knows what it was answered — not what failed", () => {
    const transcript: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "jira.get", arguments: JSON.stringify({ key: "ABC-1" }) },
          { id: "c2", name: "confluence.get", arguments: JSON.stringify({ id: "7" }) },
        ],
      },
      { role: "tool", toolCallId: "c1", content: "[jira.get] ok\nsummary" },
      { role: "tool", toolCallId: "c2", content: "[confluence.get] failed: 500" },
    ];
    const ledger = RepeatLedger.from(transcript);
    expect(ledger.first("jira.get", { key: "ABC-1" })).toBe("c1");
    expect(ledger.first("confluence.get", { id: "7" })).toBeUndefined();
  });
});
