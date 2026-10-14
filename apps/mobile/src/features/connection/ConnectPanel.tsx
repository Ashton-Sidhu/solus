import type { ReactNode } from "react";
import { Platform, StyleSheet, useWindowDimensions, View } from "react-native";

import { cn } from "../../lib/cn";
import { deriveLayout } from "../../lib/layout";

/**
 * The content of a "Connect a host" page. On a wide iPad or tablet it sits in a
 * centered panel, so it does not read as a page stretched across the screen.
 */
export function ConnectPanel(props: { readonly children: ReactNode }) {
  const { width, height } = useWindowDimensions();
  if (!deriveLayout({ width, height }).usesSplitView) {
    return <View className="w-full max-w-[520px]">{props.children}</View>;
  }
  return (
    <View
      collapsable={false}
      className={cn(
        "w-full max-w-[560px] rounded-[28px] border-continuous border-composer-border bg-grouped-card px-8 py-10",
        Platform.OS === "ios" && "shadow-[0_24px_48px_-32px] shadow-composer-shadow",
      )}
      style={{ borderWidth: StyleSheet.hairlineWidth }}
    >
      {props.children}
    </View>
  );
}
