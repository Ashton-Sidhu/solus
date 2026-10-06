// Adapted from T3 Code apps/mobile/src/features/cloud/ConnectOnboardingRouteScreen.tsx (MIT, see UPSTREAM.md).
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useEffect } from "react";
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView as HorizontalScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { ScreenProps } from "../../navigation/routes";
import { CloudEnvironmentRows } from "../connection/CloudEnvironmentRows";
import { ConnectionSheetButton } from "../connection/ConnectionSheetButton";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsValueRow } from "../settings/components/SettingsValueRow";
import { cloudHostsFor, cloudHostState } from "./lib/host-scope";

/**
 * The account's organizations and hosts, as T3's T3 Connect sheet shows the
 * account's environments. A first-time account with no host is told what is
 * missing and sent to the Solus setup page; this milestone does not provision
 * hosts in the app (plan 017 §1). Signing out is here too.
 */
export function CloudHostsScreen({ navigation }: ScreenProps<"CloudHosts">) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const view = useListened(app.account.changes, () => app.account.view);
  const directory = useListened(app.account.changes, () => app.account.directory);
  const organizationId = useListened(app.account.changes, () => app.account.organizationId);
  const hosts = useListened(app.registry.changes, app.registry.hosts);

  useEffect(() => {
    if (view.kind === "signed-out") navigation.replace("CloudSignIn");
  }, [navigation, view.kind]);

  useEffect(() => {
    if (app.account.directory.kind === "idle") void app.account.refreshDirectory();
  }, [app]);

  const visible = cloudHostsFor(hosts, organizationId);
  const workspaces = directory.kind === "loaded" ? directory.workspaces : [];
  const origin = view.kind === "signed-in" ? view.origin : "";

  const confirmSignOut = () =>
    Alert.alert("Sign out?", signOutMessage(app.personalSync.current().pendingKeys.length), [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => void app.account.signOut() },
    ]);

  return (
    <SettingsScreen title="Solus Cloud">
      <ScrollView
        alwaysBounceVertical
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerStyle={{
          gap: 16,
          paddingHorizontal: 20,
          paddingTop: 16,
        }}
        refreshControl={
          <RefreshControl
            refreshing={directory.kind === "loading"}
            onRefresh={() => void app.account.refreshDirectory()}
          />
        }
      >
        {workspaces.length > 1 ? (
          <HorizontalScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2"
          >
            {workspaces.map((workspace) => {
              const selected = workspace.organizationId === organizationId;
              return (
                <Pressable
                  key={workspace.organizationId}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Organization ${workspace.label}`}
                  onPress={() => app.account.selectOrganization(workspace.organizationId)}
                  className={cn(
                    "rounded-full px-3.5 py-2 active:opacity-70",
                    selected ? "bg-primary" : "bg-subtle",
                  )}
                >
                  <Text
                    className={cn(
                      "text-xs font-t3-bold",
                      selected ? "text-primary-foreground" : "text-foreground",
                    )}
                  >
                    {workspace.label}
                  </Text>
                </Pressable>
              );
            })}
          </HorizontalScrollView>
        ) : null}

        <CloudEnvironmentRows
          hosts={visible}
          showHeader={false}
          onOpenHost={(host) =>
            cloudHostState(host) === "ready"
              ? navigation.reset({ index: 0, routes: [{ name: "Home" }] })
              : navigation.navigate("HostSettings", { hostId: host.id })
          }
          emptyAction={
            <View className="gap-2">
              <ConnectionSheetButton
                compact
                icon="safari"
                label="Open Solus setup"
                tone="primary"
                onPress={() => void app.platform.openBrowser(origin)}
              />
              <ConnectionSheetButton
                compact
                icon="qrcode.viewfinder"
                label="Pair a host directly"
                tone="secondary"
                onPress={() => navigation.navigate("PairHost")}
              />
            </View>
          }
        />

        {view.kind === "signed-in" ? (
          <SettingsSection title="Account">
            <SettingsValueRow
              icon="person.crop.circle"
              label="Signed in"
              value={view.profile.email}
            />
            <SettingsRow
              icon="desktopcomputer"
              label="All hosts on this device"
              onPress={() => navigation.navigate("Hosts")}
            />
            <SettingsActionRow
              icon={{ ios: "rectangle.portrait.and.arrow.right", android: "lock" }}
              label="Sign out of Solus Cloud"
              tone="danger"
              onPress={confirmSignOut}
            />
          </SettingsSection>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}

/** Sign-out also ends settings sync here; unsent changes are named before they go (plans/018 §5). */
function signOutMessage(unsentSettings: number): string {
  const hosts = "Hosts from your account leave this device. Hosts you paired directly stay.";
  if (unsentSettings === 0) return hosts;
  return `${hosts} ${unsentSettings === 1 ? "1 settings change has" : `${unsentSettings} settings changes have`} not synced and will not reach your account.`;
}
