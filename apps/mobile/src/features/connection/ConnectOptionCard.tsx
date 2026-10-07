import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";

/**
 * One way to reach a host — pair a machine, sign in to Solus Cloud — as a card
 * on the screens that ask for one (docs/plans/draft-connect-host.md).
 */
export function ConnectOptionCard(props: {
  readonly icon: AppSymbolName;
  readonly title: string;
  readonly detail: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className="flex-row items-center gap-3 rounded-[24px] bg-grouped-card px-4 py-3.5 active:opacity-70"
    >
      <View className="size-9 items-center justify-center rounded-xl bg-subtle">
        <SymbolView name={props.icon} size={15} tintColorClassName="accent-foreground-muted" type="monochrome" />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-t3-bold leading-snug text-foreground">{props.title}</Text>
        <Text className="text-xs text-foreground-muted">{props.detail}</Text>
      </View>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" type="monochrome" />
    </Pressable>
  );
}
