// Adapted from T3 Code apps/mobile/src/features/settings/SettingsRouteScreen.tsx (MIT, see UPSTREAM.md).
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import type { ScreenProps } from "../../navigation/routes";
import { hostMachineKind } from "../connection/lib/host-connection-status";
import { ENVIRONMENT_MACHINE_SYMBOLS } from "../../components/EnvironmentMachineSymbol";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen as SettingsScreenFrame } from "./components/SettingsScreen";
import { APPEARANCE_LABELS, SYNC_STATE_LABELS } from "./lib/settings-labels";

/**
 * Settings by owner (plans/018 §7), in T3's settings layout: this device's
 * connections; yours, which follow you to every host and, with sync, every
 * device; each organization's; and each host's own. Personal settings need no
 * host.
 */
export function SettingsScreen(props: ScreenProps<"Settings">) {
  const content = <SettingsIndex {...props} />;
  return Platform.OS === "android" ? (
    <SettingsScreenFrame title="Settings">{content}</SettingsScreenFrame>
  ) : (
    content
  );
}

function SettingsIndex({ navigation }: ScreenProps<"Settings">) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const hosts = useListened(app.registry.changes, app.registry.hosts);
  const account = useListened(app.account.changes, () => app.account.view);
  const directory = useListened(app.account.changes, () => app.account.directory);
  const organizationId = useListened(app.account.changes, () => app.account.organizationId);
  const appearance = useListened(app.appearance.changes, app.appearance.current);
  const sync = useListened(app.personalSync.changes, app.personalSync.current);
  const organizationName =
    directory.kind === "loaded"
      ? directory.organizations.find(
          (organization) => organization.organizationId === organizationId,
        )?.name
      : undefined;
  const accountLabel =
    account.kind === "loading"
      ? "Checking"
      : account.kind === "signed-in"
        ? account.profile.email
        : "Sign in";

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Connections">
          <SettingsRow
            icon="person.crop.circle"
            label="Solus Cloud"
            value={accountLabel}
            disabled={account.kind === "loading"}
            onPress={() =>
              navigation.navigate(account.kind === "signed-in" ? "CloudHosts" : "CloudSignIn")
            }
          />
          <SettingsRow
            icon="desktopcomputer"
            label="Hosts"
            value={`${hosts.length}`}
            valuePosition="trailing"
            onPress={() => navigation.navigate("Hosts")}
          />
          <SettingsRow
            icon={{ ios: "tray", android: "chat_bubble" }}
            label="Inbox"
            accessibilityHint="Opens your notifications"
            onPress={() => navigation.navigate("Notifications")}
          />
        </SettingsSection>

        <SettingsSection title="Personal">
          <SettingsRow
            icon="arrow.clockwise"
            label="Sync"
            value={SYNC_STATE_LABELS[sync.state]}
            accessibilityHint="Sync your settings with your account"
            onPress={() => navigation.navigate("PersonalSettings")}
          />
          <SettingsRow
            icon="paintbrush"
            label="Appearance"
            value={APPEARANCE_LABELS[appearance]}
            onPress={() => navigation.navigate("AppearanceSettings")}
          />
          <SettingsRow
            icon={{ ios: "sparkles", android: "auto_awesome" }}
            label="Agent defaults"
            accessibilityHint="Default agent, model, permissions, and limits"
            onPress={() => navigation.navigate("AgentDefaults")}
          />
          <SettingsRow
            icon="bell.badge"
            label="Notifications"
            accessibilityHint="What you are told about, and how"
            onPress={() => navigation.navigate("NotificationSettings")}
          />
        </SettingsSection>

        {account.kind === "signed-in" ? (
          <SettingsSection title="Organization">
            <SettingsRow
              icon="person.2"
              label="Organization"
              value={organizationName}
              onPress={() =>
                navigation.navigate(
                  "OrganizationSettings",
                  organizationId ? { organizationId } : undefined,
                )
              }
            />
          </SettingsSection>
        ) : null}

        {hosts.length > 0 ? (
          <SettingsSection title="Host settings">
            {hosts.map((host) => (
              <SettingsRow
                key={host.id}
                icon={ENVIRONMENT_MACHINE_SYMBOLS[hostMachineKind(host)]}
                label={host.label}
                onPress={() => navigation.navigate("HostSettings", { hostId: host.id })}
              />
            ))}
          </SettingsSection>
        ) : null}

        <SettingsSection title="App">
          <SettingsRow
            icon="info.circle"
            label="About Solus"
            onPress={() => navigation.navigate("About")}
          />
        </SettingsSection>
      </ScrollView>
    </View>
  );
}
