import type { SolusApp } from "@solus-mobile/app/solus-app";
import { threadTitle } from "@solus-mobile/features/threads/threadListV2";
import {
  notificationEventForAttentionKind,
  shouldDeliverNotification,
} from "@solus/contracts/notification-types";
import type { AttentionKind } from "@solus/contracts/attention-types";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";

import { agentActivityDeepLink } from "../live-activity/agent-activity-model";
import { setupAgentAlertChannels } from "./notificationPermissions";
import { isAgentThreadOnScreen } from "./notificationNavigation";

const MAX_RECENT_ALERTS = 256;

const ALERT_TITLE: { readonly [Kind in AttentionKind]: string } = {
  needs_approval: "Needs approval",
  question: "Needs input",
  failed: "Session failed",
  finished: "Turn finished",
};

interface AgentAlertSource {
  readonly sessionCache: Pick<SolusApp["sessionCache"], "scope">;
  readonly threadList: Pick<SolusApp["threadList"], "changes" | "facts">;
  readonly threads: Pick<SolusApp["threads"], "thread">;
  readonly personal: Pick<SolusApp["personal"], "current">;
}

export function installSolusAgentAlerts(app: AgentAlertSource): () => void {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return () => {};
  void setupAgentAlertChannels().catch(() => {});
  let scope = app.sessionCache.scope();
  let startedAt = Date.now();
  let lastAttention = app.threadList.facts().attention;
  const recentAlerts = new Set<string>();
  return app.threadList.changes.subscribe(() => {
    const nextScope = app.sessionCache.scope();
    const attention = app.threadList.facts().attention;
    if (nextScope !== scope) {
      scope = nextScope;
      startedAt = Date.now();
      lastAttention = attention;
      recentAlerts.clear();
      return;
    }
    if (attention === lastAttention) return;
    lastAttention = attention;
    const preferences = app.personal.current().notifications;
    for (const [key, entry] of attention ?? []) {
      if (entry.since < startedAt) continue;
      const identifier = JSON.stringify([key, entry.kind, entry.since]);
      if (recentAlerts.has(identifier)) continue;
      recentAlerts.add(identifier);
      if (recentAlerts.size > MAX_RECENT_ALERTS) {
        const oldest = recentAlerts.values().next();
        if (!oldest.done) recentAlerts.delete(oldest.value);
      }
      const foreground = AppState.currentState === "active";
      const event = notificationEventForAttentionKind(entry.kind);
      if (
        !shouldDeliverNotification(
          preferences,
          foreground ? "toast" : "system",
          event,
        )
      )
        continue;
      const hostId = key.slice(0, key.indexOf("\u0000"));
      const deepLink = agentActivityDeepLink(hostId, entry.sessionId);
      if (foreground && isAgentThreadOnScreen(deepLink)) continue;
      const thread = app.threads.thread(hostId, entry.sessionId);
      const sound =
        !foreground && shouldDeliverNotification(preferences, "sound", event);
      void Notifications.scheduleNotificationAsync({
        identifier,
        content: {
          title: ALERT_TITLE[entry.kind],
          body: thread ? threadTitle(thread.record) : undefined,
          sound,
          data: { deepLink, silent: !sound, ephemeral: foreground },
        },
        trigger:
          Platform.OS === "android"
            ? { channelId: sound ? "agent-alerts" : "agent-alerts-silent" }
            : null,
      }).catch(() => {});
    }
  });
}
