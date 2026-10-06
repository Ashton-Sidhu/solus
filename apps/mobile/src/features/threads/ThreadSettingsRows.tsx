// Adapted from T3 Code apps/mobile/src/features/threads/ThreadSettingsRows.shared.tsx
// (MIT, see UPSTREAM.md).
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { cn } from "../../lib/cn";
import type { AppSymbolName } from "../../components/AppSymbol";
import type { ModelOption } from "./thread-settings-options";

/** Provider catalog header with its harness logo and disclosure state. */
export function ProviderHeader(props: {
  readonly driver: string | undefined;
  readonly label: string;
  /** Why the agent cannot be picked, shown in place of its models. */
  readonly unavailableReason: string | null;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly modelCount: number;
  readonly onToggle: () => void;
}) {
  const content = (
    <>
      <ProviderIcon provider={props.driver} size={15} />
      <Text className="text-sm font-t3-medium text-foreground-muted">{props.label}</Text>
      {props.unavailableReason ? (
        <>
          <View className="flex-1" />
          <Text className="text-xs text-foreground-muted">{props.unavailableReason}</Text>
        </>
      ) : null}
      {props.collapsible ? (
        <>
          <View className="flex-1" />
          {props.collapsed ? (
            <Text className="text-2xs font-t3-medium text-foreground-muted">
              {props.modelCount}
            </Text>
          ) : null}
          <SymbolView
            name={props.collapsed ? "chevron.down" : "chevron.up"}
            size={12}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
        </>
      ) : null}
    </>
  );

  if (props.collapsible) {
    return (
      <Pressable
        accessibilityLabel={`${props.label}, ${props.modelCount} models`}
        accessibilityRole="button"
        accessibilityState={{ expanded: !props.collapsed }}
        className="mx-4 mt-3 min-h-10 flex-row items-center gap-2 rounded-xl px-1 active:opacity-60 android:min-h-12"
        onPress={props.onToggle}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View
      accessibilityLabel={[props.label, props.unavailableReason].filter(Boolean).join(", ")}
      accessibilityRole="header"
      className="mx-4 mt-3 min-h-10 flex-row items-center gap-2 px-1"
    >
      {content}
    </View>
  );
}

/** Compact row that opens a single-choice submenu panel. */
export function DisclosureRow(props: {
  readonly label: string;
  readonly value: string | undefined;
  /** The value's own mark, as the desktop chip shows a mode's icon beside its name. */
  readonly valueIcon?: AppSymbolName;
  readonly onPress: () => void;
  readonly isLast?: boolean;
  /** Shows the value without offering a change. */
  readonly disabled?: boolean;
  readonly accessibilityHint?: string;
}) {
  return (
    <Pressable
      accessibilityHint={props.accessibilityHint}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-11 flex-row items-center gap-2 bg-grouped-card px-4 py-2 active:bg-subtle android:min-h-14",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <View className="flex-1" />
      {props.valueIcon ? (
        <SymbolView name={props.valueIcon} size={14} tintColorClassName="accent-icon-muted" type="monochrome" />
      ) : null}
      {props.value ? (
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {props.value}
        </Text>
      ) : null}
      {props.disabled ? null : (
        <SymbolView
          name="chevron.right"
          size={12}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
      )}
    </Pressable>
  );
}

/** Codex fast mode: a switch, as in the desktop picker. */
export function FastModeRow(props: {
  readonly modelLabel: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  return (
    <View className="min-h-11 flex-row items-center gap-3 border-t border-border-subtle bg-grouped-card px-4 py-2 android:min-h-14">
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-t3-medium text-foreground">Fast mode</Text>
        <Text className="text-xs text-foreground-muted">Uses your Codex allowance more quickly</Text>
      </View>
      <ThemedSwitch
        accessibilityLabel={`Fast mode for ${props.modelLabel}`}
        onValueChange={props.onValueChange}
        value={props.value}
      />
    </View>
  );
}

/** Auto: the host picks the agent and model for the first prompt. */
export function AutoRow(props: {
  readonly selected: boolean;
  readonly needsKey: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityHint="Solus picks the agent and model for the first prompt"
      accessibilityLabel={props.needsKey ? "Auto, needs a TypeSafe key" : "Auto"}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.needsKey }}
      className="mx-4 mt-3 min-h-12 flex-row items-center gap-3 rounded-2xl bg-grouped-card px-4 py-3 active:bg-subtle android:min-h-14"
      disabled={props.needsKey}
      onPress={props.onPress}
    >
      <SymbolView
        name={{ ios: "sparkles", android: "auto_awesome" }}
        size={16}
        tintColorClassName={props.needsKey ? "accent-icon-subtle" : "accent-icon"}
        type="monochrome"
      />
      <View className="min-w-0 flex-1">
        <Text className={cn("text-base font-t3-medium", props.needsKey ? "text-foreground-muted" : "text-foreground")}>
          Auto
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {props.needsKey ? "Needs a TypeSafe key on this host" : "Picks a model for the first prompt"}
        </Text>
      </View>
      <SelectedCheckmark selected={props.selected} />
    </Pressable>
  );
}

function SelectedCheckmark(props: { readonly selected: boolean }) {
  return props.selected ? (
    <SymbolView
      name="checkmark"
      size={16}
      tintColorClassName="accent-icon"
      type="monochrome"
      weight="semibold"
    />
  ) : null;
}

/** One model: its name, and a badge when it is the agent's default or legacy. */
export function ModelRow(props: {
  readonly option: ModelOption;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly isFirst: boolean;
  readonly isLast: boolean;
}) {
  const badge = props.option.isDefault ? "Default" : props.option.isLegacy ? "Legacy" : null;
  return (
    <Pressable
      accessibilityLabel={[props.option.label, badge].filter(Boolean).join(", ")}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected }}
      className={cn(
        "mx-4 min-h-12 flex-row items-center gap-2 bg-grouped-card px-4 py-3 active:bg-subtle android:min-h-14",
        props.isFirst && "rounded-t-2xl",
        props.isLast ? "rounded-b-2xl" : "border-b border-border-subtle",
      )}
      onPress={props.onPress}
    >
      <Text className="min-w-0 shrink text-base font-t3-medium text-foreground" numberOfLines={1}>
        {props.option.label}
      </Text>
      {badge ? (
        <View className="rounded-md bg-subtle px-1.5 py-0.5">
          <Text className="text-3xs font-t3-medium text-foreground-muted">{badge}</Text>
        </View>
      ) : null}
      <View className="flex-1" />
      <SelectedCheckmark selected={props.selected} />
    </Pressable>
  );
}

/** Single option inside a submenu panel. */
export function ChoiceRow(props: {
  readonly label: string;
  readonly description?: string;
  /** A leading mark in a tile, as the desktop permission menu draws each mode. */
  readonly icon?: AppSymbolName;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly isLast: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={props.description ? `${props.label}. ${props.description}` : props.label}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected }}
      onPress={props.onPress}
      className={cn(
        "min-h-14 flex-row items-center gap-3 bg-grouped-card px-4 py-3 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      {props.icon ? (
        <View className="size-8 shrink-0 items-center justify-center rounded-lg bg-subtle">
          <SymbolView name={props.icon} size={16} tintColorClassName="accent-icon-muted" type="monochrome" />
        </View>
      ) : null}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-t3-medium text-foreground">{props.label}</Text>
        {props.description ? (
          <Text className="text-sm leading-5 text-foreground-muted">{props.description}</Text>
        ) : null}
      </View>
      <SelectedCheckmark selected={props.selected} />
    </Pressable>
  );
}
