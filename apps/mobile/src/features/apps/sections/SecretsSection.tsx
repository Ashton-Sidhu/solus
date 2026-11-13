import { useState } from "react";
import { Alert, TextInput, View } from "react-native";

import type { HostApi } from "@solus/client-core/host-api";
import type { AppSecretState, AppState } from "@solus/contracts/apps";

import { SettingsNote } from "../../settings/components/SettingsNote";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { errorMessage } from "../../settings/integrations";
import { PillButton } from "../../webhooks/webhook-rows";
import { AppDetailRow } from "../app-rows";
import { useAppChange } from "../use-app";
import type { AppSectionProps } from "./section-props";

/**
 * Secrets (docs/plans/apps.md §4.4, §9.2): the secrets the app declares. The
 * owner gives a value in a masked field or clears it; a value is never read
 * back, so a row says only whether it is set.
 */
export function SecretsSection({ hostId, appId, state, connected, reloadState }: AppSectionProps) {
  const { secrets } = state;
  const { busy, change } = useAppChange(hostId);
  const disabled = busy !== null || !connected;
  const [editing, setEditing] = useState<{ name: string; value: string } | null>(null);

  const act = (refusal: string, run: (api: HostApi) => Promise<AppState>) => {
    change("secret", run).then(reloadState, (cause: unknown) => Alert.alert(refusal, errorMessage(cause)));
  };

  const save = () => {
    if (!editing || editing.value === "") return;
    const { name, value } = editing;
    act("Not set", (api) => api.appSecretSet({ appId, name, value }));
    setEditing(null);
  };

  const clear = (secret: AppSecretState) => {
    Alert.alert(`Clear ${secret.label}?`, "The app runs without this value until you set it again.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => act("Not cleared", (api) => api.appSecretSet({ appId, name: secret.name, value: null })),
      },
    ]);
  };

  return (
    <View className="gap-3">
      <SettingsSection title="Secrets">
        {secrets.length === 0 ? (
          <View className="px-2 py-4">
            <SettingsNote>This app declares no secret.</SettingsNote>
          </View>
        ) : (
          secrets.map((secret, index) => (
            <AppDetailRow
              key={secret.name}
              first={index === 0}
              title={secret.label}
              trailing={secret.isSet ? "Set" : "Not set"}
              trailingTone={secret.isSet ? "muted" : "danger"}
              lines={secret.description ? [{ text: secret.description }] : []}
            >
              {editing?.name === secret.name ? (
                <View className="w-full gap-2">
                  <TextInput
                    accessibilityLabel={`Value of ${secret.label}`}
                    autoFocus
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    textContentType="none"
                    placeholder="Paste the value"
                    value={editing.value}
                    onChangeText={(value) => setEditing({ name: secret.name, value })}
                    onSubmitEditing={save}
                    returnKeyType="done"
                    className="min-h-12 rounded-2xl border border-border bg-input px-3.5 py-3 font-mono text-sm text-foreground"
                  />
                  <View className="flex-row gap-2">
                    <PillButton label="Save" disabled={disabled || editing.value === ""} onPress={save} />
                    <PillButton label="Cancel" onPress={() => setEditing(null)} />
                  </View>
                </View>
              ) : (
                <>
                  <PillButton
                    label={secret.isSet ? "Replace" : "Set"}
                    disabled={disabled}
                    onPress={() => setEditing({ name: secret.name, value: "" })}
                  />
                  {secret.isSet ? <PillButton label="Clear" disabled={disabled} onPress={() => clear(secret)} /> : null}
                </>
              )}
            </AppDetailRow>
          ))
        )}
      </SettingsSection>
      {secrets.length > 0 ? <SettingsNote>A value stays on the host. No client and no agent reads it back.</SettingsNote> : null}
    </View>
  );
}
