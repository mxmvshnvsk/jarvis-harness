import { describe, expect, it } from "vitest";
import { ReadLedger, readKey, UNCHANGED } from "../../src/agents/rereads.ts";
import { trimToolResults } from "../../src/context/index.ts";
import type { Message } from "../../src/models/types.ts";

const file =
  "[repo.read] ok\n    1  export function total(order) {\n    2    return order.items.length;\n    3  }";
const call = (id: string, path = "src/orders/total.ts", extra: Record<string, unknown> = {}): Message => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id, name: "repo.read", arguments: JSON.stringify({ path, ...extra }) }],
});
const result = (id: string, content: string): Message => ({ role: "tool", toolCallId: id, content });

describe("a file read again in the same step (pilot: one file read 62 times)", () => {
  it("unchanged and still above: a pointer instead of the text; trimmed since: the text, pinned", () => {
    const ledger = new ReadLedger();
    const key = readKey("repo.read", { path: "./src/orders/total.ts" });
    expect(key).toBe("src/orders/total.ts#-");
    expect(readKey("repo.read", { path: "a.ts", startLine: 10, endLine: 20 })).toBe("a.ts#10-20");
    expect(readKey("repo.search", { pattern: "x" })).toBeUndefined();

    let transcript: Message[] = [call("c1")];
    const first = ledger.answer(key, "c1", file, transcript);
    expect(first).toEqual({ content: file, kind: "first" });
    transcript = [...transcript, result("c1", first.content), call("c2")];

    const again = ledger.answer(key, "c2", file, transcript);
    expect(again.kind).toBe("unchanged");
    expect(again.content).toContain(UNCHANGED);
    expect(again.content).toContain("call c1");
    expect(again.content.length).toBeLessThan(file.length + 200);
    transcript = [...transcript, result("c2", again.content)];

    // the first read trimmed away: the text comes back and is kept from now on
    const trim = trimToolResults(transcript, {
      keepRecent: 0,
      minChars: 10,
      store: () => "ref",
    });
    const trimmed = trim.transcript;
    // each trimmed result says which call it answered: the page names a re-read of it so
    expect(trim.originals[0]?.call).toMatch(/^repo\.read /);
    const back = ledger.answer(key, "c3", file, [...trimmed, call("c3")]);
    expect(back.kind).toBe("again");
    expect(back.content.startsWith(file)).toBe(true);
    expect(ledger.pinned("c3")).toBe(true);
    const later = [
      ...trimmed,
      call("c3"),
      result("c3", back.content),
      call("c4"),
      result("c4", `[repo.read] ok\n${"x".repeat(900)}`),
    ];
    // light pressure keeps the pinned result, as the manager asks
    const light = trimToolResults(later, {
      keepRecent: 0,
      minChars: 10,
      store: () => "ref",
      keep: (_c, m) => ledger.pinned(m.toolCallId ?? ""),
    }).transcript;
    expect(light.find((m) => m.toolCallId === "c3")?.content).toBe(back.content);

    // changed on disk since: the new text, marked
    const edited = file.replace("length", "count");
    const changed = ledger.answer(key, "c5", edited, [...later, call("c5")]);
    expect(changed.kind).toBe("changed");
    expect(changed.content).toContain("(changed since your read in call c3)");
  });

  it("a resumed step knows what it read before it parked", () => {
    const transcript: Message[] = [
      call("c1"),
      result("c1", file),
      call("c2", "src/orders/other.ts"),
      result("c2", "[repo.read] error: no such file"),
    ];
    const ledger = ReadLedger.from(transcript);
    expect(
      ledger.answer(readKey("repo.read", { path: "src/orders/total.ts" }), "c3", file, transcript).kind,
    ).toBe("unchanged");
    // a failed read is not a read
    expect(
      ledger.answer(readKey("repo.read", { path: "src/orders/other.ts" }), "c4", file, transcript).kind,
    ).toBe("first");
    // a different range is a different read
    expect(
      ledger.answer(
        readKey("repo.read", { path: "src/orders/total.ts", startLine: 1, endLine: 2 }),
        "c5",
        file,
        transcript,
      ).kind,
    ).toBe("first");
  });
});
