// Adapted from T3 Code apps/mobile/src/features/settings/SettingsNotificationsRouteScreen.tsx (MIT, see UPSTREAM.md).
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import {
  APP_NOTICE_EVENTS,
  NOTIFICATION_CHANNELS,
  SESSION_NOTIFICATION_EVENTS,
} from "@solus/contracts/notification-types";
import type { PersonalSettings } from "@solus/contracts/settings";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import type { ScreenProps } from "../../navigation/routes";
import { SettingsNote } from "./components/SettingsNote";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import {
  APP_NOTICE_LABELS,
  NOTIFICATION_CHANNEL_LABELS,
  SESSION_EVENT_LABELS,
} from "./lib/settings-labels";

/**
 * What you are told about, and how: the person's own choice (plans/018), not
 * one host's. Two axes, as on the desktop: a notification goes out only when
 * its event is on and its channel is on. This device's permission to show
 * notifications stays with the device.
 */
export function NotificationSettingsScreen(_props: ScreenProps<"NotificationSettings">) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const { channels, events } = useListened(
    app.personal.changes,
    app.personal.current,
  ).notifications;
  const liveActivities = useListened(app.liveActivity.changes, app.liveActivity.enabled);
  const update = (change: (next: PersonalSettings["notifications"]) => void) => {
    const next = structuredClone(app.personal.current().notifications);
    change(next);
    app.personal.set({ notifications: next });
  };

  return (
    <SettingsScreen title="Notifications">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="gap-3">
          <SettingsSection title="Delivery">
            {NOTIFICATION_CHANNELS.map((channel) => (
              <SettingsSwitchRow
                key={channel}
                label={NOTIFICATION_CHANNEL_LABELS[channel]}
                value={channels[channel]}
                onValueChange={(on) =>
                  update((next) => {
                    next.channels[channel] = on;
                  })
                }
              />
            ))}
          </SettingsSection>
          <SettingsNote>How your clients alert you.</SettingsNote>
        </View>

        <View className="gap-3">
          <SettingsSection title="Session events">
            {SESSION_NOTIFICATION_EVENTS.map((event) => (
              <SettingsSwitchRow
                key={event}
                label={SESSION_EVENT_LABELS[event]}
                value={events[event]}
                onValueChange={(on) =>
                  update((next) => {
                    next.events[event] = on;
                  })
                }
              />
            ))}
          </SettingsSection>
          <SettingsNote>What an agent did. Delivered through the channels above.</SettingsNote>
        </View>

        <View className="gap-3">
          <SettingsSection title="Workspace notices">
            {APP_NOTICE_EVENTS.map((event) => (
              <SettingsSwitchRow
                key={event}
                label={APP_NOTICE_LABELS[event]}
                value={events[event]}
                onValueChange={(on) =>
                  update((next) => {
                    next.events[event] = on;
                  })
                }
              />
            ))}
          </SettingsSection>
          <SettingsNote>Things that happen around your work. Always shown in the app.</SettingsNote>
        </View>

        {Platform.OS === "ios" ? (
          <View className="gap-3">
            <SettingsSection title="This device">
              <SettingsSwitchRow
                label="Live Activities"
                value={liveActivities}
                onValueChange={(on) => app.liveActivity.set(on)}
              />
            </SettingsSection>
            <SettingsNote>
              Agent work on the Lock Screen and in the Dynamic Island: titles and status only. It
              updates while Solus is open; after 10 minutes without an update it shows as out of date.
            </SettingsNote>
          </View>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}
