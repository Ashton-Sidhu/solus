import { memo, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useApp } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { FilePreviewGallery } from "../../components/FilePreviewGallery";
import type { FilePreviewItem } from "../../components/FilePreview.types";
import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
import type { ConversationStore } from "../conversation/conversation-store";
import { projectContext } from "../conversation/lib/ipc-context";
import { resolveHostMediaUrl } from "../files/host-media-url";
import { useTranscriptItems } from "./use-transcript-items";
import { ThreadMarkdown } from "./ThreadMarkdown";
import { threadTurnImages } from "./thread-turn-images";

/** Reuse the native file gallery for full-size viewing; inline controls choose a preview. */
export const ThreadTurnImages = memo(function ThreadTurnImages(props: {
  readonly itemIds: readonly string[];
  readonly store: ConversationStore;
}) {
  const app = useApp();
  const items = useTranscriptItems(props.store, props.itemIds);
  const images = useMemo(() => threadTurnImages(items), [items]);
  const [pickedHref, setPickedHref] = useState<string | null>(null);
  const selected = Math.max(0, images.findIndex((image) => image.href === pickedHref));
  const current = images[selected];
  const connection = app.connections.connection(props.store.controller.hostId);
  const directory = props.store.controller.run.workingDirectory;
  const organizationId = app.account.organizationId;
  const gallery = useMemo<readonly FilePreviewItem[]>(() => images.flatMap((image) => {
    if (image.href.startsWith("asset://")) {
      return [{ key: image.href, kind: "image" as const, name: image.label, resolveUri: async () => connection ? resolveHostMediaUrl(connection, { assetId: image.href.slice(8) }) : null }];
    }
    const preview = resolveMarkdownMediaPreview(image.href, {
      hostFile: (path) => ({ path, resolveUri: async () => connection ? resolveHostMediaUrl(connection, { path, ctx: directory ? projectContext(directory, organizationId) : undefined }) : null }),
    }, true);
    return preview?.kind === "image" ? [preview.source] : [];
  }), [connection, directory, images, organizationId]);
  if (!current) return null;
  return (
    <View className="my-1 self-stretch">
      <View className="flex-row items-center justify-between gap-4">
        <Text className="text-xs text-foreground-muted">Images {selected + 1} / {images.length}</Text>
        <View className="flex-row">
          <Pressable accessibilityRole="button" accessibilityLabel="Previous image" disabled={selected === 0} onPress={() => setPickedHref(images[selected - 1]!.href)} className="size-9 items-center justify-center disabled:opacity-30">
            <SymbolView name="chevron.left" size={14} tintColorClassName="accent-icon-muted" type="monochrome" />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Next image" disabled={selected === images.length - 1} onPress={() => setPickedHref(images[selected + 1]!.href)} className="size-9 items-center justify-center disabled:opacity-30">
            <SymbolView name="chevron.right" size={14} tintColorClassName="accent-icon-muted" type="monochrome" />
          </Pressable>
        </View>
      </View>
      <FilePreviewGallery value={gallery}>
        <ThreadMarkdown markdown={`![${current.label.replaceAll("[", "").replaceAll("]", "")}](<${current.href}>)`} tone="assistant" store={props.store} imageLabel={current.label} imagesOnly />
      </FilePreviewGallery>
    </View>
  );
});
