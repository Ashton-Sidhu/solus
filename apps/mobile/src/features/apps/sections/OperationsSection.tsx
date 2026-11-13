import { Alert, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { ListRow } from "../../../components/ListRow";
import { SettingsNote } from "../../settings/components/SettingsNote";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../../settings/components/SettingsSwitchRow";
import { errorMessage } from "../../settings/integrations";
import { operationKindLabel } from "../apps";
import { useAppChange } from "../use-app";
import type { AppSectionProps } from "./section-props";

/**
 * Operations (docs/plans/apps.md §7.1, §9.2): whether the app's operations
 * are tools for agents, each operation the active version declares, and the
 * instructions the app ships for the agents that use it. An operation opens
 * its schemas and a form to run it.
 */
export function OperationsSection({ hostId, appId, state, connected, reloadState, navigation }: AppSectionProps) {
  const { app: summary, descriptor } = state;
  const { busy, change } = useAppChange(hostId);
  const disabled = busy !== null || !connected;

  const setAgentAccess = (enabled: boolean) => {
    change("agent-access", (api) => api.appSetAgentAccess({ appId, enabled })).then(reloadState, (cause: unknown) =>
      Alert.alert(enabled ? "Not turned on" : "Not turned off", errorMessage(cause)),
    );
  };

  return (
    <>
      <View className="gap-3">
        <SettingsSection title="Agents">
          <SettingsSwitchRow
            icon="sparkles"
            label="Agent access"
            subtitle={summary.agentAccess ? "Agents see each operation as a tool." : "No agent sees an operation of this app."}
            value={summary.agentAccess}
            disabled={disabled}
            onValueChange={setAgentAccess}
          />
        </SettingsSection>
        <SettingsNote>The UI, the schedules, the webhooks, and the workflows of the app call its operations with agent access on or off.</SettingsNote>
      </View>

      {!descriptor ? (
        <SettingsNote>No version of this app is active, so it has no operation.</SettingsNote>
      ) : (
        <>
          <SettingsSection title="Operations">
            {descriptor.operations.length === 0 ? (
              <View className="px-2 py-4">
                <SettingsNote>This app declares no operation.</SettingsNote>
              </View>
            ) : (
              descriptor.operations.map((operation) => (
                <ListRow
                  key={operation.name}
                  label={operation.name}
                  description={operation.description || undefined}
                  detail={operationKindLabel(operation.kind)}
                  onPress={() => navigation.navigate("AppOperation", { hostId, appId, operation: operation.name })}
                />
              ))
            )}
          </SettingsSection>
          <SettingsSection title="Instructions for agents">
            <View className="p-4">
              {descriptor.instructions ? (
                <Text selectable className="text-sm leading-normal text-foreground">
                  {descriptor.instructions}
                </Text>
              ) : (
                <SettingsNote>This app ships no instructions.</SettingsNote>
              )}
            </View>
          </SettingsSection>
        </>
      )}
    </>
  );
}
