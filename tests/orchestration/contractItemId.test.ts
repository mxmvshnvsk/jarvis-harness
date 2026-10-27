import { describe, expect, it } from "vitest";
import { contractItemId } from "../../src/orchestration/tools/cross.ts";

describe("a contract item's id", () => {
  it("without its kind in front (pilot: «endpoint POST /x» from a contract change was «missing»)", () => {
    expect(contractItemId("endpoint", "endpoint POST /individual/presign")).toBe("POST /individual/presign");
    expect(contractItemId("endpoint", "POST /x")).toBe("POST /x");
    expect(contractItemId("topic", "Topic orders.created")).toBe("orders.created");
    expect(contractItemId("dto", "OrderDto")).toBe("OrderDto");
  });
});
