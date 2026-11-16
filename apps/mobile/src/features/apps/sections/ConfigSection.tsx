import { useState } from "react";
import { Alert, Platform, TextInput, View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { configCommit, configRangeHint, configValueText, modelSettingOptions } from "@solus/client-core/app-config";
import type { HostApi } from "@solus/client-core/host-api";
import type { AppConfigState, AppConfigValue, AppState } from "@solus/contracts/apps";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { ListRowLayout } from "../../../components/ListRowLayout";
import { RowPressable } from "../../../components/RowPressable";
import { cn } from "../../../lib/cn";
import { SettingsChoiceRow } from "../../settings/components/SettingsChoiceRow";
import { SettingsNote } from "../../settings/components/SettingsNote";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../../settings/components/SettingsSwitchRow";
import { errorMessage } from "../../settings/integrations";
import { PillButton } from "../../webhooks/webhook-rows";
import { useAppChange, useHostRead } from "../use-app";
import type { AppSectionProps } from "./section-props";

type ConfigOption = { readonly value: string; readonly label: string };

/**
 * Config (docs/plans/apps.md §4.4, §9.2): the settings the app declares, as
 * one grouped card. Each row shows its value; a switch saves at once, and a
 * tap on another row opens its choices or its field below it. A changed row
 * says so and names its default.
 */
export function ConfigSection({ hostId, appId, state, connected, reloadState }: AppSectionProps) {
  const { config } = state;
  const { busy, change } = useAppChange(hostId);
  const disabled = busy !== null || !connected;
  /** The one row whose choices or field are open. */
  const [openName, setOpenName] = useState<string | null>(null);

  const save = (field: AppConfigState, value: AppConfigValue | null) => {
    change("config", (api: HostApi): Promise<AppState> => api.appConfigSet({ appId, name: field.name, value })).then(
      () => {
        setOpenName(null);
        reloadState();
      },
      (cause: unknown) => Alert.alert(value === null ? "Not reset" : "Not saved", errorMessage(cause)),
    );
  };

  if (config.length === 0) {
    return <SettingsNote>This app declares no config.</SettingsNote>;
  }

  const changedCount = config.filter((field) => !field.isDefault).length;
  const toggle = (name: string) => setOpenName((current) => (current === name ? null : name));

  return (
    <SettingsSection
      title={`${config.length === 1 ? "1 setting" : `${config.length} settings`}${changedCount > 0 ? ` · ${changedCount} changed` : ""}`}
      footer="The app and its UI read these values. A change applies at once."
    >
      {config.map((field, index) => {
        const rowProps = {
          field,
          separated: index > 0,
          isOpen: openName === field.name,
          disabled,
          onToggle: () => toggle(field.name),
          onSave: (value: AppConfigValue | null) => save(field, value),
        };
        if (field.type === "boolean") {
          return (
            <View key={field.name} className={cn(index > 0 && "border-t border-border-subtle")}>
              <SettingsSwitchRow
                label={field.label}
                subtitle={rowDescription(field)}
                value={field.value === true}
                disabled={disabled}
                onValueChange={(value) => save(field, value)}
              />
            </View>
          );
        }
        if (field.type === "model") return <ModelConfigRow key={field.name} hostId={hostId} {...rowProps} />;
        return <ConfigRow key={field.name} options={field.type === "choice" ? field.options : null} {...rowProps} />;
      })}
    </SettingsSection>
  );
}

interface ConfigRowProps {
  readonly field: AppConfigState;
  readonly separated: boolean;
  readonly isOpen: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
  readonly onSave: (value: AppConfigValue | null) => void;
}

/** The field's description, then whether the owner changed it from its default. */
function rowDescription(field: AppConfigState): string | undefined {
  const changed = field.isDefault ? null : `Changed · default ${configValueText(field, field.default)}`;
  return [field.description, changed].filter(Boolean).join("\n") || undefined;
}

/** A model setting (docs/plans/app-models.md §4): Solus's default, then each model the host can run. */
function ModelConfigRow(props: ConfigRowProps & { readonly hostId: string }) {
  const { hostId, ...rowProps } = props;
  const models = useHostRead(hostId, readHostModels);
  const agents = models.state.kind === "loaded" ? models.state.value.agents : [];
  return <ConfigRow {...rowProps} options={modelSettingOptions(agents, String(props.field.value))} />;
}

const readHostModels = (api: HostApi) => api.textGenerationSettingsGet();

/**
 * A row that opens below itself: its choices when it has options, else a
 * field for text or a number that saves with Save or the return key.
 */
function ConfigRow(props: ConfigRowProps & { readonly options: readonly ConfigOption[] | null }) {
  const { field, options } = props;
  const [draft, setDraft] = useState("");
  const rippleStyle = useResolveClassNames("bg-subtle-strong");
  const valueText = options?.find((option) => option.value === field.value)?.label ?? configValueText(field, field.value);
  const commit = configCommit(field, draft);
  const hint = configRangeHint(field);

  const toggle = () => {
    setDraft(String(field.value));
    props.onToggle();
  };
  const submit = () => {
    if (commit.kind === "save") props.onSave(commit.value);
    else if (commit.kind === "unchanged") props.onToggle();
  };

  return (
    <View className={cn(props.separated && "border-t border-border-subtle")}>
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={`${field.label}, ${valueText}`}
        accessibilityHint={rowDescription(field)}
        accessibilityState={{ expanded: props.isOpen, disabled: props.disabled }}
        disabled={props.disabled}
        onPress={toggle}
        android_ripple={{ color: rippleStyle.backgroundColor }}
        unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
        className="bg-grouped-card"
      >
        <ListRowLayout
          label={field.label}
          description={rowDescription(field)}
          detail={props.isOpen ? undefined : valueText}
          disabled={props.disabled}
          accessory={
            <SymbolView
              name={props.isOpen ? "chevron.up" : "chevron.down"}
              size={14}
              tintColorClassName="accent-chevron"
              type="monochrome"
              weight="semibold"
            />
          }
        />
      </RowPressable>
      {props.isOpen && options ? (
        <View className="border-t border-border-subtle">
          {options.map((option, index) => (
            <SettingsChoiceRow
              key={option.value}
              label={option.label}
              selected={field.value === option.value}
              separated={index > 0}
              disabled={props.disabled}
              onPress={() => (field.value === option.value ? props.onToggle() : props.onSave(option.value))}
            />
          ))}
        </View>
      ) : null}
      {props.isOpen && !options ? (
        <View className="gap-2 px-4 pb-4">
          <TextInput
            accessibilityLabel={`Value of ${field.label}`}
            autoFocus
            autoCorrect={false}
            autoCapitalize="none"
            multiline={field.type === "text" && field.multiline}
            keyboardType={field.type === "number" ? "numbers-and-punctuation" : "default"}
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={submit}
            returnKeyType="done"
            className="min-h-12 rounded-2xl border border-border bg-input px-3.5 py-3 text-sm text-foreground"
          />
          {commit.kind === "invalid" ? (
            <Text selectable className="text-sm text-danger-foreground">
              {commit.problem}
            </Text>
          ) : hint ? (
            <Text className="text-sm text-foreground-muted">{hint}</Text>
          ) : null}
          <View className="flex-row flex-wrap gap-2 pt-1">
            <PillButton label="Save" disabled={props.disabled || commit.kind !== "save"} onPress={submit} />
            <PillButton label="Cancel" onPress={props.onToggle} />
            {!field.isDefault ? <PillButton label="Reset" disabled={props.disabled} onPress={() => props.onSave(null)} /> : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}
