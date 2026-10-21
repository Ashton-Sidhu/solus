// Adapted from T3 Code apps/mobile/src/features/home/ThreadUndoNotice.tsx (MIT, see UPSTREAM.md).
import { useEffect, useSyncExternalStore } from "react";
import { AccessibilityInfo, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { APP_BAR_HEIGHT } from "../../lib/layoutMetrics";
import { threadUndoNotices } from "./thread-undo-notice";

/** The Undo notice over a thread list, below its header, while the list shows. */
export function ThreadUndoNotice(props: { readonly visible: boolean }) {
  const notice = useSyncExternalStore(
    threadUndoNotices.subscribe,
    threadUndoNotices.current,
    threadUndoNotices.current,
  );
  const insets = useSafeAreaInsets();
  const message = notice === null ? null : `${notice.action} thread`;
  useEffect(() => {
    if (props.visible && message !== null && Platform.OS === "ios") {
      AccessibilityInfo.announceForAccessibility(message);
    }
  }, [props.visible, message]);
  if (!props.visible || message === null) return null;
  return (
    <View
      className="absolute inset-x-3 z-[100]"
      style={{ top: insets.top + APP_BAR_HEIGHT + 8 }}
      pointerEvents="box-none"
    >
      <View
        className="flex-row items-center gap-3 rounded-[20px] border border-border bg-card px-4 py-3"
        accessibilityLiveRegion="polite"
      >
        <SymbolView name="checkmark.circle" size={20} tintColorClassName="accent-icon" />
        <Text className="min-w-0 flex-1 text-sm font-t3-bold text-foreground" numberOfLines={1}>
          {message}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Undo: ${message}`}
          className="active:opacity-60"
          hitSlop={8}
          onPress={() => threadUndoNotices.undo()}
        >
          <Text className="text-sm font-t3-bold text-primary-text">Undo</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss message"
          className="active:opacity-60"
          hitSlop={8}
          onPress={() => threadUndoNotices.dismiss()}
        >
          <SymbolView name="xmark" size={14} tintColorClassName="accent-icon-muted" />
        </Pressable>
      </View>
    </View>
  );
}
