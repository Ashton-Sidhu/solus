export interface ReviewChoice<Value extends string> {
  value: Value;
  label: string;
  kind: "comment" | "approve" | "request-changes";
  disabled?: boolean;
  disabledReason?: string;
}

/** One line under each verdict in the submit menu. */
export const verdictHelp: Record<ReviewChoice<string>["kind"], string> = {
  comment: "Feedback without a verdict",
  approve: "Ready as it is",
  "request-changes": "Needs changes first",
};
