import { describe, expect, it } from "vitest";
import { SEARCHED_EMPTY, SearchLedger, searchOf } from "../../src/agents/searches.ts";
import type { Message } from "../../src/models/types.ts";

const EMPTY = "[repo.search] ok";

describe("an empty search again (pilot: the same text in the same two files, six times)", () => {
  it("glob or path, case and word marks aside, the same place or a narrower one: said to be searched already", () => {
    const ledger = new SearchLedger();
    const ask = (id: string, args: Record<string, unknown>, content = EMPTY) =>
      ledger.answer("repo.search", args, id, content);
    expect(ask("c1", { pattern: "slot", glob: "server/**" }).kind).toBe("first");
    // narrower: one file of that folder, as path and as glob, as slot and as [Ss]lot
    const a = ask("c2", { pattern: "slot", path: "server/src/config/services.ts" });
    expect(a.kind).toBe("empty-again");
    expect(a.content).toContain(`${SEARCHED_EMPTY} call c1 searched "slot" in server and found nothing`);
    expect(ask("c3", { pattern: "[Ss]lot", glob: "server/src/config/services.ts" }).kind).toBe("empty-again");
    expect(ask("c4", { pattern: "\\bSLOT\\b", path: "./server/" }).kind).toBe("empty-again");
    // not the same search: other text, a wider place, a filter the first did not have
    expect(ask("c5", { pattern: "slots", path: "server" }).kind).toBe("first");
    expect(ask("c6", { pattern: "slot", path: "." }).kind).toBe("first");
    expect(ask("c7", { pattern: "rounding", glob: "*.tsx" }).kind).toBe("first");
    expect(ask("c8", { pattern: "rounding", path: "src" }).kind).toBe("first");
  });

  it("the search always runs: what it finds now (a file changed) comes as it is", () => {
    const ledger = new SearchLedger();
    ledger.answer("repo.search", { pattern: "deliveryDate", path: "src" }, "c1", EMPTY);
    const found = "[repo.search] ok\nsrc/orders/card.tsx:12:  deliveryDate,";
    expect(ledger.answer("repo.search", { pattern: "deliveryDate", path: "src" }, "c2", found)).toEqual({
      content: found,
      kind: "first",
    });
  });

  it("a resumed step knows what it searched empty before it parked", () => {
    const transcript: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c1",
            name: "repo.search",
            arguments: JSON.stringify({ pattern: "isCourierFree", path: "src" }),
          },
        ],
      },
      { role: "tool", toolCallId: "c1", content: EMPTY },
    ];
    const again = SearchLedger.from(transcript).answer(
      "repo.search",
      { pattern: "iscourierfree", path: "src/api" },
      "c2",
      EMPTY,
    );
    expect(again.kind).toBe("empty-again");
    expect(searchOf("repo.read", { path: "a.ts" })).toBeUndefined();
  });
});
