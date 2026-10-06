// Adapted from T3 Code apps/mobile/src/features/agent-awareness/agentLiveActivity.ios.ts (MIT, see UPSTREAM.md).
import AgentActivity from "../../widgets/AgentActivity";
import type { LiveActivityBridge } from "./agent-live-activity-controller";

/** ActivityKit through expo-widgets. A deep link rides on each row (`widgetURL`). */
export const agentLiveActivityBridge: LiveActivityBridge = {
  instances: () => AgentActivity.getInstances(),
  start: (props, staleDate) => AgentActivity.start(props, undefined, staleDate),
};
