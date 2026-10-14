import { Image } from "expo-image";
import { View } from "react-native";

import { AppText as Text } from "./AppText";
import { T3_CODE_BRAND_MARK_SOURCE } from "./brandAssets";

/** The Solus lockup. T3's stage pill is not drawn; this app has no release stage to name. */
export function BrandMark(props: { readonly compact?: boolean }) {
  const compact = props.compact ?? false;
  const iconSize = compact ? 32 : 44;

  return (
    <View className="flex-row items-center gap-3">
      <Image
        source={T3_CODE_BRAND_MARK_SOURCE}
        accessibilityIgnoresInvertColors
        style={{
          width: iconSize,
          height: iconSize,
          borderRadius: compact ? 10 : 14,
        }}
      />
      <View className="gap-1">
        <Text className="text-lg font-t3-bold tracking-[-0.4px] text-foreground">Solus</Text>
        {!compact ? (
          <Text className="text-xs font-medium text-foreground-muted">
            Mobile control for the agents on your Solus hosts
          </Text>
        ) : null}
      </View>
    </View>
  );
}
