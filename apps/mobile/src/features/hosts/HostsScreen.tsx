// Adapted from T3 Code apps/mobile/src/features/settings/SettingsEnvironmentsRouteScreen.tsx (MIT, see UPSTREAM.md).
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useEffect } from "react";
import { RefreshControl } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type { ScreenProps } from "../../navigation/routes";
import { CloudEnvironmentRows } from "../connection/CloudEnvironmentRows";
import { LocalEnvironmentList } from "../connection/LocalEnvironmentList";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { confirmForgetHost } from "./confirm-forget-host";

/**
 * Every host this device knows, its live state, and the way into each: hosts
 * paired on this device first, then the hosts Solus Cloud lists for the
 * account. A row opens the host's settings, where it is reconnected or forgotten.
 */
export function HostsScreen({ navigation }: ScreenProps<"Hosts">) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const hosts = useListened(app.registry.changes, app.registry.hosts);
  const account = useListened(app.account.changes, () => app.account.view);
  const directory = useListened(app.account.changes, () => app.account.directory);
  const headerIconColor = useUniwindTheme()["--color-icon"];
  const signedIn = account.kind === "signed-in";
  const localHosts = hosts.filter((host) => !host.uplink);
  const cloudHosts = hosts.filter((host) => host.uplink);

  useEffect(() => {
    // Saved hosts are eagerly connected, as on desktop and web.
    for (const host of hosts) app.connections.connection(host.id);
  }, [app, hosts]);

  useEffect(() => {
    if (signedIn && app.account.directory.kind === "idle") void app.account.refreshDirectory();
  }, [app, signedIn]);

  return (
    <SettingsScreen
      title="Hosts"
      actions={[
        {
          accessibilityLabel: "Add host",
          icon: "plus",
          tintColor: headerIconColor,
          onPress: () => navigation.navigate("PairHost"),
        },
      ]}
    >
      <ScrollView
        alwaysBounceVertical
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
        refreshControl={
          signedIn ? (
            <RefreshControl
              refreshing={directory.kind === "loading"}
              onRefresh={() => void app.account.refreshDirectory()}
            />
          ) : undefined
        }
      >
        {signedIn || cloudHosts.length > 0 ? (
          <Text className="mb-3 px-1 text-sm font-t3-bold uppercase text-foreground-muted">
            Paired hosts
          </Text>
        ) : null}
        <LocalEnvironmentList
          hosts={localHosts}
          onAdd={() => navigation.navigate("PairHost")}
          expandedId={null}
          onToggle={(hostId) => navigation.navigate("HostSettings", { hostId })}
          opensDetails
          onReconnect={(hostId) => app.connections.retry(hostId)}
          onRemove={(host) => confirmForgetHost(host, () => void app.registry.forget(host.id))}
        />

        {/* Hosts the directory listed stay visible even after sign-out until
            the registry drops them; only the directory read needs an account. */}
        {signedIn || cloudHosts.length > 0 ? (
          <CloudEnvironmentRows
            hosts={cloudHosts}
            onOpenHost={(host) => navigation.navigate("HostSettings", { hostId: host.id })}
          />
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}
