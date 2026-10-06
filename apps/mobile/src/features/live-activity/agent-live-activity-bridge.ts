// Adapted from T3 Code apps/mobile/src/features/agent-awareness/agentLiveActivity.ts (MIT, see UPSTREAM.md).
import type { LiveActivityBridge } from "./agent-live-activity-controller";

/** Live Activities are iOS only: elsewhere there is never a card. */
export const agentLiveActivityBridge: LiveActivityBridge = {
  instances: () => [],
  start: () => null,
};
