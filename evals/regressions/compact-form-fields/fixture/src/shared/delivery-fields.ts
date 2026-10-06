export type FormMode = "full" | "compact";

export interface DeliveryFieldsProps {
  readonly mode: FormMode;
  readonly hasAddress: boolean;
}

/** Whether the order form shows the delivery block (street, city, postcode). */
export function deliveryFieldsVisible(props: DeliveryFieldsProps): boolean {
  return props.hasAddress;
}
