// Adapted from T3 Code ThreadFeed.tsx (MIT, see UPSTREAM.md).
import { ActivityIndicator, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type { ThreadFeedHistoryControls } from "./ThreadFeed";

export function ThreadFeedLoadEarlierControl(props: ThreadFeedHistoryControls) {
  const theme = useUniwindTheme();
  const mutedColor = theme["--color-icon-subtle"];
  const accentColor = theme["--color-primary"];
  if (!props.hasMoreHistory && props.error === null) {
    return null;
  }
  return (
    <View className="mb-3 items-center gap-1.5 px-2">
      {props.hasMoreHistory ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Load earlier activity"
          disabled={props.loading}
          onPress={props.onLoadEarlier}
          className="min-h-9 flex-row items-center justify-center gap-2 rounded-full border border-border/60 bg-card/80 px-4 py-2 disabled:opacity-50"
        >
          {props.loading ? (
            <ActivityIndicator size="small" color={accentColor} />
          ) : (
            <SymbolView name="chevron.up" size={12} tintColor={accentColor} type="monochrome" />
          )}
          <Text className="text-sm font-medium text-foreground">
            {props.loading ? "Loading earlier activity…" : "Load earlier activity"}
          </Text>
        </Pressable>
      ) : null}
      {props.error !== null ? (
        <Text className="text-center text-xs" style={{ color: mutedColor }}>
          {props.error}
        </Text>
      ) : null}
    </View>
  );
}
