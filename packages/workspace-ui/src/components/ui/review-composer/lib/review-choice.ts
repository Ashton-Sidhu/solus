export interface ReviewChoice<Value extends string> {
  value: Value;
  label: string;
  kind: "comment" | "approve" | "request-changes";
  disabled?: boolean;
  disabledReason?: string;
}
