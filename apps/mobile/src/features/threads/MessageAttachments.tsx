// Adapted from T3 Code apps/mobile/src/features/threads/ThreadFeed.tsx
// (MessageAttachmentImage, MessageAttachmentFile; MIT, see UPSTREAM.md).
// Host files load through `useHostMediaUrl`; no share or Quick Look actions.
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { memo, useCallback, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, View } from "react-native";

import { useApp } from "../../app/app-context";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useDataUrlPreviewUri } from "../../components/ComposerAttachmentStrip";
import { FilePreview, type ResolvedFilePreviewSource } from "../../components/FilePreview";
import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import type { RootStackParamList } from "../../navigation/routes";
import type { ConversationStore } from "../conversation/conversation-store";
import { attachmentTypeLabel, type MessageAttachment } from "../conversation/lib/message-attachments";
import type { HostConnection } from "../hosts/host-connections";
import { useHostMediaUrl } from "../files/host-media-url";

/** T3's attachment-only bubble: each picture full width at 1.3:1, files as cards. */
const IMAGE_ASPECT_RATIO = 1.3;
const IMAGE_RADIUS = 14;
const FILE_CARD_WIDTH = 280;

function AttachmentImageFrame(props: {
  readonly uri: string | null;
  readonly name: string;
  readonly width: number;
  readonly unavailable: boolean;
  readonly onError?: () => void;
  readonly onPressPreview: (source: ResolvedFilePreviewSource) => void;
}) {
  const frame = { width: props.width, aspectRatio: IMAGE_ASPECT_RATIO, borderRadius: IMAGE_RADIUS };
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
      onPress={() => props.onPressPreview({ kind: "image", uri, name: props.name })}
    >
      <Image
        source={{ uri }}
        className="bg-user-bubble-foreground/15"
        style={frame}
        resizeMode="cover"
        onError={props.onError}
      />
    </Pressable>
  );
}

/** Bytes the prompt carried, shown from a cache file rather than the data URL. */
function InlineAttachmentImage(props: {
  readonly cacheKey: string;
  readonly dataUrl: string;
  readonly name: string;
  readonly width: number;
  readonly onPressPreview: (source: ResolvedFilePreviewSource) => void;
}) {
  const uri = useDataUrlPreviewUri(props.cacheKey, props.dataUrl);
  return <AttachmentImageFrame uri={uri} name={props.name} width={props.width} unavailable={false} onPressPreview={props.onPressPreview} />;
}

/** A picture stored on the session's host, through a signed URL it mints. */
function HostAttachmentImage(props: {
  readonly connection: HostConnection | null;
  readonly hostPath: string;
  readonly name: string;
  readonly width: number;
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
      width={props.width}
      unavailable={state.kind === "failed"}
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

/** T3's file card: a type tile, the name, its type, and a way in. */
function AttachmentFileCard(props: {
  readonly name: string;
  readonly onPress: (() => void) | null;
}) {
  const typeLabel = attachmentTypeLabel(props.name);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${props.name}`}
      accessibilityValue={{ text: typeLabel }}
      accessibilityState={{ disabled: props.onPress === null }}
      disabled={props.onPress === null}
      className="my-1 min-w-0 flex-row items-center gap-3 rounded-xl border border-border bg-card p-3 active:bg-subtle"
      style={{ width: FILE_CARD_WIDTH, maxWidth: "100%" }}
      onPress={props.onPress ?? undefined}
    >
      <View className="h-12 w-10 shrink-0 items-center justify-center rounded-lg bg-subtle">
        <PierreEntryIcon path={props.name} size={26} />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <Text className="font-t3-medium text-sm text-foreground" numberOfLines={2}>
          {props.name}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {typeLabel}
        </Text>
      </View>
      {props.onPress ? (
        <SymbolView name="chevron.right" size={12} tintColorClassName="accent-foreground-muted" type="monochrome" />
      ) : null}
    </Pressable>
  );
}

/**
 * What a sent prompt carried, inside its bubble: pictures first, stacked full
 * width as T3 draws them, then files. `cacheKey` scopes the cache files of
 * inline pictures to this one message.
 */
export const MessageAttachments = memo(function MessageAttachments(props: {
  readonly attachments: readonly MessageAttachment[];
  readonly cacheKey: string;
  /** The bubble's inner width, which a picture fills. */
  readonly width: number;
  readonly store: ConversationStore;
}) {
  const app = useApp();
  const openHostFile = useOpenHostFile(props.store);
  const [preview, setPreview] = useState<ResolvedFilePreviewSource | null>(null);
  if (props.attachments.length === 0) return null;
  const connection = app.connections.connection(props.store.controller.hostId);
  const ordered = [
    ...props.attachments.filter((attachment) => attachment.kind !== "file"),
    ...props.attachments.filter((attachment) => attachment.kind === "file"),
  ];
  return (
    <View className="gap-2">
      {ordered.map((attachment) => {
        if (attachment.kind === "image") {
          return (
            <InlineAttachmentImage
              key={attachment.key}
              cacheKey={`${props.cacheKey}-${attachment.key}`}
              dataUrl={attachment.dataUrl}
              name={attachment.name}
              width={props.width}
              onPressPreview={setPreview}
            />
          );
        }
        if (attachment.kind === "host-image") {
          return (
            <HostAttachmentImage
              key={attachment.key}
              connection={connection}
              hostPath={attachment.hostPath}
              name={attachment.name}
              width={props.width}
              onPressPreview={setPreview}
            />
          );
        }
        if (attachment.video) {
          return (
            <View key={attachment.key} style={{ width: props.width }}>
              <HostAttachmentVideo connection={connection} hostPath={attachment.hostPath} name={attachment.name} />
            </View>
          );
        }
        return (
          <AttachmentFileCard
            key={attachment.key}
            name={attachment.name}
            onPress={() => openHostFile(attachment.hostPath)}
          />
        );
      })}
      {preview ? <FilePreview source={preview} onRequestClose={() => setPreview(null)} /> : null}
    </View>
  );
});
