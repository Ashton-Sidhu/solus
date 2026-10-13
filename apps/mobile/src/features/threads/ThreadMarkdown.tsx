// Adapted from T3 Code apps/mobile/src/features/threads/ThreadFeed.tsx and src/native/useMarkdownImageSource.ts (MIT, see UPSTREAM.md).
// T3's Markdown text styles (`useMarkdownStyles`), link press handler
// (`onMarkdownLinkPress`), image renderer (`renderMarkdownImage`), and native
// image source, on Solus's host connection. Every host file opens through the
// host: a signed URL for media, the file screen for anything else.
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { memo, useCallback, useState } from "react";
import { Linking } from "react-native";

import { useApp } from "../../app/app-context";
import { FilePreview, type ResolvedFilePreviewSource } from "../../components/FilePreview";
import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
import type { RootStackParamList } from "../../navigation/routes";
import { resolveMarkdownLinkPresentation } from "../../lib/markdownLinks";
import { useNativeMarkdownTextStyle, type MarkdownTone } from "../../lib/nativeMarkdownTextStyle";
import {
  SelectableMarkdownText,
  type MarkdownImageRenderer,
  type MarkdownImageSourceResolver,
} from "../../native/SelectableMarkdownText";
import type { ConversationStore } from "../conversation/conversation-store";
import { projectContext } from "../conversation/lib/ipc-context";
import { resolveHostMediaUrl, useHostMediaUrl, type HostPathRequest } from "../files/host-media-url";
import type { HostConnection } from "../hosts/host-connections";
import {
  ThreadMarkdownImage,
  ThreadMarkdownImageUnavailable,
  ThreadMarkdownImageView,
} from "./ThreadMarkdownImage";

const VIDEO_PATH_PATTERN = /\.(?:avi|m4v|mkv|mov|mp4|ogv|webm)$/i;

function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path);
}

function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1) || path;
}

function HostMarkdownVideo(props: {
  readonly connection: HostConnection | null;
  readonly request: HostPathRequest;
  readonly name: string;
}) {
  const { state, refresh } = useHostMediaUrl(props.connection, props.request);
  return (
    <MediaVideoPlayer
      uri={state.kind === "ready" ? state.url : null}
      resolvePlaybackUri={refresh}
      name={props.name}
      thumbnailKey={`host:${props.connection?.hostId ?? ""}:${props.request.path}`}
      unavailable={state.kind === "failed"}
    />
  );
}

/**
 * Selectable transcript Markdown, drawn by Enriched on iOS and Android. A
 * standalone image or video is a React media slot; an image Enriched draws
 * itself (in a table, list, or quote) loads through `resolveImageSource`.
 */
export const ThreadMarkdown = memo(function ThreadMarkdown(props: {
  readonly markdown: string;
  readonly tone: MarkdownTone;
  readonly store: ConversationStore;
}) {
  const app = useApp();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const textStyle = useNativeMarkdownTextStyle(props.tone);
  const hostId = props.store.controller.hostId;
  const workingDirectory = props.store.controller.run.workingDirectory;
  const organizationId = app.account.organizationId;
  const [preview, setPreview] = useState<ResolvedFilePreviewSource | null>(null);

  const hostRequest = useCallback(
    (path: string): HostPathRequest | null =>
      isAbsoluteHostPath(path)
        ? { path }
        : workingDirectory
          ? { path, ctx: projectContext(workingDirectory, organizationId) }
          : null,
    [organizationId, workingDirectory],
  );

  const onLinkPress = useCallback(
    (href: string) => {
      const presentation = resolveMarkdownLinkPresentation(href);
      if (presentation.kind === "file") {
        if (!isAbsoluteHostPath(presentation.path) && !workingDirectory) return;
        void Haptics.selectionAsync();
        navigation.navigate("File", {
          hostId,
          projectPath: workingDirectory,
          path: presentation.path,
        });
        return;
      }
      if (presentation.kind === "external") {
        void app.platform.openBrowser(presentation.href);
        return;
      }
      if (presentation.href) void Linking.openURL(presentation.href);
    },
    [app, hostId, navigation, workingDirectory],
  );

  /** The address of an image: its own URL, or a URL the host signs for a host file. */
  const imageUri = useCallback(
    async (href: string): Promise<string | null> => {
      const presentation = resolveMarkdownLinkPresentation(href);
      if (presentation.kind === "external") return presentation.href;
      if (presentation.kind !== "file") return null;
      const request = hostRequest(presentation.path);
      const connection = app.connections.connection(hostId);
      if (!request || !connection) return null;
      return resolveHostMediaUrl(connection, request);
    },
    [app, hostId, hostRequest],
  );

  const resolveImageSource = useCallback<MarkdownImageSourceResolver>(
    async (image) => {
      const uri = await imageUri(image.href);
      if (uri === null) throw new Error("Markdown image is unavailable");
      return { uri };
    },
    [imageUri],
  );

  const onImagePress = useCallback(
    (href: string) => {
      void imageUri(href).then(
        (uri) => {
          if (uri === null) return;
          void Haptics.selectionAsync();
          const presentation = resolveMarkdownLinkPresentation(href);
          setPreview({
            kind: "image",
            uri,
            name: presentation.kind === "file" ? presentation.label : fileName(new URL(uri).pathname),
            caption: presentation.kind === "file" ? presentation.path : uri,
          });
        },
        () => undefined,
      );
    },
    [imageUri],
  );

  const renderImage = useCallback<MarkdownImageRenderer>(
    (image) => {
      const presentation = resolveMarkdownLinkPresentation(image.href);
      if (presentation.kind === "external") {
        const name = image.alt ?? fileName(new URL(presentation.href).pathname);
        return VIDEO_PATH_PATTERN.test(new URL(presentation.href).pathname) ? (
          <MediaVideoPlayer
            uri={presentation.href}
            name={name}
            thumbnailKey={`url:${presentation.href}`}
          />
        ) : (
          <ThreadMarkdownImageView
            uri={presentation.href}
            sourceKey={presentation.href}
            unavailable={false}
            alt={image.alt}
            name={name}
            caption={presentation.href}
            onPressPreview={setPreview}
          />
        );
      }
      if (presentation.kind !== "file") return null;
      const request = hostRequest(presentation.path);
      const connection = app.connections.connection(hostId);
      const name = image.alt ?? fileName(presentation.path);
      if (!request) return <ThreadMarkdownImageUnavailable alt={image.alt} />;
      return VIDEO_PATH_PATTERN.test(presentation.path) ? (
        <HostMarkdownVideo connection={connection} request={request} name={name} />
      ) : (
        <ThreadMarkdownImage
          connection={connection}
          request={request}
          alt={image.alt}
          name={name}
          onPressPreview={setPreview}
        />
      );
    },
    [app, hostId, hostRequest],
  );

  return (
    <>
      <SelectableMarkdownText
        markdown={props.markdown}
        textStyle={textStyle}
        preserveSoftBreaks={props.tone === "user"}
        onLinkPress={onLinkPress}
        renderImage={renderImage}
        resolveImageSource={resolveImageSource}
        onImagePress={onImagePress}
      />
      {preview ? <FilePreview source={preview} onRequestClose={() => setPreview(null)} /> : null}
    </>
  );
});
