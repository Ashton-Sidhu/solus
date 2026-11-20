import { toolStripChips } from "@solus/client-core/tool-outputs";
import { memo, useMemo } from "react";
import { Pressable, View } from "react-native";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import type { ConversationStore } from "../conversation/conversation-store";
import { toolCallOutputs, type ToolTranscriptItem } from "./thread-work-log-presentation";
import { useTranscriptItems } from "./use-transcript-items";

/**
 * What a folded row holds besides images: one chip for each audio clip and
 * for each call's left-out notes (docs/transcript-cards.md, "Tool outputs").
 * A chip opens the folds down to its tool row.
 */
export const ThreadToolOutputStrip = memo(function ThreadToolOutputStrip(props: {
  readonly store: ConversationStore;
  readonly toolIds: readonly string[];
  readonly onOpenTool: (toolId: string) => void;
  readonly className?: string;
}) {
  const items = useTranscriptItems(props.store, props.toolIds);
  const chips = useMemo(
    () => toolStripChips(items.filter((item): item is ToolTranscriptItem => item.kind === "tool").map(toolCallOutputs)),
    [items],
  );
  if (chips.length === 0) return null;
  return (
    <View className={`min-w-0 flex-row flex-wrap items-center gap-x-3 ${props.className ?? ""}`}>
      {chips.map((chip) => (
        <Pressable
          key={chip.key}
          accessibilityRole="button"
          accessibilityLabel={chip.kind === "audio" ? `${chip.server} audio, ${chip.format}` : `${chip.count} left out of the result`}
          accessibilityHint="Opens the tool call"
          onPress={() => props.onOpenTool(chip.toolId)}
          hitSlop={4}
          className="min-h-11 max-w-full flex-row items-center gap-1.5 active:opacity-70"
        >
          {chip.kind === "audio" ? (
            <>
              <SymbolView name="play.fill" size={11} tintColorClassName="accent-icon-muted" type="monochrome" />
              <Text numberOfLines={1} className="shrink text-xs text-foreground">{chip.server}</Text>
              <Text className="text-xs text-foreground-muted">{chip.format}</Text>
            </>
          ) : (
            <>
              <SymbolView name="exclamationmark.circle" size={12} tintColorClassName="accent-icon-muted" type="monochrome" />
              <Text numberOfLines={1} className="shrink text-xs text-foreground-muted">{chip.count} left out</Text>
            </>
          )}
        </Pressable>
      ))}
    </View>
  );
});
