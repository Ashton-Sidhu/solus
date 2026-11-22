import { NATIVE_WORKSPACE_COLUMNS_SUPPORTED } from "../native/NativeWorkspaceColumns";
import { Image } from "expo-image";
import { useGT } from "gt-react-native";
import { Platform, View } from "react-native";

import { AppText as Text } from "./ui/AppText";
import { IPAD_HOME_TITLE_OFFSET } from "../lib/layoutMetrics";
import { useAndroidControlSizing } from "./ui/useAndroidControlSizing";

const BRAND_MAX_FONT_SCALE = 1.4;

export function brandTitleOffset(): number {
  if (Platform.OS !== "ios") return 0;
  return Platform.isPad && !NATIVE_WORKSPACE_COLUMNS_SUPPORTED ? IPAD_HOME_TITLE_OFFSET : 0;
}

export function CompactBrandTitle(
  props: {
    readonly allowFontScaling?: boolean;
    readonly accessibilityLabel?: string;
    readonly fit?: boolean;
  } = {},
) {
  const gt = useGT();
  const { scale } = useAndroidControlSizing();
  return (
    <View
      aria-level={1}
      accessibilityLabel={props.accessibilityLabel ?? gt("Solus, Threads")}
      accessible
      role="heading"
      className="flex-row items-center gap-1.5"
      style={{ marginLeft: brandTitleOffset(), flexShrink: props.fit ? 1 : undefined }}
    >
      <Image
        source={require("../../assets/solus-mark.png")}
        style={{ width: 22 * scale, height: 22 * scale }}
      />
      <Text
        allowFontScaling={props.allowFontScaling}
        maxFontSizeMultiplier={BRAND_MAX_FONT_SCALE}
        className="font-t3-medium text-foreground-muted"
        style={{ fontSize: 21 * scale, letterSpacing: -0.5 * scale }}
      >
        Solus
      </Text>
    </View>
  );
}
