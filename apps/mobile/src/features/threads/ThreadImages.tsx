import { toolResultImages, type ReplyImage } from "@solus/client-core/reply-images";
import type { ToolResultImage } from "@solus/contracts/types";
import { memo, useMemo } from "react";
import { View } from "react-native";
import { useApp } from "../../app/app-context";
import { FilePreviewGallery } from "../../components/FilePreviewGallery";
import type { FilePreviewItem } from "../../components/FilePreview.types";
import type { ConversationStore } from "../conversation/conversation-store";
import type { HostConnection } from "../hosts/host-connections";
import { resolveHostMediaUrl } from "../files/host-media-url";
import { useTranscriptItem } from "./use-transcript-items";
import { ThreadMarkdown } from "./ThreadMarkdown";

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
export function assetPreviewItem(connection: HostConnection | null, image: ReplyImage): FilePreviewItem {
  return {
    key: image.href,
    kind: "image",
    name: image.label,
    resolveUri: async () => connection ? resolveHostMediaUrl(connection, { assetId: image.href.slice(8) }) : null,
  };
}
