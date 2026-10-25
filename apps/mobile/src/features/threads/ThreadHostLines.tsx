import { ActivityIndicator, View } from "react-native";

import { AppText as Text } from "../../components/AppText";

/**
 * Inside the grace: one quiet line over the composer, which stays
 * (docs/plans/host-readiness.md). `headline` is `hostReadinessCopy(...).headline`.
 */
export function HostGraceWhisper(props: { readonly headline: string }) {
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${props.headline}…`}
      className="flex-row items-center justify-center gap-2 px-5 py-1.5"
    >
      <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
      <Text className="text-xs text-foreground-tertiary" numberOfLines={1}>
        {props.headline}…
      </Text>
    </View>
  );
}
