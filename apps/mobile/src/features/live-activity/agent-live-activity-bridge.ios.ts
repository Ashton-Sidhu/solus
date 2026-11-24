// Adapted from T3 Code's ActivityKit bridge (MIT, see UPSTREAM.md).
import {
  getAgentLiveActivities,
  startAgentLiveActivity,
} from "../agent-awareness/agentLiveActivity";
import Constants from "expo-constants";
import type { LiveActivity } from "expo-widgets";
import type { AgentActivityProps } from "../../widgets/AgentActivity";
import type {
  LiveActivityBridge,
  LiveActivityHandle,
} from "./agent-live-activity-controller";

const scheme = Constants.expoConfig?.scheme;
const appScheme = Array.isArray(scheme) ? scheme[0] : scheme;

function handleOf(
  activity: LiveActivity<AgentActivityProps>,
): LiveActivityHandle {
  return {
    getId: () => activity.getId(),
    update: (props, staleDate) =>
      activity.update({ ...props, appScheme }, staleDate),
    end: (policy, props) => activity.end(policy, props),
    onPushToken: (listener) => {
      let listening = true;
      let receivedUpdate = false;
      const subscription = activity.addPushTokenListener(({ pushToken }) => {
        receivedUpdate = true;
        listener(pushToken);
      });
      // A restored activity may already have a token. A later rotation takes precedence.
      void activity.getPushToken().then(
        (token) => {
          if (listening && !receivedUpdate && token) listener(token);
        },
        () => {},
      );
      return () => {
        listening = false;
        subscription.remove();
      };
    },
  };
}

export const agentLiveActivityBridge: LiveActivityBridge = {
  instances: () => getAgentLiveActivities().map(handleOf),
  start: (props, staleDate) => {
    const activity = startAgentLiveActivity({ ...props, appScheme }, staleDate);
    return activity ? handleOf(activity) : null;
  },
};
