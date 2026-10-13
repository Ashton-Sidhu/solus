// Adapted from T3 Code apps/mobile/src/native/NativeColumnContent.ios.tsx (MIT, see UPSTREAM.md).
import { HeaderHeightContext } from "@react-navigation/elements";
import type { ReactNode } from "react";
import { View } from "react-native";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

/** The column's own top inset includes its navigation bar, so it is the header height. */
function ColumnHeaderHeight(props: { readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return <HeaderHeightContext value={insets.top}>{props.children}</HeaderHeightContext>;
}

/**
 * The body of one v5 screen or column. Its own safe area provider measures
 * the insets UIKit gives this controller (its bars and the side columns).
 * T3 also reads fold regions through a native observer; Solus has none.
 */
export function NativeColumnContent(props: { readonly children: ReactNode; readonly primary?: boolean }) {
  return (
    <View className={props.primary ? "flex-1 bg-drawer" : "flex-1 bg-screen"}>
      <SafeAreaProvider style={{ flex: 1 }}>
        <SafeAreaView edges={["left", "right"]} style={{ flex: 1 }}>
          <ColumnHeaderHeight>{props.children}</ColumnHeaderHeight>
        </SafeAreaView>
      </SafeAreaProvider>
    </View>
  );
}
