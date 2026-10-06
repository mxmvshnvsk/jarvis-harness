import { orderFormSections } from "./order-form.ts";

/** The one-screen checkout for returning customers: items, contacts and payment only. */
export function compactCheckout(address?: string): string[] {
  return orderFormSections({ mode: "compact", ...(address ? { address } : {}) });
}
