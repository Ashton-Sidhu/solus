// Adapted from T3 Code apps/mobile/src/components/CompactBrandTitle.tsx (MIT, see UPSTREAM.md).
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { Platform, View } from "react-native";

import { AppText as Text } from "./AppText";
import { IPAD_HOME_TITLE_OFFSET } from "../lib/layoutMetrics";
import { useAndroidControlSizing } from "./useAndroidControlSizing";

/**
 * Horizontal correction applied to content rendered in the brand title slot,
 * shared with the connection-status swap so both align identically.
 */
export function brandTitleOffset(): number {
  if (Platform.OS !== "ios") return 0;
  return Platform.isPad ? IPAD_HOME_TITLE_OFFSET : 0;
}

/**
 * Compact brand lockup sized for native navigation bars: the word "Solus" in
 * T3's lockup type. T3's stage pill is not drawn; this app has no release
 * stage to name.
 */
export function CompactBrandTitle(
  props: {
    readonly allowFontScaling?: boolean;
  } = {},
) {
  const titleOffset = brandTitleOffset();
  const { scale } = useAndroidControlSizing();

  return (
    <View
      aria-level={1}
      accessibilityLabel="Solus, Threads"
      accessible
      role="heading"
      className="flex-row items-center gap-1.5"
      style={[{ marginLeft: titleOffset }, Platform.OS === "android" && { gap: 5.25 * scale }]}
    >
      <Text
        allowFontScaling={props.allowFontScaling}
        className="font-t3-bold text-foreground"
        style={{ fontSize: 21 * scale, letterSpacing: -0.5 * scale }}
      >
        Solus
      </Text>
    </View>
  );
}

export function renderCompactBrandTitle() {
  return <CompactBrandTitle allowFontScaling={Platform.OS === "ios"} />;
}

export function getCompactBrandHeaderOptions(
  fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"],
): NativeStackNavigationOptions {
  return {
    headerTitle: renderCompactBrandTitle,
    headerTitleStyle: fallbackTitleStyle,
    title: "Threads",
    unstable_headerLeftItems: undefined,
  };
}
