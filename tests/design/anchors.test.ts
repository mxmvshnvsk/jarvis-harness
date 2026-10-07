import { describe, expect, it } from "vitest";
import { ANCHOR_LIMITS, anchorsIn, anchorsSection, hitOf } from "../../src/design/anchors.ts";

describe("anchors: the sources' code names and interface texts, found in the code by code", () => {
  it("takes names and quoted texts; leaves JSON keys and values, links, brands, escapes and ids", () => {
    // a page as a tool answers it: JSON, its markdown body with escaped quotes and line breaks
    const page = JSON.stringify({
      metadata: { title: "Delivery slots | FRONT", createdAt: "2026-10-01", spaceId: "WEB" },
      body: 'Show slots when isDeliveryAvailable = true.\n### Remove the "Pick a courier" toggle\nCall getDeliverySlots (TypeScript), see https://wiki.example.corp/x/yScrollPosition\nOwner U_M38WA, flag DELIVERY_SLOTS_V2\n«Доставка курьером» and «Доставка | BACK»',
    });
    const found = anchorsIn(["ABC-42: delivery slots for the OrderSummaryCard", page]);
    expect(found.map((a) => `${a.kind}:${a.value}`)).toEqual([
      "name:OrderSummaryCard",
      "name:isDeliveryAvailable",
      "name:getDeliverySlots",
      "name:DELIVERY_SLOTS_V2",
      "text:Pick a courier",
      "text:Доставка курьером",
    ]);
  });

  it("where: per file with its lines, Jarvis's own files left out, a common name not pointed at", () => {
    const anchor = { kind: "name" as const, value: "getDeliverySlots" };
    const hit = hitOf(anchor, [
      "src/api/slots.ts:12:export function getDeliverySlots()",
      "src/api/slots.ts:40:  getDeliverySlots();",
      "src/pages/delivery.tsx:7:import { getDeliverySlots }",
      ".jarvis/knowledge/delivery.md:3:getDeliverySlots returns…",
    ]);
    expect(hit).toMatchObject({
      places: ["src/api/slots.ts:12,40", "src/pages/delivery.tsx:7"],
      total: 3,
      files: 2,
    });
    const common = hitOf(
      { kind: "name", value: "orderId" },
      Array.from({ length: ANCHOR_LIMITS.common.hits + 1 }, (_, i) => `src/f${i}.ts:1:orderId`),
    );
    const section = anchorsSection([hit, common, hitOf({ kind: "text", value: "Доставка курьером" }, [])]);
    expect(section).toContain("- `getDeliverySlots` — src/api/slots.ts:12,40; src/pages/delivery.tsx:7");
    expect(section).toContain("- `orderId` — everywhere (61 in 61 files): too common to point at");
    expect(section).toContain("- «Доставка курьером» — not in the code");
  });
});
