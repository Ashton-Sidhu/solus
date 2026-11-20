import { toolResultImages, type ReplyImage } from "@solus/client-core/reply-images";
import { turnToolGallery } from "@solus/client-core/tool-outputs";
import type { ToolResultImage } from "@solus/contracts/types";
import { memo, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useApp } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { FilePreviewGallery } from "../../components/FilePreviewGallery";
import { FilePreviewModal } from "../../components/FilePreviewModal";
import type { FilePreviewItem, FilePreviewSource } from "../../components/FilePreview.types";
import type { ConversationStore } from "../conversation/conversation-store";
import type { HostConnection } from "../hosts/host-connections";
import { resolveHostMediaUrl } from "../files/host-media-url";
import { toolCallOutputs, type ToolTranscriptItem } from "./thread-work-log-presentation";
import { useTranscriptItem, useTranscriptItems } from "./use-transcript-items";
import { ThreadMarkdown } from "./ThreadMarkdown";
import { MarkdownImageAvailableWidthContext, ThreadMarkdownImage } from "./ThreadMarkdownImage";

/** Provider image output stays at its position in the conversation. */
export const ThreadImage = memo(function ThreadImage(props: { readonly id: string; readonly store: ConversationStore }) {
  const item = useTranscriptItem(props.store, props.id);
  const href = item?.kind === "image" ? item.path : item?.kind === "browser_snapshot" ? `asset://${item.snapshot.assetId}` : null;
  if (!href) return null;
  const label = item?.kind === "browser_snapshot" ? item.snapshot.title || "Browser screenshot" : "Image";
  return <ThreadMarkdown markdown={`![${label.replaceAll("[", "").replaceAll("]", "")}](<${href}>)`} tone="assistant" store={props.store} />;
});

/** Images stay inside the open tool call, with one gallery for that call. */
export const ThreadToolImages = memo(function ThreadToolImages(props: {
  readonly images: readonly ToolResultImage[];
  readonly store: ConversationStore;
}) {
  const app = useApp();
  const images = useMemo(() => toolResultImages(props.images), [props.images]);
  const connection = app.connections.connection(props.store.controller.hostId);
  const gallery = useMemo(() => images.map((image) => assetPreviewItem(connection, image)), [connection, images]);
  return (
    <FilePreviewGallery value={gallery}>
      <View className="self-stretch gap-2">
        {images.map((image) => (
          <ThreadMarkdown key={image.href} markdown={`![${image.label}](<${image.href}>)`} tone="assistant" store={props.store} />
        ))}
      </View>
    </FilePreviewGallery>
  );
});

/** A stored tool image as the file viewer opens it: the host signs its URL when the viewer shows it. */
function assetPreviewItem(connection: HostConnection | null, image: ReplyImage): FilePreviewItem {
  return {
    key: image.href,
    kind: "image",
    name: image.label,
    resolveUri: async () => connection ? resolveHostMediaUrl(connection, { assetId: image.href.slice(8) }) : null,
  };
}

const TOOL_THUMBNAIL_WIDTH = 88;

/**
 * The images a turn's calls returned, in its gallery below the reply
 * (docs/transcript-cards.md, "Tool outputs"). It shows the first few; the
 * last tile opens the rest in the file viewer. A running call adds none.
 */
export const ThreadToolGallery = memo(function ThreadToolGallery(props: {
  readonly toolIds: readonly string[];
  readonly store: ConversationStore;
}) {
  const app = useApp();
  const items = useTranscriptItems(props.store, props.toolIds);
  const connection = app.connections.connection(props.store.controller.hostId);
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const { shown, all, moreCount } = useMemo(
    () => turnToolGallery(items.filter((item): item is ToolTranscriptItem => item.kind === "tool").map(toolCallOutputs)),
    [items],
  );
  const gallery = useMemo(() => all.map((image) => assetPreviewItem(connection, image)), [all, connection]);
  if (shown.length === 0) return null;
  const firstMore = gallery[shown.length];
  return (
    <FilePreviewGallery value={gallery}>
      <MarkdownImageAvailableWidthContext value={TOOL_THUMBNAIL_WIDTH}>
        <View accessibilityLabel={`Images ${all.length}`} className="my-1 flex-row flex-wrap items-start gap-2 self-stretch">
          {shown.map(({ image }) => (
            <View key={image.href} style={{ width: TOOL_THUMBNAIL_WIDTH }}>
              <ThreadMarkdownImage
                connection={connection}
                request={{ assetId: image.href.slice(8) }}
                alt={image.label}
                preview={assetPreviewItem(connection, image)}
                onPressPreview={setPreview}
              />
            </View>
          ))}
          {firstMore ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${moreCount} more tool images`}
              onPress={() => setPreview({ ...firstMore, gallery })}
              className="items-center justify-center rounded-[10px] border border-border active:opacity-70"
              style={{ width: TOOL_THUMBNAIL_WIDTH, aspectRatio: 16 / 9 }}
            >
              <Text className="text-sm tabular-nums text-foreground">+{moreCount}</Text>
            </Pressable>
          ) : null}
        </View>
      </MarkdownImageAvailableWidthContext>
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </FilePreviewGallery>
  );
});
