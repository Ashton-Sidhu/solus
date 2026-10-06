// Adapted from T3 Code apps/mobile/src/components/ComposerAttachmentStrip.tsx (MIT, see UPSTREAM.md).
import { SymbolView } from "../components/AppSymbol";
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "./AppText";
import { FilePreview, type ResolvedFilePreviewSource } from "./FilePreview";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { VideoThumbnailImage } from "./VideoThumbnailImage";
import type { UploadedAttachment } from "../features/conversation/lib/attachments";

export interface ComposerAttachmentStripProps {
  /** Attachments to display. */
  readonly attachments: ReadonlyArray<UploadedAttachment>;
  /** Files still uploading to the host; each shows as a placeholder tile. */
  readonly uploading?: number;
  /** Called when the user removes an attachment. */
  readonly onRemove: (attachmentId: string) => void;
  /** Opens a file that is not a picture; absent, file tiles do not respond to a tap. */
  readonly onPressDocument?: (attachment: UploadedAttachment) => void;
  /** Image thumbnail size in points.  Defaults to 72. */
  readonly imageSize?: number;
  /** Border radius of each image thumbnail.  Defaults to 16. */
  readonly imageBorderRadius?: number;
}

type ComposerAttachmentThumbnailProps = {
  readonly attachment: UploadedAttachment;
  readonly size: number;
  readonly borderRadius: number;
  readonly compact?: boolean;
  /** Opens an image full screen; absent, the thumbnail does not respond to a tap. */
  readonly onPressPreview?: (source: ResolvedFilePreviewSource) => void;
  /** Opens a file that is not a picture, as T3's `onPressDocument`. */
  readonly onPressDocument?: (attachment: UploadedAttachment) => void;
};

const PREVIEW_CACHE_DIRECTORY = "solus-composer-previews";

/** Roughly 192KB of base64: small enough that re-parsing it per layout stays imperceptible. */
const INLINE_PREVIEW_FALLBACK_MAX_CHARS = 256_000;

/**
 * Fabric re-parses an image source URL on every layout pass of the node, and a
 * multi-megabyte data URL makes each commit slow. Inline bytes are written to
 * the cache once and the thumbnail renders from that file instead.
 */
async function materializeDataUrlPreview(id: string, dataUrl: string): Promise<string | null> {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const { Directory, File, Paths } = await import("expo-file-system");
  const mimeType = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? "image/jpeg";
  const extension = (mimeType.split("/")[1] ?? "jpg").replace("jpeg", "jpg");
  const directory = new Directory(Paths.cache, PREVIEW_CACHE_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  // Keys may carry ids and paths; the file name keeps only safe characters.
  const file = new File(directory, `${id.replace(/[^\w-]/g, "_")}.${extension}`);
  if (!file.exists) {
    file.create();
    file.write(dataUrl.slice(comma + 1), { encoding: "base64" });
  }
  return file.uri;
}

/**
 * An image's bytes as a source the native view can hold: a cache file, never
 * a large data URL. `key` names the file, so one image is written once.
 */
export function useDataUrlPreviewUri(key: string, dataUrl: string | null): string | null {
  const [materialized, setMaterialized] = useState<{ key: string; uri: string | null } | null>(null);
  useEffect(() => {
    if (!dataUrl) return;
    let cancelled = false;
    void materializeDataUrlPreview(key, dataUrl)
      .then((uri) => {
        if (!cancelled) setMaterialized({ key, uri });
      })
      .catch(() => {
        // Record the failure so the thumbnail stops waiting on a file that will never arrive.
        if (!cancelled) setMaterialized({ key, uri: null });
      });
    return () => {
      cancelled = true;
    };
  }, [key, dataUrl]);
  if (!dataUrl || materialized?.key !== key) return null;
  return (
    materialized.uri ?? (dataUrl.length <= INLINE_PREVIEW_FALLBACK_MAX_CHARS ? dataUrl : null)
  );
}

/** The thumbnail source for an uploaded image. */
function useComposerImagePreviewUri(attachment: UploadedAttachment): string | null {
  return useDataUrlPreviewUri(attachment.id, attachment.dataUrl);
}

function ComposerImageAttachment(props: ComposerAttachmentThumbnailProps) {
  const { attachment } = props;
  const style = { width: props.size, height: props.size, borderRadius: props.borderRadius };
  const previewUri = useComposerImagePreviewUri(attachment);
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`Open ${attachment.name}`}
      disabled={!props.onPressPreview || previewUri === null}
      onPress={() => {
        if (previewUri !== null) {
          props.onPressPreview?.({ kind: "image", uri: previewUri, name: attachment.name });
        }
      }}
    >
      <Image
        source={previewUri === null ? undefined : { uri: previewUri }}
        style={style}
        className="bg-subtle"
        resizeMode="cover"
      />
    </Pressable>
  );
}

function ComposerFileAttachment(props: ComposerAttachmentThumbnailProps) {
  const { attachment } = props;
  const style = { width: props.size, height: props.size, borderRadius: props.borderRadius };
  const onPressDocument = props.onPressDocument;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${attachment.name}`}
      disabled={onPressDocument === undefined}
      onPress={() => onPressDocument?.(attachment)}
      className={
        props.compact
          ? "items-center justify-center bg-subtle"
          : "items-center justify-center gap-1 bg-subtle px-2"
      }
      style={style}
    >
      <PierreEntryIcon path={attachment.name} size={props.compact ? 15 : 22} />
      {!props.compact ? (
        <Text className="w-full text-center text-2xs text-foreground" numberOfLines={1}>
          {attachment.name}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** T3's video tile: a frame from the picked file, a play mark, and the name. */
function ComposerVideoAttachment(props: ComposerAttachmentThumbnailProps & { readonly localUri: string }) {
  const { attachment } = props;
  const onPressDocument = props.onPressDocument;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Play ${attachment.name}`}
      disabled={onPressDocument === undefined}
      onPress={() => onPressDocument?.(attachment)}
      className="items-center justify-center overflow-hidden bg-black/80"
      style={{ width: props.size, height: props.size, borderRadius: props.borderRadius }}
    >
      <VideoThumbnailImage cacheKey={`draft-video:${attachment.id}`} source={props.localUri} />
      <View
        className={
          props.compact
            ? "size-6 items-center justify-center rounded-full bg-black/45"
            : "size-12 items-center justify-center rounded-full bg-black/45"
        }
      >
        <SymbolView name="play" size={props.compact ? 15 : 24} tintColor="#ffffff" type="monochrome" />
      </View>
      {!props.compact ? (
        <View className="absolute inset-x-0 bottom-0 bg-black/55 px-2 py-1.5">
          <Text className="text-center text-xs text-white" numberOfLines={1}>
            {attachment.name}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export function ComposerAttachmentThumbnail(props: ComposerAttachmentThumbnailProps) {
  if (props.attachment.kind === "image") return <ComposerImageAttachment {...props} />;
  // Only a video picked on this phone has a local file to draw a frame from.
  const localUri = props.attachment.localUri;
  return localUri ? (
    <ComposerVideoAttachment {...props} localUri={localUri} />
  ) : (
    <ComposerFileAttachment {...props} />
  );
}

/** A file on its way to the host: the slot it will take, with a spinner. */
export function ComposerUploadingThumbnail(props: {
  readonly size: number;
  readonly borderRadius: number;
}) {
  return (
    <View
      accessible
      accessibilityLabel="Uploading attachment"
      className="items-center justify-center bg-subtle"
      style={{ width: props.size, height: props.size, borderRadius: props.borderRadius }}
    >
      <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
    </View>
  );
}

/**
 * Attachment thumbnails used by the thread composer and the new-task draft screen.
 */
export function ComposerAttachmentStrip(props: ComposerAttachmentStripProps) {
  const size = props.imageSize ?? 72;
  const radius = props.imageBorderRadius ?? 16;
  const uploading = props.uploading ?? 0;
  const [preview, setPreview] = useState<ResolvedFilePreviewSource | null>(null);

  if (props.attachments.length === 0 && uploading === 0) {
    return null;
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      className="grow-0"
    >
      <View className="flex-row gap-2.5">
        {props.attachments.map((attachment) => (
          <View key={attachment.id} className="relative">
            <ComposerAttachmentThumbnail
              attachment={attachment}
              size={size}
              borderRadius={radius}
              onPressPreview={setPreview}
              onPressDocument={props.onPressDocument}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${attachment.name}`}
              className="absolute h-[22px] w-[22px] items-center justify-center rounded-[11px] bg-black/55"
              style={{ top: 4, right: 4 }}
              hitSlop={6}
              onPress={() => props.onRemove(attachment.id)}
            >
              <SymbolView
                name="xmark"
                size={9}
                tintColor="#ffffff"
                type="monochrome"
                weight="bold"
              />
            </Pressable>
          </View>
        ))}
        {Array.from({ length: uploading }, (_, index) => (
          <ComposerUploadingThumbnail key={`uploading:${index}`} size={size} borderRadius={radius} />
        ))}
      </View>
      {preview ? <FilePreview source={preview} onRequestClose={() => setPreview(null)} /> : null}
    </ScrollView>
  );
}
