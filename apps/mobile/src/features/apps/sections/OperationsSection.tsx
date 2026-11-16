import { useCallback } from "react";
import { Alert, View } from "react-native";

import type { HostApi } from "@solus/client-core/host-api";
import { operationCallersText, operationKindLabel } from "@solus/client-core/app-operations";

import { AppText as Text } from "../../../components/AppText";
import { ListRow } from "../../../components/ListRow";
import { SettingsNote } from "../../settings/components/SettingsNote";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../../settings/components/SettingsSwitchRow";
import { errorMessage } from "../../settings/integrations";
import { operationCallsText } from "../app-activity";
import { useAppChange, useAppRead } from "../use-app";
import type { AppSectionProps } from "./section-props";

/**
 * Operations (docs/plans/apps.md §7.1, §9.2): the actions the app can take,
 * who calls them, and each one's calls of the last 24 hours; then whether
 * they are tools for agents, and the instructions the app ships for those
 * agents. An operation opens what it takes and answers, and a form to run it.
 */
export function OperationsSection({ hostId, appId, state, connected, reloadState, navigation }: AppSectionProps) {
  const { app: summary, descriptor } = state;
  const { busy, change } = useAppChange(hostId);
  const disabled = busy !== null || !connected;
  const readMetrics = useCallback((api: HostApi) => api.appMetrics({ appId }), [appId]);
  const metrics = useAppRead(hostId, appId, "metrics", readMetrics);
  const callsOf = (operation: string) => (metrics.state.kind === "loaded" ? operationCallsText(metrics.state.value, operation) : undefined);

  const setAgentAccess = (enabled: boolean) => {
    change("agent-access", (api) => api.appSetAgentAccess({ appId, enabled })).then(reloadState, (cause: unknown) =>
      Alert.alert(enabled ? "Not turned on" : "Not turned off", errorMessage(cause)),
    );
  };

  return (
    <>
      {!descriptor ? (
        <SettingsNote>No version of this app is active, so it has no operation.</SettingsNote>
      ) : (
        <View className="gap-3">
          <SettingsSection title="Operations">
            {descriptor.operations.length === 0 ? (
              <View className="px-2 py-4">
                <SettingsNote>This app declares no operation.</SettingsNote>
              </View>
            ) : (
              descriptor.operations.map((operation) => (
                <ListRow
                  key={operation.name}
                  icon={operation.kind === "query" ? "doc.text" : "square.and.pencil"}
                  label={operation.name}
                  description={[operationKindLabel(operation.kind), operation.description].filter(Boolean).join(" · ")}
                  detail={callsOf(operation.name)}
                  onPress={() => navigation.navigate("AppOperation", { hostId, appId, operation: operation.name })}
                />
              ))
            )}
          </SettingsSection>
          <SettingsNote>
            {`The actions this app can take. ${operationCallersText({
              hasUi: summary.hasUi,
              schedules: descriptor.schedules.length,
              webhooks: descriptor.webhooks.length,
              workflows: descriptor.workflows.length,
              agentAccess: summary.agentAccess,
            })} The count is the calls of the last 24 hours.`}
          </SettingsNote>
        </View>
      )}

      <View className="gap-3">
        <SettingsSection title="Agents">
          <SettingsSwitchRow
            icon="sparkles"
            label="Agent access"
            subtitle={summary.agentAccess ? "Agents can call these operations." : "Agents cannot call these operations."}
            value={summary.agentAccess}
            disabled={disabled}
            onValueChange={setAgentAccess}
          />
        </SettingsSection>
        <SettingsNote>
          With agent access on, each operation is a tool that agents on this host can call. The app's UI, schedules, webhooks, and workflows call them either
          way.
        </SettingsNote>
      </View>

      {descriptor?.instructions ? (
        <View className="gap-3">
          <SettingsSection title="Instructions for agents">
            <View className="p-4">
              <Text selectable className="text-sm leading-normal text-foreground">
                {descriptor.instructions}
              </Text>
            </View>
          </SettingsSection>
          <SettingsNote>What the app tells an agent before it calls an operation.</SettingsNote>
        </View>
      ) : null}
    </>
  );
}
