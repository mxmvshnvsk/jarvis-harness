import { deliveryFieldsVisible, type FormMode } from "./shared/delivery-fields.ts";

export interface OrderFormState {
  readonly mode: FormMode;
  readonly address?: string;
}

/** The sections of the order form, top to bottom. */
export function orderFormSections(state: OrderFormState): string[] {
  const sections = ["items", "contacts"];
  if (deliveryFieldsVisible({ mode: state.mode, hasAddress: state.address !== undefined })) {
    sections.push("delivery");
  }
  sections.push("payment");
  return sections;
}
