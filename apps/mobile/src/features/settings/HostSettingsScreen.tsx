// Adapted from T3 Code apps/mobile/src/features/settings/SettingsEnvironmentDetailRouteScreen.tsx (MIT, see UPSTREAM.md).
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import type { ScreenProps } from "../../navigation/routes";
import { ConnectionEnvironmentRow } from "../connection/ConnectionEnvironmentRow";
import { confirmForgetHost } from "../hosts/confirm-forget-host";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsNote } from "./components/SettingsNote";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsValueRow } from "./components/SettingsValueRow";
import { accountConnectionValue } from "./lib/account-connections";
import { retentionDayChoices, retentionDaysLabel } from "./lib/retention-choices";
import { hostUpdateControls, serverUpdateText, updateStatusText } from "./lib/update-status";
import { useGithubConnection } from "./use-github-connection";
import { hostSettingsErrorText } from "./host-settings";
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
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness);
  const hostReadiness = useListened(app.connections.changes, () => app.connections.readiness(hostId));
  const github = useGithubConnection(hostId);
  const { state, reload, update } = useHostSettings(hostId);
  const hostUpdate = useHostUpdateStatus(hostId);
  const { version, status } = hostUpdate;
  const isAdmin = useListened(app.connections.changes, () => app.connections.may(hostId, "host.admin"));
  const updateControls = hostUpdateControls(status, isAdmin);
  const operation = status?.serverUpdate?.operation ?? null;
  // Unset follows the connection: a host that failed to connect opens with
  // Reconnect and Forget in view; a tap then decides.
  const [connectionToggled, setConnectionToggled] = useState<boolean | null>(null);
  const connected = readiness === "ready";
  const connectionFailed =
    readiness !== undefined && readiness !== "ready" && readiness !== "checking" && readiness !== "reconnecting";
  const connectionExpanded = connectionToggled ?? connectionFailed;

  const githubValue =
    github.view.kind === "account"
      ? accountConnectionValue(github.view.status)
      : github.view.kind === "connected"
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
                    confirmForgetHost(app, target, () => navigation.goBack())
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

            <SettingsSection title="MCP">
              <SettingsRow
                icon="point.3.connected.trianglepath.dotted"
                label="MCP"
                value="MCP servers"
                onPress={() => navigation.navigate("Integrations", { hostId })}
              />
            </SettingsSection>

            <View className="gap-3">
              <SettingsSection title="Solus">
                <SettingsValueRow
                  icon="info.circle"
                  label="Version"
                  value={version}
                  detail={
                    operation && operation.phase !== "succeeded"
                      ? serverUpdateText(operation)
                      : status
                        ? updateStatusText(status)
                        : undefined
                  }
                />
                {updateControls.canCheck ? (
                  <SettingsActionRow
                    icon="arrow.clockwise"
                    label="Check for updates"
                    disabled={hostUpdate.requesting}
                    onPress={hostUpdate.check}
                  />
                ) : null}
                {updateControls.action.kind === "update" ? (
                  <SettingsActionRow
                    icon="arrow.up.circle"
                    label={
                      updateControls.action.retry
                        ? "Retry update"
                        : `Update to ${updateControls.action.version}`
                    }
                    disabled={hostUpdate.requesting}
                    loading={hostUpdate.requesting}
                    onPress={() => {
                      const action = updateControls.action;
                      if (action.kind !== "update") return;
                      Alert.alert(
                        `Update ${host.label}?`,
                        `Solus ${action.version} installs on this host. The host waits for running work to finish, then restarts and reconnects.`,
                        [
                          { text: "Cancel", style: "cancel" },
                          { text: "Update", onPress: hostUpdate.install },
                        ],
                      );
                    }}
                  />
                ) : updateControls.action.kind === "cancel" ? (
                  <SettingsActionRow
                    icon="xmark"
                    label="Cancel update"
                    tone="danger"
                    disabled={hostUpdate.requesting}
                    loading={hostUpdate.requesting}
                    onPress={hostUpdate.cancel}
                  />
                ) : null}
              </SettingsSection>
              {updateControls.action.kind === "manual" ? (
                <SettingsNote>{updateControls.action.text}</SettingsNote>
              ) : updateControls.action.kind === "limited" ? (
                <SettingsNote>
                  Limited permissions: only a host administrator can update Solus on this host.
                </SettingsNote>
              ) : null}
              {hostUpdate.error ? <SettingsNote tone="danger">{hostUpdate.error}</SettingsNote> : null}
            </View>

            {state.kind === "loaded" ? (
              <>
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
                <View className="gap-3">
                  <SettingsSection title="Delete unfiled recordings after">
                    {retentionDayChoices(state.settings.unfiledRecordingRetentionDays).map((days, index) => (
                      <SettingsChoiceRow
                        key={days}
                        separated={index > 0}
                        label={retentionDaysLabel(days)}
                        selected={state.settings.unfiledRecordingRetentionDays === days}
                        onPress={() => update({ unfiledRecordingRetentionDays: days })}
                      />
                    ))}
                  </SettingsSection>
                  <SettingsNote>
                    The host keeps a browser recording that is filed on a task or pull request, or
                    sent to an agent. It deletes other recordings after this time.
                  </SettingsNote>
                </View>
              </>
            ) : state.kind === "error" ? (
              <View className="gap-3">
                <ErrorBanner message={hostSettingsErrorText(state.message, hostReadiness, host.label)} />
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
              <SettingsNote>
                {github.view.kind === "account"
                  ? "Pull requests on this host use the GitHub connection in your Solus account."
                  : "Pull requests on this host use its GitHub connection."}
              </SettingsNote>
            </View>
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
