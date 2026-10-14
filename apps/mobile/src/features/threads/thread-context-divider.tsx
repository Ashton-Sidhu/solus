// Adapted from T3 Code apps/mobile/src/features/threads/thread-context-divider.tsx (MIT, see UPSTREAM.md).
import { memo } from "react";
import { View, type ColorValue } from "react-native";

import { compactionDividerText } from "@solus/contracts/context-compaction";
import type { SessionOrigin } from "@solus/contracts/types";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import type { ConversationStore } from "../conversation/conversation-store";
import { handoffDividerText } from "../conversation/lib/provider-handoff";
import { ShimmeringWorkContent } from "./thread-work-log";
import { useTranscriptItem } from "./use-transcript-items";

/**
 * A context compaction: two hairlines and the label between them, the same
 * words as the desktop divider. A running compaction shimmers its label.
 */
export const CompactionDivider = memo(function CompactionDivider(props: {
  readonly store: ConversationStore;
  readonly id: string;
  readonly iconSubtleColor: ColorValue;
}) {
  const item = useTranscriptItem(props.store, props.id);
  if (item?.kind !== "compaction") return null;
  const { label, detail } = compactionDividerText(item.compaction);
  const text = detail ? `${label} · ${detail}` : label;
  return (
    <View accessible accessibilityRole="text" accessibilityLabel={text} className="mb-3 flex-row items-center gap-3 px-1 py-1">
      <View className="h-px min-w-2 flex-1 bg-separator" />
      <View className="shrink flex-row flex-wrap items-center justify-center gap-1.5">
        <SymbolView
          name="arrow.down.right.and.arrow.up.left"
          size={12}
          tintColor={props.iconSubtleColor}
          type="monochrome"
        />
        {item.compaction.isRunning ? (
          <ShimmeringWorkContent
            className="flex-none"
            textClassName="font-t3-medium"
            compact
            icon="arrow.down.right.and.arrow.up.left"
            iconSubtleColor={props.iconSubtleColor}
            label={text}
            showIcon={false}
          />
        ) : (
          <Text className="font-t3-medium text-xs text-foreground-muted">{text}</Text>
        )}
      </View>
      <View className="h-px min-w-2 flex-1 bg-separator" />
    </View>
  );
});

/**
 * The first line of a session an agent on another host started, the same
 * words as the desktop divider (docs/plans/cross-host-sessions.md).
 */
export const SessionOriginDivider = memo(function SessionOriginDivider(props: {
  readonly origin: SessionOrigin;
  readonly iconSubtleColor: ColorValue;
}) {
  const text = `Started by an agent on ${props.origin.hostLabel}`;
  return (
    <View accessible accessibilityRole="text" accessibilityLabel={text} className="mb-3 flex-row items-center gap-3 px-1 py-1">
      <View className="h-px min-w-2 flex-1 bg-separator" />
      <View className="shrink flex-row flex-wrap items-center justify-center gap-1.5">
        <SymbolView name="desktopcomputer" size={12} tintColor={props.iconSubtleColor} type="monochrome" />
        <Text className="font-t3-medium text-xs text-foreground-muted">{text}</Text>
      </View>
      <View className="h-px min-w-2 flex-1 bg-separator" />
    </View>
  );
});

/** A provider handoff's words between two hairlines. */
function HandoffLine(props: { readonly text: string; readonly iconSubtleColor: ColorValue }) {
  return (
    <View accessible accessibilityRole="text" accessibilityLabel={props.text} className="mb-3 flex-row items-center gap-3 px-1 py-1">
      <View className="h-px min-w-2 flex-1 bg-separator" />
      <View className="shrink flex-row flex-wrap items-center justify-center gap-1.5">
        <SymbolView name="arrow.left.arrow.right" size={12} tintColor={props.iconSubtleColor} type="monochrome" />
        <Text className="font-t3-medium text-xs text-foreground-muted">{props.text}</Text>
      </View>
      <View className="h-px min-w-2 flex-1 bg-separator" />
    </View>
  );
}

/** The host handed the thread to another provider: the same words as the
 *  desktop divider, `from → to` when both models are known (plans/021). */
export const HandoffDivider = memo(function HandoffDivider(props: {
  readonly store: ConversationStore;
  readonly id: string;
  readonly iconSubtleColor: ColorValue;
}) {
  const item = useTranscriptItem(props.store, props.id);
  if (item?.kind !== "handoff") return null;
  return <HandoffLine text={handoffDividerText(item.activity)} iconSubtleColor={props.iconSubtleColor} />;
});

/** The composer picked another provider: the next prompt hands the thread off. */
export const HandoffPendingDivider = memo(function HandoffPendingDivider(props: { readonly iconSubtleColor: ColorValue }) {
  return <HandoffLine text="Context handoff pending" iconSubtleColor={props.iconSubtleColor} />;
});
