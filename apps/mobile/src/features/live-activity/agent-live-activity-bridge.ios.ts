// Adapted from T3 Code apps/mobile/src/features/agent-awareness/agentLiveActivity.ios.ts (MIT, see UPSTREAM.md).
import type { AgentActivityCard } from "@solus/contracts/uplink";
import type { LiveActivity } from "expo-widgets";

import AgentActivity from "../../widgets/AgentActivity";
import type { LiveActivityBridge, LiveActivityHandle } from "./agent-live-activity-controller";

/** A card with its push token: iOS issues the token after the card starts, and may replace it. */
function handleOf(activity: LiveActivity<AgentActivityCard>): LiveActivityHandle {
  return {
    getId: () => activity.getId(),
    update: (props, staleDate) => activity.update(props, staleDate),
    end: (policy, props) => activity.end(policy, props),
    onPushToken: (listener) => {
      const subscription = activity.addPushTokenListener((event) => listener(event.pushToken));
      // The token may have arrived before this listener.
      activity.getPushToken().then((token) => { if (token) listener(token); }, () => undefined);
      return () => subscription.remove();
    },
  };
}

/** ActivityKit through expo-widgets. A deep link rides on each row (`widgetURL`). */
export const agentLiveActivityBridge: LiveActivityBridge = {
  instances: () => AgentActivity.getInstances().map(handleOf),
  start: (props, staleDate) => handleOf(AgentActivity.start(props, undefined, staleDate)),
};
