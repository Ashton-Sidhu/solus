import { Image } from "expo-image";
import { T } from "gt-react-native";
import { View } from "react-native";

import { AppText as Text } from "./ui/AppText";

export function BrandMark(props: { readonly compact?: boolean }) {
  const compact = props.compact ?? false;
  const iconSize = compact ? 32 : 44;

  return (
    <View className="flex-row items-center gap-3">
      <Image
        source={require("../../assets/solus-icon.png")}
        accessibilityIgnoresInvertColors
        style={{
          width: iconSize,
          height: iconSize,
          borderRadius: compact ? 10 : 14,
        }}
      />
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <Text className="text-lg font-t3-bold tracking-[-0.4px] text-foreground">Solus</Text>
        </View>
        {!compact ? (
          <Text className="text-xs font-medium text-foreground-muted">
            <T>Mobile control surface for your live coding environments</T>
          </Text>
        ) : null}
      </View>
    </View>
  );
}
