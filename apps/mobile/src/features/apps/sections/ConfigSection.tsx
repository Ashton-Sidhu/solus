import { useState } from "react";
import { Alert, TextInput, View } from "react-native";

import { configDefaultText, configRangeHint, modelSettingOptions, parseConfigDraft } from "@solus/client-core/app-config";
import type { HostApi } from "@solus/client-core/host-api";
import type { AppConfigState, AppConfigValue, AppState } from "@solus/contracts/apps";

import { SettingsChoiceRow } from "../../settings/components/SettingsChoiceRow";
import { SettingsNote } from "../../settings/components/SettingsNote";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../../settings/components/SettingsSwitchRow";
import { errorMessage } from "../../settings/integrations";
import { PillButton } from "../../webhooks/webhook-rows";
import { AppDetailRow } from "../app-rows";
import { useAppChange, useHostRead } from "../use-app";
import type { AppSectionProps } from "./section-props";

/**
 * Config (docs/plans/apps.md §4.4, §9.2): the settings the app declares. The
 * owner changes a value here; the app's backend and its UI read it. A switch
 * and a choice save at once; text and a number save with Save.
 */
export function ConfigSection({ hostId, appId, state, connected, reloadState }: AppSectionProps) {
  const { config } = state;
  const { busy, change } = useAppChange(hostId);
  const disabled = busy !== null || !connected;
  const [editing, setEditing] = useState<{ name: string; draft: string } | null>(null);

  const save = (field: AppConfigState, value: AppConfigValue | null) => {
    change("config", (api: HostApi): Promise<AppState> => api.appConfigSet({ appId, name: field.name, value })).then(
      () => {
        setEditing(null);
        reloadState();
      },
      (cause: unknown) => Alert.alert(value === null ? "Not reset" : "Not saved", errorMessage(cause)),
    );
  };

  if (config.length === 0) {
    return <SettingsNote>This app declares no config.</SettingsNote>;
  }

  return (
    <View className="gap-3">
      {config.map((field) => {
        if (field.type === "boolean") {
          return (
            <SettingsSection key={field.name} title={field.label}>
              <SettingsSwitchRow
                label={field.label}
                subtitle={field.description || undefined}
                value={field.value === true}
                disabled={disabled}
                onValueChange={(value) => save(field, value)}
              />
            </SettingsSection>
          );
        }
        if (field.type === "model") {
          return <ModelSettingRows key={field.name} hostId={hostId} field={field} disabled={disabled} onSave={(value) => save(field, value)} />;
        }
        if (field.type === "choice") {
          return (
            <SettingsSection key={field.name} title={field.label}>
              {field.options.map((option, index) => (
                <SettingsChoiceRow
                  key={option.value}
                  label={option.label}
                  selected={field.value === option.value}
                  separated={index > 0}
                  disabled={disabled}
                  onPress={() => save(field, option.value)}
                />
              ))}
            </SettingsSection>
          );
        }
        const draft = editing?.name === field.name ? editing.draft : null;
        const problem = draft === null ? null : parseConfigDraft(field, draft).problem;
        const hint = configRangeHint(field);
        const lines = [
          ...(field.description ? [{ text: field.description }] : []),
          ...(problem ? [{ text: problem, tone: "danger" as const }] : hint ? [{ text: hint }] : []),
        ];
        const submit = () => {
          if (draft === null) return;
          const parsed = parseConfigDraft(field, draft);
          if (parsed.problem === null) save(field, parsed.value);
        };
        return (
          <SettingsSection key={field.name} title={field.label}>
            <AppDetailRow
              first
              title={draft === null ? String(field.value) || "Empty" : field.label}
              trailing={field.isDefault ? "Default" : `Default: ${configDefaultText(field)}`}
              trailingTone="muted"
              lines={lines}
            >
              {draft !== null ? (
                <View className="w-full gap-2">
                  <TextInput
                    accessibilityLabel={`Value of ${field.label}`}
                    autoFocus
                    autoCorrect={false}
                    autoCapitalize="none"
                    multiline={field.type === "text" && field.multiline}
                    keyboardType={field.type === "number" ? "numbers-and-punctuation" : "default"}
                    value={draft}
                    onChangeText={(value) => setEditing({ name: field.name, draft: value })}
                    onSubmitEditing={submit}
                    returnKeyType="done"
                    className="min-h-12 rounded-2xl border border-border bg-input px-3.5 py-3 text-sm text-foreground"
                  />
                  <View className="flex-row gap-2">
                    <PillButton label="Save" disabled={disabled || problem !== null} onPress={submit} />
                    <PillButton label="Cancel" onPress={() => setEditing(null)} />
                  </View>
                </View>
              ) : (
                <>
                  <PillButton label="Change" disabled={disabled} onPress={() => setEditing({ name: field.name, draft: String(field.value) })} />
                  {!field.isDefault ? <PillButton label="Reset" disabled={disabled} onPress={() => save(field, null)} /> : null}
                </>
              )}
            </AppDetailRow>
          </SettingsSection>
        );
      })}
      <SettingsNote>The app and its UI read these values. A change applies at once.</SettingsNote>
    </View>
  );
}

/** A model setting (docs/plans/app-models.md §4): Solus's default, then each model the host can run. */
function ModelSettingRows(props: {
  readonly hostId: string;
  readonly field: AppConfigState;
  readonly disabled: boolean;
  readonly onSave: (value: string) => void;
}) {
  const models = useHostRead(props.hostId, readHostModels);
  const agents = models.state.kind === "loaded" ? models.state.value.agents : [];
  return (
    <SettingsSection title={props.field.label}>
      {modelSettingOptions(agents, String(props.field.value)).map((option, index) => (
        <SettingsChoiceRow
          key={option.value}
          label={option.label}
          selected={props.field.value === option.value}
          separated={index > 0}
          disabled={props.disabled}
          onPress={() => props.onSave(option.value)}
        />
      ))}
    </SettingsSection>
  );
}

const readHostModels = (api: HostApi) => api.textGenerationSettingsGet();
