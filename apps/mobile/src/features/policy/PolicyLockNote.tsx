import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";

/** The line under a managed setting: "Remote access is managed by Globex." (plans/030 §7). One line per lock. */
export function PolicyLockNote(props: { readonly lines: readonly string[] }) {
  if (props.lines.length === 0) return null;
  return (
    <View className="gap-1 px-2">
      {props.lines.map((line) => (
        <View key={line} accessible accessibilityLabel={line} className="flex-row items-start gap-1.5">
          <View className="pt-0.5">
            <SymbolView name="lock" size={13} tintColorClassName="accent-icon-muted" type="monochrome" weight="regular" />
          </View>
          <Text className="min-w-0 flex-1 text-sm leading-normal text-foreground-muted">{line}</Text>
        </View>
      ))}
    </View>
  );
}
