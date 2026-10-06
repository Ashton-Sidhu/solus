// Adapted from T3 Code apps/mobile/src/features/settings/SettingsAboutRouteScreen.tsx (MIT, see UPSTREAM.md).
import type { ComponentProps } from "react";
import { View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";

/**
 * A fact the person reads but does not change, in the shape of T3's About
 * version row: label, the value on the right, and a quiet line under it.
 */
export function SettingsValueRow(props: {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
}) {
  return (
    <View
      accessible
      accessibilityLabel={[props.label, props.value, props.detail].filter(Boolean).join(", ")}
      className="flex-row items-center gap-4 p-4"
    >
      <SymbolView
        name={props.icon}
        size={22}
        tintColorClassName="accent-icon"
        type="monochrome"
        weight="regular"
      />
      <Text className="shrink-0 text-lg text-foreground">{props.label}</Text>
      <View className="min-w-0 flex-1 items-end">
        <Text
          selectable
          className="text-right text-lg text-foreground-muted"
          ellipsizeMode="middle"
          numberOfLines={1}
        >
          {props.value}
        </Text>
        {props.detail ? (
          <Text className="text-right text-xs text-foreground-muted/70">{props.detail}</Text>
        ) : null}
      </View>
    </View>
  );
}
