import type { Notification, NotificationBehavior } from "expo-notifications";
import { Platform } from "react-native";

import { extractAgentNotificationDeepLink } from "./notificationPayload";

const SHOW: NotificationBehavior = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
};

const SUPPRESS: NotificationBehavior = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

export function foregroundNotificationBehavior(
  notification: Notification,
  deepLinkOnScreen: string | null,
): NotificationBehavior {
  const target = extractAgentNotificationDeepLink({ notification });
  if (target !== null && target === deepLinkOnScreen) {
    return SUPPRESS;
  }
  const { data } = notification.request.content;
  return {
    ...SHOW,
    shouldShowList: data?.ephemeral !== true,
    // Android needs this flag for heads-up display. Its silent channel controls audio.
    shouldPlaySound: Platform.OS === "android" || data?.silent !== true,
  };
}
