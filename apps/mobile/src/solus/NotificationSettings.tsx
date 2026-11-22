// Adapted from T3 Code apps/mobile/src/features/settings/SettingsNotificationsRouteScreen.tsx (MIT, see UPSTREAM.md).
import { ScreenScrollView as ScrollView } from "../components/ui/ScreenScrollView";
import {
  APP_NOTICE_EVENTS,
  NOTIFICATION_CHANNELS,
  SESSION_NOTIFICATION_EVENTS,
} from "@solus/contracts/notification-types";
import type { PersonalSettings } from "@solus/contracts/settings";
import { Linking, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useListened } from "@solus-mobile/app/app-context";
import { solus as app } from "./runtime";

import { SettingsRow } from "../features/settings/components/SettingsRow";
import { AppText as Text } from "../components/ui/AppText";
import { SettingsScreen } from "../features/settings/components/SettingsScreen";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { SettingsSwitchRow } from "../features/settings/components/SettingsSwitchRow";
import {
  APP_NOTICE_LABELS,
  NOTIFICATION_CHANNEL_LABELS,
  SESSION_EVENT_LABELS,
} from "./settings-labels";

type NotificationPreferences = PersonalSettings["notifications"];

/**
 * What you are told about, and how: the person's own choice (plans/018), not
 * one host's. Two axes, as on the desktop: a notification goes out only when
 * its event is on and its channel is on. This device's permission to show
 * notifications stays with the device.
 */
export function NotificationSettingsScreen() {
  const insets = useSafeAreaInsets();
  const liveActivities = useListened(app.liveActivity.changes, app.liveActivity.enabled);

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
          <SettingsSection title="Agent activity">
            {Platform.OS === "ios" ? (
              <SettingsSwitchRow
                icon="bolt.circle"
                label="Live Activity Updates"
                subtitle="Show agent work on the Lock Screen and in the Dynamic Island."
                value={liveActivities}
                onValueChange={(on) => app.liveActivity.set(on)}
              />
            ) : null}
            <SettingsRow
              icon="gearshape"
              label="Open system settings"
              onPress={() => void Linking.openSettings()}
            />
          </SettingsSection>
          <Text className="px-2 text-sm text-foreground-muted">
            {Platform.OS === "ios"
              ? "iOS must also allow Live Activities for Solus. Linked hosts update activity while the app is closed. After 10 minutes without an update, activity shows as out of date."
              : "Open system settings to manage notification access for this device."}
          </Text>
        </View>

        <View className="gap-3">
          <SettingsSection title="Delivery">
            {NOTIFICATION_CHANNELS.map((channel) => (
              <NotificationSwitchRow
                key={channel}
                label={NOTIFICATION_CHANNEL_LABELS[channel]}
                read={(notifications) => notifications.channels[channel]}
                write={(next, on) => {
                  next.channels[channel] = on;
                }}
              />
            ))}
          </SettingsSection>
          <Text className="px-2 text-sm text-foreground-muted">How your clients alert you.</Text>
        </View>

        <View className="gap-3">
          <SettingsSection title="Session events">
            {SESSION_NOTIFICATION_EVENTS.map((event) => (
              <NotificationSwitchRow
                key={event}
                label={SESSION_EVENT_LABELS[event]}
                read={(notifications) => notifications.events[event]}
                write={(next, on) => {
                  next.events[event] = on;
                }}
              />
            ))}
          </SettingsSection>
          <Text className="px-2 text-sm text-foreground-muted">
            What an agent did. Delivered through the channels above.
          </Text>
        </View>

        <View className="gap-3">
          <SettingsSection title="Workspace notices">
            {APP_NOTICE_EVENTS.map((event) => (
              <NotificationSwitchRow
                key={event}
                label={APP_NOTICE_LABELS[event]}
                read={(notifications) => notifications.events[event]}
                write={(next, on) => {
                  next.events[event] = on;
                }}
              />
            ))}
          </SettingsSection>
          <Text className="px-2 text-sm text-foreground-muted">
            Things that happen around your work. Always shown in the app.
          </Text>
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}

/**
 * One switch. It reads only its own value, so turning one on, or a change to
 * another setting, re-renders this row and not the page.
 */
function NotificationSwitchRow(props: {
  readonly label: string;
  readonly read: (notifications: NotificationPreferences) => boolean;
  readonly write: (next: NotificationPreferences, on: boolean) => void;
}) {
  const value = useListened(app.personal.changes, () =>
    props.read(app.personal.current().notifications),
  );
  return (
    <SettingsSwitchRow
      label={props.label}
      value={value}
      onValueChange={(on) => {
        const next = structuredClone(app.personal.current().notifications);
        props.write(next, on);
        app.personal.set({ notifications: next });
      }}
    />
  );
}
