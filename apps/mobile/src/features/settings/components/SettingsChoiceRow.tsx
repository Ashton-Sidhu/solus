// Adapted from T3 Code apps/mobile/src/features/settings/components/SettingsChoiceRow.tsx (MIT, see UPSTREAM.md).
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../../components/AppSymbol";
import { RowLeadingSymbol } from "../../../components/RowLeadingSymbol";

export function SettingsChoiceRow(props: {
  readonly label: string;
  /** Solus choices such as models have no description. */
  readonly description?: string;
  /** A leading mark, as the desktop draws each permission mode. */
  readonly icon?: AppSymbolName;
  readonly selected: boolean;
  readonly separated: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityHint={props.description}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled ?? false }}
      className={
        props.separated
          ? "flex-row items-center gap-4 border-t border-border-subtle p-4 active:opacity-70 disabled:opacity-[0.45]"
          : "flex-row items-center gap-4 p-4 active:opacity-70 disabled:opacity-[0.45]"
      }
      disabled={props.disabled}
      onPress={props.onPress}
    >
      {props.icon ? <RowLeadingSymbol name={props.icon} /> : null}
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-lg text-foreground android:text-base">{props.label}</Text>
        {props.description ? (
          <Text className="text-sm leading-normal text-foreground-muted">{props.description}</Text>
        ) : null}
      </View>
      {props.selected ? (
        <SymbolView
          name="checkmark"
          size={18}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}
