// Adapted from T3 Code apps/mobile/src/features/settings/SettingsEnvironmentDetailRouteScreen.tsx (MIT, see UPSTREAM.md).
import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import type { ScreenProps } from "../../navigation/routes";
import { ConnectionEnvironmentRow } from "../connection/ConnectionEnvironmentRow";
import { confirmForgetHost } from "../hosts/confirm-forget-host";
import { SettingsNote } from "./components/SettingsNote";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsValueRow } from "./components/SettingsValueRow";
import { updateStatusText } from "./lib/update-status";
import { useGithubConnection } from "./use-github-connection";
import { useHostSettings } from "./use-host-settings";
import { useHostUpdateStatus } from "./use-host-update-status";

/**
 * One host: its connection, a way into its Access screen, its Solus version, and its own settings, which
 * every device using the host shares. Your agent defaults and notifications
 * are personal and live under Personal; a host never holds them (plans/018).
 */
export function HostSettingsScreen({ navigation, route }: ScreenProps<"HostSettings">) {
  const { hostId } = route.params;
  const app = useApp();
  const insets = useSafeAreaInsets();
  const host = useListened(app.registry.changes, () => app.registry.host(hostId));
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase);
  const github = useGithubConnection(hostId);
  const { state, reload, update } = useHostSettings(hostId);
  const { version, status } = useHostUpdateStatus(hostId);
  // Unset follows the connection: a host that failed to connect opens with
  // Reconnect and Forget in view; a tap then decides.
  const [connectionToggled, setConnectionToggled] = useState<boolean | null>(null);
  const connected = phase === "connected";
  const connectionFailed =
    phase !== undefined && phase !== "connected" && phase !== "connecting" && phase !== "reconnecting";
  const connectionExpanded = connectionToggled ?? connectionFailed;

  const githubValue =
    github.view.kind === "connected"
      ? (github.view.login ?? "Connected")
      : github.view.kind === "disconnected"
        ? "Not connected"
        : github.view.kind === "error"
          ? "Unavailable"
          : github.view.kind === "connecting"
            ? "Connecting…"
            : undefined;

  return (
    <SettingsScreen title={host?.label ?? "Host"}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!host ? (
          <Text className="text-base text-foreground-muted">
            This host is no longer saved on this device.
          </Text>
        ) : (
          <>
            <View className="gap-3">
              <SettingsSection title="Connection">
                <ConnectionEnvironmentRow
                  host={host}
                  expanded={connectionExpanded}
                  onToggle={() => setConnectionToggled(!connectionExpanded)}
                  onReconnect={(id) => app.connections.retry(id)}
                  onRemove={(target) =>
                    confirmForgetHost(target, () => {
                      void app.registry.forget(target.id);
                      navigation.goBack();
                    })
                  }
                />
              </SettingsSection>
              {!connected ? <SettingsNote>Connect this host to manage it.</SettingsNote> : null}
            </View>

            <SettingsSection title="Access">
              <SettingsRow
                icon="person.2"
                label="Access"
                value="Solus Cloud, network, pairing, and devices"
                onPress={() => navigation.navigate("HostAccess", { hostId })}
              />
            </SettingsSection>

            <SettingsSection title="Devices">
              <SettingsRow
                icon="hammer"
                label="App builds"
                onPress={() => navigation.navigate("Builds", { hostId })}
              />
            </SettingsSection>

            <SettingsSection title="Integrations">
              <SettingsRow
                icon="point.3.connected.trianglepath.dotted"
                label="Integrations"
                value="Remote MCP servers"
                onPress={() => navigation.navigate("Integrations", { hostId })}
              />
            </SettingsSection>

            <SettingsSection title="Solus">
              <SettingsValueRow
                icon="info.circle"
                label="Version"
                value={version}
                detail={status ? updateStatusText(status) : undefined}
              />
            </SettingsSection>

            {state.kind === "loaded" ? (
              <View className="gap-3">
                <SettingsSection title="Sessions">
                  <SettingsSwitchRow
                    icon="arrow.clockwise"
                    label="Continue sessions after restart"
                    value={state.settings.continueSessionsAfterHostRestart}
                    onValueChange={(next) => update({ continueSessionsAfterHostRestart: next })}
                  />
                </SettingsSection>
                <SettingsNote>
                  When the host restarts, it resumes the turns that were running. Every device using
                  this host shares this setting.
                </SettingsNote>
              </View>
            ) : state.kind === "error" ? (
              <View className="gap-3">
                <ErrorBanner message={`Settings could not be read: ${state.message}`} />
                <Pressable
                  accessibilityRole="button"
                  onPress={reload}
                  className="self-start rounded-full bg-subtle px-3.5 py-2 active:opacity-70"
                >
                  <Text className="text-xs font-t3-bold text-foreground">Try again</Text>
                </Pressable>
              </View>
            ) : connected ? (
              <View className="items-center py-2">
                <ActivityIndicator
                  accessibilityLabel="Reading settings"
                  colorClassName="accent-icon-muted"
                />
              </View>
            ) : null}

            <View className="gap-3">
              <SettingsSection title="Source control">
                <SettingsRow
                  icon="arrow.triangle.branch"
                  label="GitHub"
                  value={githubValue}
                  onPress={() => navigation.navigate("GitHubConnection", { hostId })}
                />
              </SettingsSection>
              <SettingsNote>Pull requests on this host use its GitHub connection.</SettingsNote>
            </View>
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
