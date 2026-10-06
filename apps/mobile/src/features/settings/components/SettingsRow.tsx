// Adapted from T3 Code apps/mobile/src/features/settings/components/SettingsRow.tsx (MIT, see UPSTREAM.md).
import { MaterialListRow } from "../../../components/MaterialListRow";
import type { ComponentProps } from "react";
import { Platform, Pressable, View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { cn } from "../../../lib/cn";

type SymbolName = ComponentProps<typeof SymbolView>["name"];

/**
 * T3's settings row. Solus has one stack navigator, so the row takes an
 * `onPress` instead of T3's settings-sheet targets.
 */
export function SettingsRow(props: {
  readonly disabled?: boolean;
  readonly icon: SymbolName;
  readonly label: string;
  readonly value?: string;
  readonly valuePosition?: "below" | "trailing";
  readonly accessibilityHint?: string;
  readonly onPress: () => void;
}) {
  if (Platform.OS === "android") {
    return (
      <MaterialListRow
        className="bg-grouped-card"
        title={props.label}
        subtitle={props.valuePosition === "trailing" ? undefined : props.value}
        accessibilityLabel={[props.label, props.value].filter(Boolean).join(", ")}
        trailing={
          props.valuePosition === "trailing" && props.value ? (
            <View className="flex-row items-center gap-3">
              <Text className="text-sm text-foreground-muted">{props.value}</Text>
              <SymbolView name="chevron.right" size={16} tintColorClassName="accent-chevron" />
            </View>
          ) : undefined
        }
        disabled={props.disabled}
        leading={
          <SymbolView
            name={props.icon}
            size={24}
            tintColorClassName="accent-icon"
            type="monochrome"
            weight="regular"
          />
        }
        onPress={props.onPress}
      />
    );
  }

  return (
    <Pressable
      accessibilityLabel={[props.label, props.value].filter(Boolean).join(", ")}
      accessibilityHint={props.accessibilityHint}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <View className={cn("flex-row items-center gap-4 p-4", props.disabled && "opacity-[0.45]")}>
        <SymbolView
          name={props.icon}
          size={22}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="regular"
        />
        <>
          <Text className="shrink-0 text-lg text-foreground" numberOfLines={1}>
            {props.label}
          </Text>
          <View className="min-w-0 flex-1 items-end">
            {props.value ? (
              <Text
                className="max-w-[180px] text-right text-base text-foreground-muted"
                ellipsizeMode="middle"
                numberOfLines={1}
              >
                {props.value}
              </Text>
            ) : null}
          </View>
        </>
        <SymbolView
          name="chevron.right"
          size={16}
          tintColorClassName="accent-chevron"
          type="monochrome"
          weight="semibold"
        />
      </View>
    </Pressable>
  );
}
