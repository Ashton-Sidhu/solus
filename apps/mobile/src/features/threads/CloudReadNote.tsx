import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { CloudReadView } from "./lib/cloud-read-view";

/**
 * The note beside a session's read-only copy from Solus Cloud
 * (docs/plans/portable-sessions-cloud.md, Phase 5B): what the rows are, and
 * the one action when the copy can be behind or could not be read. It shows
 * above the composer, or above the asleep card when no host can run a prompt.
 */
export function CloudReadNote(props: {
  readonly view: CloudReadView;
  readonly onAction: () => void;
}) {
  const { note, action } = props.view;
  if (!note) return null;
  return (
    <View accessibilityRole="summary" className="mx-4 mb-2 flex-row items-center gap-3 rounded-2xl border border-border-subtle bg-subtle px-4 py-2">
      <Text accessibilityLiveRegion="polite" className="min-w-0 flex-1 text-xs text-foreground-secondary">{note}</Text>
      {action ? (
        <Pressable
          accessibilityRole="button"
          onPress={props.onAction}
          hitSlop={8}
          className="min-h-11 shrink-0 justify-center active:opacity-60"
        >
          <Text className="text-xs font-t3-medium text-primary-text">{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
