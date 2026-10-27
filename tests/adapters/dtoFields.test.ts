import { describe, expect, it } from "vitest";
import {
  compareFields,
  dtoDeclsOf,
  endpointTypesOf,
  listenedTypeOf,
  sentTypeOf,
  wireType,
} from "../../src/adapters/dtoFields.ts";

/** ADR-0025 §6: the fields of a contract's DTOs, read off the code, compared side by side. */
describe("the fields of a DTO", () => {
  it("reads a Java class with Lombok and @JsonProperty, leaving out statics, methods and @JsonIgnore", () => {
    const java = `package com.example.orders;

import lombok.Data;

@Data
public class OrderCreatedEvent {
  private static final long serialVersionUID = 1L;
  private String orderId;
  @JsonProperty("slot_id")
  private Long deliverySlotId;
  private List<OrderLine> lines = new ArrayList<>();
  @JsonIgnore
  private String internal;

  public String describe() {
    return "order " + orderId + "; done";
  }

  public static class OrderLine {
    private String sku;
  }
}
`;
    const decls = dtoDeclsOf("src/main/java/OrderCreatedEvent.java", java);
    expect(decls.map((d) => d.name)).toEqual(["OrderCreatedEvent", "OrderLine"]);
    expect(decls[0]?.fields.map((f) => [f.name, f.type, f.line])).toEqual([
      ["orderId", "String", 8],
      ["slot_id", "Long", 9],
      ["lines", "List<OrderLine>", 11],
    ]);
    expect(decls[1]?.fields.map((f) => f.name)).toEqual(["sku"]);
  });

  it("reads an enum's constants: a value removed from a shared enum is a change of the contract", () => {
    const decl = dtoDeclsOf(
      "src/main/java/shop/EmailType.java",
      `package shop;
public enum EmailType {
    WELCOME(Notifications::getWelcome, Notifications::setWelcome),
    @Deprecated GIFT(Notifications::getGift, Notifications::setGift),
    DONE;
    private final Object getter;
    EmailType() { this.getter = null; }
}`,
    );
    expect(decl.map((d) => [d.name, d.fields.map((f) => f.name)])).toEqual([
      ["EmailType", ["WELCOME", "GIFT", "DONE"]],
    ]);
  });

  it("reads a record, a Kotlin data class and TypeScript types", () => {
    const record = dtoDeclsOf(
      "SlotDto.java",
      'public record SlotDto(String id, @JsonProperty("from") Instant start, int capacity) {\n  static SlotDto empty() { return null; }\n}\n',
    );
    expect(record[0]?.fields.map((f) => `${f.name}: ${f.type}`)).toEqual([
      "id: String",
      "from: Instant",
      "capacity: int",
    ]);
    const kotlin = dtoDeclsOf(
      "OrderCreated.kt",
      'data class OrderCreated(\n  val orderId: String,\n  @JsonProperty("slot_id") val deliverySlotId: Long? = null,\n)\n\nclass Other\n',
    );
    expect(kotlin[0]?.fields.map((f) => `${f.name}: ${f.type}`)).toEqual([
      "orderId: String",
      "slot_id: Long?",
    ]);
    const ts = dtoDeclsOf(
      "src/events.ts",
      `export interface OrderCreated {
  readonly orderId: string;
  deliverySlotId?: number | null;
  window: { from: string; to: string };
  describe(): string;
}
export type Slot = { id: string, capacity: number };
`,
    );
    expect(ts.map((d) => [d.name, d.fields.map((f) => `${f.name}: ${wireType(f.type)}`)])).toEqual([
      ["OrderCreated", ["orderId: string", "deliverySlotId: number", "window: object"]],
      ["Slot", ["id: string", "capacity: number"]],
    ]);
  });

  it("finds the declared type of a sender, a listener and an endpoint; an undeclared one is not seen", () => {
    expect(sentTypeOf("private final KafkaTemplate<String, OrderCreatedEvent> kafka;")).toBe(
      "OrderCreatedEvent",
    );
    expect(sentTypeOf("private final KafkaTemplate<String, Object> kafka;")).toBeUndefined();
    const listener = `class OrderListener {
  @KafkaListener(topics = "orders.created")
  public void onCreated(@Payload OrderCreatedEvent event, @Header("key") String key, Acknowledgment ack) {
    handle(event);
  }
  void other(ConsumerRecord<String, SlotEvent> record) {}
  void raw(String json) {}
}`;
    expect(listenedTypeOf(listener, "onCreated")).toBe("OrderCreatedEvent");
    expect(listenedTypeOf(listener, "other")).toBe("SlotEvent");
    expect(listenedTypeOf(listener, "raw")).toBeUndefined();
    const controller = `@RestController
class SlotController {
  @PostMapping("/slots/{id}")
  public ResponseEntity<SlotDto> reserve(@PathVariable String id, @RequestBody @Valid ReserveSlot body) {
    return ResponseEntity.ok(service.reserve(id, body));
  }
}`;
    expect(endpointTypesOf(controller, "reserve")).toEqual({ request: "ReserveSlot", response: "SlotDto" });
    expect(
      endpointTypesOf(
        'interface SlotsClient {\n  @GetMapping("/slots/{id}")\n  SlotDto getSlot(@PathVariable("id") String id);\n}',
        "getSlot",
      ),
    ).toEqual({
      response: "SlotDto",
    });
  });
});

describe("two sides of a DTO compared", () => {
  const decl = (fields: Array<[string, string]>) => ({
    name: "OrderCreatedEvent",
    file: "x.java",
    line: 1,
    fields: fields.map(([name, type], i) => ({ name, type, line: i + 2 })),
  });

  it("says per field: same, added, removed, renamed, type changed — ok or mismatch", () => {
    const writer = decl([
      ["orderId", "String"],
      ["deliverySlotId", "Long"],
      ["total", "BigDecimal"],
      ["createdAt", "Instant"],
      ["note", "String"],
    ]);
    const reader = decl([
      ["orderId", "string"],
      ["delivery_slot_id", "number"],
      ["total", "string"],
      ["createdAt", "string"],
      ["channel", "String"],
    ]);
    expect(compareFields(writer, reader).map((r) => [r.field, r.change, r.status])).toEqual([
      ["channel → note", "renamed", "mismatch"],
      ["createdAt", "same", "ok"],
      ["delivery_slot_id → deliverySlotId", "renamed", "mismatch"],
      ["orderId", "same", "ok"],
      ["total", "type changed", "mismatch"],
    ]);
    // a field the reader does not read is fine; one it reads and nobody writes is not
    const rows = compareFields(
      decl([
        ["orderId", "String"],
        ["extra", "int"],
      ]),
      decl([
        ["orderId", "String"],
        ["missing", "Long"],
        ["also", "String"],
      ]),
    );
    expect(rows.map((r) => [r.field, r.change, r.status])).toEqual([
      ["also", "removed", "mismatch"],
      ["extra", "added", "ok"],
      ["missing", "removed", "mismatch"],
      ["orderId", "same", "ok"],
    ]);
  });
});
