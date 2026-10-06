import assert from "node:assert/strict";
import { test } from "node:test";
import { orderFormSections } from "../src/order-form.ts";

test("the full form shows the delivery block when there is an address", () => {
  assert.deepEqual(orderFormSections({ mode: "full", address: "1 Main St" }), [
    "items",
    "contacts",
    "delivery",
    "payment",
  ]);
});
