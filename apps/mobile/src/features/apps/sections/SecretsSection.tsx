import { useState } from "react";
import { Alert, Pressable, TextInput, View } from "react-native";

import type { HostApi } from "@solus/client-core/host-api";
import type { AppSecretState, AppState } from "@solus/contracts/apps";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { cn } from "../../../lib/cn";
import { SettingsNote } from "../../settings/components/SettingsNote";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { errorMessage } from "../../settings/integrations";
import { PillButton } from "../../webhooks/webhook-rows";
import { AppStateMark } from "../app-rows";
import { useAppChange } from "../use-app";
import type { AppSectionProps } from "./section-props";

/**
 * Secrets (docs/plans/apps.md §4.4, §9.2): the secrets the app declares. The
 * owner gives a value in a masked field, replaces it, or clears it; a value is
 * never read back, so a row says only whether it is set: a mark for a value
 * that is saved, and the words for one that is not.
 */
export function SecretsSection({ hostId, appId, state, connected, reloadState }: AppSectionProps) {
  const { secrets } = state;
  const { busy, change } = useAppChange(hostId);
  const disabled = busy !== null || !connected;
  const [editing, setEditing] = useState<{ name: string; value: string; isRevealed: boolean } | null>(null);

  const act = (refusal: string, run: (api: HostApi) => Promise<AppState>) => {
    change("secret", run).then(reloadState, (cause: unknown) => Alert.alert(refusal, errorMessage(cause)));
  };

  const save = () => {
    if (!editing || editing.value === "") return;
    const { name, value } = editing;
    act("Not saved", (api) => api.appSecretSet({ appId, name, value }));
    setEditing(null);
  };

  const clear = (secret: AppSecretState) => {
    Alert.alert(`Clear ${secret.label}?`, "The app runs without this value until you add it again.", [
      { text: "Keep", style: "cancel" },
      {
        text: "Clear value",
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
          <>
            {secrets.map((secret, index) => (
              <View key={secret.name} className={cn("gap-3 p-4", index > 0 && "border-t border-border-subtle")}>
                <View className="flex-row items-start gap-3">
                  <View className="size-6 items-center justify-center">
                    <AppStateMark mark={secret.isSet ? { state: "ok", label: "Saved" } : { state: "idle" }} />
                  </View>
                  <View className="min-w-0 flex-1 gap-1">
                    <Text className="text-base text-foreground" numberOfLines={1}>
                      {secret.label}
                    </Text>
                    {secret.description ? <Text className="text-sm text-foreground-muted">{secret.description}</Text> : null}
                    {secret.isSet ? null : <Text className="text-sm text-foreground-muted">Not set</Text>}
                  </View>
                </View>

                {editing?.name === secret.name ? (
                  <View className="gap-2">
                    <View className="flex-row items-center rounded-2xl border border-border bg-input pr-1">
                      <TextInput
                        accessibilityLabel={`${secret.isSet ? "New value" : "Value"} of ${secret.label}`}
                        autoFocus
                        secureTextEntry={!editing.isRevealed}
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoComplete="off"
                        textContentType="none"
                        placeholder={secret.isSet ? "Paste the new value" : "Paste the value"}
                        value={editing.value}
                        onChangeText={(value) => setEditing({ ...editing, value })}
                        onSubmitEditing={save}
                        returnKeyType="done"
                        className="min-h-12 flex-1 px-3.5 py-3 text-sm text-foreground"
                      />
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={editing.isRevealed ? "Hide the value" : "Show the value"}
                        accessibilityState={{ selected: editing.isRevealed }}
                        hitSlop={8}
                        onPress={() => setEditing({ ...editing, isRevealed: !editing.isRevealed })}
                        className="h-10 w-10 items-center justify-center active:opacity-60"
                      >
                        <SymbolView
                          name={editing.isRevealed ? "eye.slash" : "eye"}
                          size={18}
                          tintColorClassName="accent-icon-muted"
                          type="monochrome"
                          weight="regular"
                        />
                      </Pressable>
                    </View>
                    <View className="flex-row gap-2">
                      <PillButton label="Save" disabled={disabled || editing.value === ""} onPress={save} />
                      <PillButton label="Cancel" onPress={() => setEditing(null)} />
                    </View>
                  </View>
                ) : (
                  <View className="flex-row flex-wrap gap-2 pl-9">
                    <PillButton
                      label={secret.isSet ? "Replace" : "Add value"}
                      disabled={disabled}
                      onPress={() => setEditing({ name: secret.name, value: "", isRevealed: false })}
                    />
                    {secret.isSet ? <PillButton label="Clear" disabled={disabled} onPress={() => clear(secret)} /> : null}
                  </View>
                )}
              </View>
            ))}
          </>
        )}
      </SettingsSection>
      {secrets.length > 0 ? (
        <SettingsNote>
          Write-only. A value stays in the secret store of the host, and only the app's backend gets it. No client and no agent reads it back. A change applies on the next call.
        </SettingsNote>
      ) : null}
    </View>
  );
}
