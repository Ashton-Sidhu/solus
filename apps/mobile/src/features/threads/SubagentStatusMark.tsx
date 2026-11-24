import type { EnvironmentId, OrchestrationV2Subagent } from "@t3tools/contracts";

import { StateMarkView } from "./StateMark";
import { agentListStateMark } from "./state-marks";
import type { SubagentRowTone } from "./threadAgentsPresentation";

export const SUBAGENT_TONE_TEXT_CLASS = {
  working: "text-foreground-muted",
  completed: "text-adaptive-emerald-700-300",
  failed: "text-danger-foreground",
  stopped: "text-foreground-muted",
} as const satisfies Record<SubagentRowTone, string>;

export function SubagentStatusMark(props: {
  readonly environmentId: EnvironmentId;
  readonly status: OrchestrationV2Subagent["status"];
}) {
  const mark = agentListStateMark(props.status);
  return mark ? <StateMarkView mark={mark} environmentId={props.environmentId} /> : null;
}
