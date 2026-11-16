import { useState } from "react";
import { Pressable, View } from "react-native";

import { APP_TILE_HUES, appTileHue } from "@solus/client-core/app-tile";
import type { AppSummary, AppUpdate } from "@solus/contracts/apps";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text, AppTextInput } from "../../../components/AppText";
import { cn } from "../../../lib/cn";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { PillButton } from "../../webhooks/webhook-rows";
import { descriptionNote, nameNote, textPatch } from "../app-overview";
import { AppTile } from "../AppTile";

/**
 * What the owner calls the app and the colour of its tile (docs/apps.md). The
 * host keeps them apart from the manifest, so a deploy does not undo them;
 * Reset goes back to the manifest's name or description. A field saves when
 * it loses focus.
 */
export function OverviewAppCard(props: {
  readonly app: AppSummary;
  readonly disabled: boolean;
  /** Saves one change; true when the host saved it. */
  readonly onSave: (patch: AppUpdate, failure: string) => Promise<boolean>;
}) {
  const { app, disabled, onSave } = props;
  return (
    <SettingsSection title="App">
      {/* A save from any client changes the value, and the key starts the field again from it. */}
      <TextField
        key={`name:${app.name}`}
        first
        label="Name"
        note={nameNote(app)}
        value={app.name}
        maxLength={80}
        disabled={disabled}
        resetLabel={app.name === app.manifestName ? null : `Reset to ${app.manifestName}`}
        onSave={(name) => onSave({ name }, name === null ? "Name not reset" : "Not renamed")}
      />
      <TextField
        key={`description:${app.description}`}
        label="Description"
        note={descriptionNote(app)}
        value={app.description}
        placeholder="What does this app do?"
        maxLength={1000}
        multiline
        disabled={disabled}
        resetLabel={app.description === app.manifestDescription ? null : "Reset"}
        onSave={(description) => onSave({ description }, description === null ? "Description not reset" : "Description not saved")}
      />
      <ColourField app={app} disabled={disabled} onSave={(colorHue) => onSave({ colorHue }, "Colour not saved")} />
    </SettingsSection>
  );
}

function TextField(props: {
  readonly first?: boolean;
  readonly label: string;
  readonly note: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly maxLength: number;
  readonly multiline?: boolean;
  readonly disabled: boolean;
  readonly resetLabel: string | null;
  /** The new text, or null to show the manifest's text again. */
  readonly onSave: (text: string | null) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(props.value);
  const save = () => {
    const patch = textPatch(draft, props.value);
    if (patch === undefined) return;
    // A refused save shows the value the host has again. A saved one starts the field again from its key.
    void props.onSave(patch).then((saved) => {
      if (!saved) setDraft(props.value);
    });
  };

  return (
    <View className={cn("gap-2 p-4", !props.first && "border-t border-border-subtle")}>
      <Text className="text-base text-foreground">{props.label}</Text>
      <AppTextInput
        accessibilityLabel={`App ${props.label.toLowerCase()}`}
        value={draft}
        onChangeText={setDraft}
        onEndEditing={save}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        multiline={props.multiline}
        editable={!props.disabled}
        returnKeyType={props.multiline ? "default" : "done"}
        className={cn(props.multiline && "min-h-20", props.disabled && "opacity-45")}
        textAlignVertical={props.multiline ? "top" : "center"}
      />
      <Text className="text-sm text-foreground-muted">{props.note}</Text>
      {props.resetLabel ? <PillButton label={props.resetLabel} disabled={props.disabled} onPress={() => void props.onSave(null)} /> : null}
    </View>
  );
}

/**
 * The colour of the tile: Automatic (the hue from the app's id), then each hue
 * of the palette. Each choice is the app's own tile on that hue, so the owner
 * sees the tile as it will be.
 */
function ColourField(props: { readonly app: AppSummary; readonly disabled: boolean; readonly onSave: (hue: number | null) => Promise<boolean> }) {
  const { app } = props;
  const choices = [
    { value: null, label: "Automatic", hue: appTileHue({ id: app.id, colorHue: null }) },
    ...APP_TILE_HUES.map((option) => ({ value: option.hue, label: option.label, hue: option.hue })),
  ];
  return (
    <View className="gap-3 border-t border-border-subtle p-4">
      <Text className="text-base text-foreground">Colour</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Tile colour" className="flex-row flex-wrap items-center gap-2">
        {choices.map((choice) => {
          const isChosen = app.colorHue === choice.value;
          return (
            <Pressable
              key={choice.label}
              accessibilityRole="radio"
              accessibilityLabel={choice.label}
              accessibilityState={{ checked: isChosen, disabled: props.disabled }}
              disabled={props.disabled}
              onPress={() => {
                if (!isChosen) void props.onSave(choice.value);
              }}
              className={cn(
                "flex-row items-center gap-2 rounded-2xl border-[1.5px] p-1 active:opacity-70",
                isChosen ? "border-foreground" : "border-transparent",
                props.disabled && "opacity-45",
              )}
            >
              <View>
                <AppTile hue={choice.hue} name={app.name} size="small" />
                {isChosen ? (
                  <View accessible={false} className="absolute -right-1 -bottom-1 size-4 items-center justify-center rounded-full bg-primary">
                    <SymbolView name="checkmark" size={10} tintColorClassName="accent-primary-foreground" type="monochrome" weight="bold" />
                  </View>
                ) : null}
              </View>
              {choice.value === null ? <Text className="pr-1.5 text-sm text-foreground-muted">Automatic</Text> : null}
            </Pressable>
          );
        })}
      </View>
      <Text className="text-sm text-foreground-muted">The colour of the app's tile. Everyone who uses this host sees it.</Text>
    </View>
  );
}
