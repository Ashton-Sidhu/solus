import { useSyncExternalStore } from "react";
import { Alert } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { SettingsScreen } from "../features/settings/components/SettingsScreen";
import { SettingsSection } from "../features/settings/components/SettingsSection";
import { SettingsRow } from "../features/settings/components/SettingsRow";
import { SettingsSwitchRow } from "../features/settings/components/SettingsSwitchRow";
import { ScreenScrollView } from "../components/ui/ScreenScrollView";
import {
  PERMISSION_MODE_TEXT,
  PERMISSION_MODES,
  PROVIDERS,
} from "@solus-mobile/features/conversation/lib/run-settings";
import { nearby, solus, useSolusDirectory } from "./runtime";

export function SolusHosts() {
  const navigation = useNavigation();
  const { environments } = useSolusDirectory();
  return (
    <SettingsScreen title="Environments">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 py-4"
      >
        <SettingsSection title="Local environments">
          {environments.map((env) => (
            <SettingsRow
              key={env.environmentId}
              icon="desktopcomputer"
              label={env.environmentLabel}
              value={[env.displayUrl, env.connectionState].filter(Boolean).join(" · ")}
              onPress={() =>
                Alert.alert(env.environmentLabel, env.displayUrl, [
                  { text: "Reconnect", onPress: () => solus.connections.retry(env.environmentId) },
                  {
                    text: "Forget",
                    style: "destructive",
                    onPress: () =>
                      void solus.registry
                        .forget(env.environmentId)
                        .then(() => nearby.skipAutomaticPairing(env.environmentId))
                        .catch((error: Error) =>
                          Alert.alert("Could not forget host", error.message),
                        ),
                  },
                  { text: "Cancel", style: "cancel" },
                ])
              }
            />
          ))}
          <SettingsRow
            icon="plus"
            label="Add environment"
            onPress={() => navigation.navigate("SettingsEnvironmentNew")}
          />
        </SettingsSection>
      </ScreenScrollView>
    </SettingsScreen>
  );
}

export function SolusSessionSettings() {
  const settings = useSyncExternalStore(solus.personal.changes.subscribe, solus.personal.current);
  return (
    <SettingsScreen title="Threads">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 py-4"
      >
        <SettingsSection title="Default agent">
          {PROVIDERS.map((provider) => (
            <SettingsRow
              key={provider.id}
              icon={settings.activeAgent === provider.id ? "checkmark" : "circle"}
              label={provider.label}
              onPress={() => solus.personal.set({ activeAgent: provider.id })}
            />
          ))}
        </SettingsSection>
        <SettingsSection title="Default permissions">
          {PERMISSION_MODES.map((mode) => (
            <SettingsRow
              key={mode}
              icon={settings.defaultPermissionMode === mode ? "checkmark" : "circle"}
              label={PERMISSION_MODE_TEXT[mode].label}
              onPress={() => solus.personal.set({ defaultPermissionMode: mode })}
            />
          ))}
        </SettingsSection>
        <SettingsSection>
          <SettingsSwitchRow
            icon="pencil"
            label="Name new sessions"
            value={settings.autoRenameSessions}
            onValueChange={(autoRenameSessions) => solus.personal.set({ autoRenameSessions })}
          />
        </SettingsSection>
      </ScreenScrollView>
    </SettingsScreen>
  );
}
