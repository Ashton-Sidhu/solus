// Adapted from T3 Code apps/mobile/src/features/threads/ThreadFeed.tsx
// (MessageAttachmentImage, MessageAttachmentFile; MIT, see UPSTREAM.md).
// Host files load through `useHostMediaUrl`; a picture opens in `FilePreview` (Quick Look
// on iOS) without the media actions menu.
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { memo, useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, Image, Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import { mediaTypeFor } from "@solus/contracts/media-types";

import { useApp } from "../../app/app-context";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useDataUrlPreviewUri } from "../../components/ComposerAttachmentStrip";
import { FilePreview, type ResolvedFilePreviewSource } from "../../components/FilePreview";
import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import type { RootStackParamList } from "../../navigation/routes";
import type { ConversationStore } from "../conversation/conversation-store";
import {
  attachmentCardDetail,
  attachmentDisplayName,
  collageRows,
  type MessageAttachment,
} from "../conversation/lib/message-attachments";
import type { HostConnection } from "../hosts/host-connections";
import { resolveHostMediaUrl, useHostMediaUrl } from "../files/host-media-url";
import { downloadAndShareAttachment } from "../../lib/attachmentDownload";

/** Media above the bubble shares the bubble's 20pt corners. */
const MEDIA_RADIUS = 20;
/** A lone picture's fixed height: the row does not grow when it loads. */
const LONE_IMAGE_HEIGHT = 192;
/** Before a lone picture loads, its frame assumes 4:3. */
const LONE_IMAGE_DEFAULT_ASPECT = 4 / 3;
const COLLAGE_WIDTH = 320;
const VIDEO_WIDTH = 320;
const FILE_CARD_WIDTH = 280;

function AttachmentImageFrame(props: {
  readonly uri: string | null;
  readonly name: string;
  /** The frame's size: a lone picture's own, or its collage cell. */
  readonly frame: ViewStyle;
  readonly unavailable: boolean;
  readonly onError?: () => void;
  /** The picture's own aspect ratio, once its bytes load. */
  readonly onAspect?: (aspect: number) => void;
  readonly onPressPreview: (source: ResolvedFilePreviewSource) => void;
}) {
  const frame = props.frame;
  if (props.uri === null) {
    return (
      <View
        accessible
        accessibilityLabel={props.unavailable ? `${props.name} is unavailable` : `Loading ${props.name}`}
        className="items-center justify-center bg-user-bubble-foreground/15"
        style={frame}
      >
        {props.unavailable ? (
          <SymbolView name="photo" size={20} tintColorClassName="accent-icon-muted" type="monochrome" />
        ) : (
          <ActivityIndicator />
        )}
      </View>
    );
  }
  const uri = props.uri;
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`Open ${props.name}`}
      style={frame}
      onPress={() => props.onPressPreview({ kind: "image", uri, name: props.name })}
    >
      <Image
        source={{ uri }}
        className="bg-user-bubble-foreground/15"
        style={{ width: "100%", height: "100%" }}
        resizeMode="cover"
        onError={props.onError}
        onLoad={(event) => {
          const { width, height } = event.nativeEvent.source;
          if (width > 0 && height > 0) props.onAspect?.(width / height);
        }}
      />
    </Pressable>
  );
}

/** Bytes the prompt carried, shown from a cache file rather than the data URL. */
function InlineAttachmentImage(props: {
  readonly cacheKey: string;
  readonly dataUrl: string;
  readonly name: string;
  readonly frame: ViewStyle;
  readonly onAspect?: (aspect: number) => void;
  readonly onPressPreview: (source: ResolvedFilePreviewSource) => void;
}) {
  const uri = useDataUrlPreviewUri(props.cacheKey, props.dataUrl);
  return (
    <AttachmentImageFrame
      uri={uri}
      name={props.name}
      frame={props.frame}
      unavailable={false}
      onAspect={props.onAspect}
      onPressPreview={props.onPressPreview}
    />
  );
}

/** A picture stored on the session's host, through a signed URL it mints. */
function HostAttachmentImage(props: {
  readonly connection: HostConnection | null;
  readonly hostPath: string;
  readonly name: string;
  readonly frame: ViewStyle;
  readonly onAspect?: (aspect: number) => void;
  readonly onPressPreview: (source: ResolvedFilePreviewSource) => void;
}) {
  const { state, refresh } = useHostMediaUrl(props.connection, { path: props.hostPath });
  // One renewal per failure, as T3 retries an expired URL once.
  const retried = useRef(false);
  const [renewed, setRenewed] = useState<string | null>(null);
  const uri = renewed ?? (state.kind === "ready" ? state.url : null);
  return (
    <AttachmentImageFrame
      uri={uri}
      name={props.name}
      frame={props.frame}
      unavailable={state.kind === "failed"}
      onAspect={props.onAspect}
      onError={() => {
        if (retried.current) return;
        retried.current = true;
        void refresh().then((url) => setRenewed(url));
      }}
      onPressPreview={props.onPressPreview}
    />
  );
}

function HostAttachmentVideo(props: {
  readonly connection: HostConnection | null;
  readonly hostPath: string;
  readonly name: string;
}) {
  const { state, refresh } = useHostMediaUrl(props.connection, { path: props.hostPath });
  return (
    <MediaVideoPlayer
      uri={state.kind === "ready" ? state.url : null}
      resolvePlaybackUri={refresh}
      name={props.name}
      thumbnailKey={`host:${props.connection?.hostId ?? ""}:${props.hostPath}`}
      unavailable={state.kind === "failed"}
    />
  );
}

/** Opens an attachment stored on this conversation's host, in the file viewer. */
export function useOpenHostFile(store: ConversationStore): (hostPath: string) => void {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const hostId = store.controller.hostId;
  return useCallback(
    (hostPath: string) => {
      void Haptics.selectionAsync();
      navigation.navigate("File", { hostId, projectPath: store.controller.run.workingDirectory, path: hostPath });
    },
    [hostId, navigation, store],
  );
}

/** The original bytes through a URL the host signs, then the native save or
 *  share sheet. Outside the component: the React Compiler skips a component
 *  that holds a try/catch. */
async function saveHostFile(connection: HostConnection, name: string, hostPath: string): Promise<void> {
  try {
    const url = await resolveHostMediaUrl(connection, { path: hostPath });
    await downloadAndShareAttachment({
      url,
      attachment: { name, mimeType: mediaTypeFor(name)?.mime ?? "application/octet-stream" },
      signal: new AbortController().signal,
    });
  } catch (error) {
    Alert.alert("Could not save file", error instanceof Error ? error.message : "Try again.");
  }
}

/** A file sent without words: a type tile, the name, its type, a way in, and a way to save it. */
function AttachmentFileCard(props: {
  readonly name: string;
  readonly sending: boolean;
  readonly onPress: (() => void) | null;
  /** Saves or shares the original bytes; null while the prompt is still on its way. */
  readonly onDownload: (() => Promise<void>) | null;
}) {
  const [downloading, setDownloading] = useState(false);
  const label = attachmentDisplayName(props.name);
  const detail = attachmentCardDetail(props.name, props.sending);
  const onDownload = props.onDownload;
  return (
    <View
      className="min-w-0 flex-row items-center rounded-[20px] border border-border bg-card"
      style={{ width: FILE_CARD_WIDTH, maxWidth: "100%" }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${label}`}
        accessibilityValue={{ text: detail }}
        accessibilityState={{ disabled: props.onPress === null }}
        disabled={props.onPress === null}
        className="min-w-0 flex-1 flex-row items-center gap-3 rounded-[20px] p-3 active:bg-subtle"
        onPress={props.onPress ?? undefined}
      >
        <View className="h-12 w-10 shrink-0 items-center justify-center rounded-lg bg-subtle">
          <PierreEntryIcon path={props.name} size={26} />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <Text className="font-t3-medium text-sm text-foreground" numberOfLines={2}>
            {label}
          </Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {detail}
          </Text>
        </View>
      </Pressable>
      {onDownload ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={downloading ? `Saving ${props.name}` : `Save or share ${props.name}`}
          accessibilityState={{ busy: downloading, disabled: downloading }}
          disabled={downloading}
          hitSlop={4}
          className="mr-1.5 size-11 items-center justify-center rounded-full active:bg-subtle"
          onPress={() => {
            setDownloading(true);
            void onDownload().finally(() => setDownloading(false));
          }}
        >
          {downloading ? (
            <ActivityIndicator />
          ) : (
            <SymbolView name="square.and.arrow.up" size={16} tintColorClassName="accent-foreground-muted" type="monochrome" />
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

/** A file sent with words: a chip inside the bubble, beside what was said about it. */
function AttachmentFileChip(props: { readonly name: string; readonly onPress: () => void }) {
  const label = attachmentDisplayName(props.name);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${label}`}
      hitSlop={6}
      className="min-h-8 max-w-full flex-row items-center gap-1.5 self-start rounded-[10px] bg-user-bubble-foreground/10 px-2 py-1 active:opacity-70"
      onPress={props.onPress}
    >
      <PierreEntryIcon path={props.name} size={14} />
      <Text className="shrink font-t3-medium text-xs text-user-bubble-foreground" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function MessageImage(props: {
  readonly attachment: MessageAttachment;
  readonly cacheKey: string;
  readonly connection: HostConnection | null;
  readonly frame: ViewStyle;
  readonly onAspect?: (aspect: number) => void;
  readonly onPressPreview: (source: ResolvedFilePreviewSource) => void;
}) {
  const attachment = props.attachment;
  if (attachment.kind === "image") {
    return (
      <InlineAttachmentImage
        cacheKey={`${props.cacheKey}-${attachment.key}`}
        dataUrl={attachment.dataUrl}
        name={attachment.name}
        frame={props.frame}
        onAspect={props.onAspect}
        onPressPreview={props.onPressPreview}
      />
    );
  }
  if (attachment.kind === "host-image") {
    return (
      <HostAttachmentImage
        connection={props.connection}
        hostPath={attachment.hostPath}
        name={attachment.name}
        frame={props.frame}
        onAspect={props.onAspect}
        onPressPreview={props.onPressPreview}
      />
    );
  }
  return null;
}

/** One picture at a fixed height in its own aspect ratio, capped to the row. */
function LoneImage(props: Omit<Parameters<typeof MessageImage>[0], "frame" | "onAspect"> & { readonly maxWidth: number }) {
  const [aspect, setAspect] = useState(LONE_IMAGE_DEFAULT_ASPECT);
  const width = Math.min(props.maxWidth, Math.max(96, LONE_IMAGE_HEIGHT * aspect));
  return (
    <View style={[styles.mediaEdge, { width, height: LONE_IMAGE_HEIGHT }]}>
      <MessageImage {...props} frame={{ width: "100%", height: "100%" }} onAspect={setAspect} />
    </View>
  );
}

/** Several pictures as one rounded shape, split by hairlines. */
function ImageCollage(props: {
  readonly images: readonly MessageAttachment[];
  readonly cacheKey: string;
  readonly connection: HostConnection | null;
  readonly maxWidth: number;
  readonly onPressPreview: (source: ResolvedFilePreviewSource) => void;
}) {
  const plan = collageRows(props.images.length);
  const rowHeight = props.images.length === 2 || plan.lead ? LONE_IMAGE_HEIGHT : LONE_IMAGE_HEIGHT / 2;
  const cell = (index: number) => (
    <View key={props.images[index]!.key} className="flex-1">
      <MessageImage
        attachment={props.images[index]!}
        cacheKey={props.cacheKey}
        connection={props.connection}
        frame={{ width: "100%", height: "100%" }}
        onPressPreview={props.onPressPreview}
      />
    </View>
  );
  const rows = (
    <View className="flex-1" style={{ gap: StyleSheet.hairlineWidth }}>
      {plan.rows.map((row) => (
        <View key={row.join(":")} className="flex-row" style={{ height: plan.lead ? undefined : rowHeight, flex: plan.lead ? 1 : undefined, gap: StyleSheet.hairlineWidth }}>
          {row.map(cell)}
        </View>
      ))}
    </View>
  );
  return (
    <View
      className="flex-row bg-user-bubble-foreground/15"
      style={[styles.mediaEdge, { width: Math.min(COLLAGE_WIDTH, props.maxWidth), gap: StyleSheet.hairlineWidth }]}
    >
      {plan.lead ? (
        <>
          <View style={{ flex: 3, height: rowHeight }}>{cell(0)}</View>
          <View style={{ flex: 2 }}>{rows}</View>
        </>
      ) : (
        rows
      )}
    </View>
  );
}

/**
 * Pictures and videos a prompt carried, as their own shape above its bubble,
 * as desktop draws them. `cacheKey` scopes the cache files of inline pictures
 * to this one message.
 */
export const MessageMedia = memo(function MessageMedia(props: {
  readonly images: readonly MessageAttachment[];
  readonly videos: readonly MessageAttachment[];
  readonly cacheKey: string;
  /** The widest the media may be: the bubble's own max width. */
  readonly maxWidth: number;
  readonly store: ConversationStore;
}) {
  const app = useApp();
  const [preview, setPreview] = useState<ResolvedFilePreviewSource | null>(null);
  if (props.images.length === 0 && props.videos.length === 0) return null;
  const connection = app.connections.connection(props.store.controller.hostId);
  return (
    <View className="items-end gap-1.5">
      {props.images.length === 1 ? (
        <LoneImage
          attachment={props.images[0]!}
          cacheKey={props.cacheKey}
          connection={connection}
          maxWidth={props.maxWidth}
          onPressPreview={setPreview}
        />
      ) : props.images.length > 1 ? (
        <ImageCollage
          images={props.images}
          cacheKey={props.cacheKey}
          connection={connection}
          maxWidth={props.maxWidth}
          onPressPreview={setPreview}
        />
      ) : null}
      {props.videos.map((attachment) =>
        attachment.kind === "file" ? (
          <View key={attachment.key} style={[styles.mediaEdge, { width: Math.min(VIDEO_WIDTH, props.maxWidth) }]}>
            <HostAttachmentVideo connection={connection} hostPath={attachment.hostPath} name={attachment.name} />
          </View>
        ) : null,
      )}
      {preview ? <FilePreview source={preview} onRequestClose={() => setPreview(null)} /> : null}
    </View>
  );
});

/** Files a prompt carried: chips beside its words, or cards when it has none. */
export const MessageFiles = memo(function MessageFiles(props: {
  readonly files: readonly MessageAttachment[];
  readonly variant: "chips" | "cards";
  /** The prompt is still on its way. */
  readonly sending: boolean;
  readonly store: ConversationStore;
}) {
  const app = useApp();
  const openHostFile = useOpenHostFile(props.store);
  if (props.files.length === 0) return null;
  const connection = app.connections.connection(props.store.controller.hostId);
  const download = (name: string, hostPath: string) => () =>
    connection ? saveHostFile(connection, name, hostPath) : Promise.resolve();
  return (
    <View className={props.variant === "cards" ? "items-end gap-1.5" : "flex-row flex-wrap gap-1.5"}>
      {props.files.map((attachment) => {
        if (attachment.kind !== "file") return null;
        return props.variant === "cards" ? (
          <AttachmentFileCard
            key={attachment.key}
            name={attachment.name}
            sending={props.sending}
            onPress={() => openHostFile(attachment.hostPath)}
            onDownload={props.sending || !connection ? null : download(attachment.name, attachment.hostPath)}
          />
        ) : (
          <AttachmentFileChip key={attachment.key} name={attachment.name} onPress={() => openHostFile(attachment.hostPath)} />
        );
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  // The inner edge keeps a dark picture's border on a dark screen.
  mediaEdge: {
    borderRadius: MEDIA_RADIUS,
    borderCurve: "continuous",
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(127, 127, 127, 0.25)",
  },
});
