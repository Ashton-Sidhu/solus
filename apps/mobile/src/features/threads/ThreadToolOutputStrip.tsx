import { toolStrip, hasToolStrip } from "@solus/client-core/tool-outputs";
import type { ReplyImage } from "@solus/client-core/reply-images";
import { memo, useMemo, useState } from "react";
import { Image, Pressable, View } from "react-native";
import { useApp } from "../../app/app-context";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { FilePreviewModal } from "../../components/FilePreviewModal";
import type { FilePreviewSource } from "../../components/FilePreview.types";
import type { ConversationStore } from "../conversation/conversation-store";
import type { HostConnection } from "../hosts/host-connections";
import { useHostMediaUrl } from "../files/host-media-url";
import { assetPreviewItem } from "./ThreadImages";
import { toolCallOutputs, type ToolTranscriptItem } from "./thread-work-log-presentation";
import { useTranscriptItems } from "./use-transcript-items";

/**
 * What a folded row holds (docs/transcript-cards.md, "Tool outputs"): a
 * thumbnail for each image its calls returned, then one chip for each audio
 * clip and for each call's left-out notes. A thumbnail opens the file viewer
 * on the row's images; a chip opens the folds down to its tool row.
 */
export const ThreadToolOutputStrip = memo(function ThreadToolOutputStrip(props: {
  readonly store: ConversationStore;
  readonly toolIds: readonly string[];
  readonly onOpenTool: (toolId: string) => void;
  readonly className?: string;
}) {
  const app = useApp();
  const items = useTranscriptItems(props.store, props.toolIds);
  const connection = app.connections.connection(props.store.controller.hostId);
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const strip = useMemo(
    () => toolStrip(items.filter((item): item is ToolTranscriptItem => item.kind === "tool").map(toolCallOutputs)),
    [items],
  );
  const gallery = useMemo(() => strip.images.map((image) => assetPreviewItem(connection, image)), [strip, connection]);
  if (!hasToolStrip(strip)) return null;
  const openImage = (index: number) => {
    const item = gallery[index];
    if (item) setPreview({ ...item, gallery });
  };
  return (
    <View className={`min-w-0 flex-row flex-wrap items-center gap-1.5 py-1 ${props.className ?? ""}`}>
      {strip.thumbnails.map((thumbnail, index) => (
        <ToolThumbnail key={thumbnail.key} connection={connection} image={thumbnail.image} onPress={() => openImage(index)} />
      ))}
      {strip.moreCount > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${strip.moreCount} more tool images`}
          onPress={() => openImage(strip.thumbnails.length)}
          className="h-10 w-14 items-center justify-center rounded-md bg-subtle active:opacity-70"
        >
          <Text className="font-t3-medium text-[13px] tabular-nums text-foreground-muted">+{strip.moreCount}</Text>
        </Pressable>
      ) : null}
      {strip.chips.map((chip) => (
        <Pressable
          key={chip.key}
          accessibilityRole="button"
          accessibilityLabel={chip.kind === "audio" ? `${chip.server} audio, ${chip.format}` : `${chip.count} left out of the result`}
          accessibilityHint="Opens the tool call"
          onPress={() => props.onOpenTool(chip.toolId)}
          hitSlop={6}
          className="h-8 max-w-full flex-row items-center gap-1.5 rounded-full bg-subtle pl-2.5 pr-3 active:opacity-70"
        >
          {chip.kind === "audio" ? (
            <>
              <SymbolView name="play.fill" size={11} tintColorClassName="accent-icon-muted" type="monochrome" />
              <Text numberOfLines={1} className="min-w-0 shrink font-t3-medium text-[13px] text-foreground">{chip.server}</Text>
              <Text className="shrink-0 text-[13px] text-foreground-muted">{chip.format}</Text>
            </>
          ) : (
            <>
              <SymbolView name="exclamationmark.circle" size={12} tintColorClassName="accent-icon-muted" type="monochrome" />
              <Text numberOfLines={1} className="min-w-0 shrink font-t3-medium text-[13px] text-foreground-muted">{chip.count} left out</Text>
            </>
          )}
        </Pressable>
      ))}
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </View>
  );
});

/** One image of the strip. It signs its URL when it mounts: the feed mounts only the rows near the screen. */
function ToolThumbnail(props: { readonly connection: HostConnection | null; readonly image: ReplyImage; readonly onPress: () => void }) {
  const { state } = useHostMediaUrl(props.connection, { assetId: props.image.href.slice(8) });
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`Open ${props.image.label}`}
      onPress={props.onPress}
      className="h-10 w-14 items-center justify-center overflow-hidden rounded-md border border-border bg-subtle active:opacity-70"
    >
      {state.kind === "ready" ? (
        <Image source={{ uri: state.url }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
      ) : (
        <SymbolView name="photo" size={14} tintColorClassName="accent-icon-muted" type="monochrome" />
      )}
    </Pressable>
  );
}
