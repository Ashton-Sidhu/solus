// Adapted from T3 Code apps/mobile/src/features/threads/ThreadFeed.tsx and src/native/useMarkdownImageSource.ts (MIT, see UPSTREAM.md).
// T3's Markdown text styles (`useMarkdownStyles`), link press handler
// (`onMarkdownLinkPress`), image renderer (`renderMarkdownImage`), and native
// image source, on Solus's host connection. A media link (image, PDF, video)
// opens its viewer before ordinary routing; any other host file opens the file
// screen. Every host file loads through a URL the host signs.
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { memo, useCallback, useMemo, useState } from "react";
import { Linking } from "react-native";

import { useApp } from "../../app/app-context";
import type { FilePreviewSource } from "../../components/FilePreview.types";
import { FilePreviewModal } from "../../components/FilePreviewModal";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import type { RootStackParamList } from "../../navigation/routes";
import { resolveMarkdownLinkPresentation } from "../../lib/markdownLinks";
import {
  resolveMarkdownMediaPreview,
  type MarkdownMediaContext,
} from "../../lib/markdownMedia";
import { useNativeMarkdownTextStyle, type MarkdownTone } from "../../lib/nativeMarkdownTextStyle";
import {
  SelectableMarkdownText,
  type MarkdownImageRenderer,
  type MarkdownImageSourceResolver,
} from "../../native/SelectableMarkdownText";
import type { ConversationStore } from "../conversation/conversation-store";
import { projectContext } from "../conversation/lib/ipc-context";
import { resolveHostMediaUrl, type HostPathRequest } from "../files/host-media-url";
import {
  isSvgImage,
  ThreadMarkdownImage,
  ThreadMarkdownImageUnavailable,
  ThreadMarkdownImageView,
} from "./ThreadMarkdownImage";
import { ThreadMarkdownVideo } from "./ThreadMarkdownVideo";

function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * Selectable transcript Markdown, drawn by Enriched on iOS and Android. A
 * standalone image or video is a React media slot; an image Enriched draws
 * itself (in a table, list, or quote) loads through `resolveImageSource`.
 * `@path` mentions in user text are file chips, as T3 shows mentions only in
 * user messages.
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
  const [filePreview, setFilePreview] = useState<FilePreviewSource | null>(null);
  const [videoPreview, setVideoPreview] = useState<VideoPreviewSource | null>(null);

  const hostRequest = useCallback(
    (path: string): HostPathRequest | null =>
      isAbsoluteHostPath(path)
        ? { path }
        : workingDirectory
          ? { path, ctx: projectContext(workingDirectory, organizationId) }
          : null,
    [organizationId, workingDirectory],
  );

  const media = useMemo<MarkdownMediaContext>(
    () => ({
      hostFile: (path) => {
        const request = hostRequest(path);
        if (!request) return null;
        return {
          path,
          relativePath: isAbsoluteHostPath(path) ? undefined : path,
          resolveUri: async () => {
            const connection = app.connections.connection(hostId);
            return connection ? resolveHostMediaUrl(connection, request) : null;
          },
          route: { hostId, projectPath: workingDirectory, path },
        };
      },
    }),
    [app, hostId, hostRequest, workingDirectory],
  );

  const openMarkdownLink = useCallback(
    (href: string, imageEmbed: boolean) => {
      const preview = resolveMarkdownMediaPreview(href, media, imageEmbed);
      if (preview) {
        void Haptics.selectionAsync();
        if (preview.kind === "video") setVideoPreview((current) => current ?? preview.source);
        else setFilePreview((current) => current ?? preview.source);
        return;
      }
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
    [app, hostId, media, navigation, workingDirectory],
  );
  const onLinkPress = useCallback((href: string) => openMarkdownLink(href, false), [openMarkdownLink]);
  const onImagePress = useCallback((href: string) => openMarkdownLink(href, true), [openMarkdownLink]);

  /** An image Enriched draws itself: its own URL, or a URL the host signs for a host file. */
  const resolveImageSource = useCallback<MarkdownImageSourceResolver>(
    async (image) => {
      const preview = resolveMarkdownMediaPreview(image.href, media, true);
      const uri = preview?.kind === "image" ? await preview.source.resolveUri() : null;
      if (uri === null) throw new Error("Markdown image is unavailable");
      return { uri };
    },
    [media],
  );

  const renderImage = useCallback<MarkdownImageRenderer>(
    (image) => {
      const preview = resolveMarkdownMediaPreview(image.href, media, true);
      const presentation = resolveMarkdownLinkPresentation(image.href);
      if (preview?.kind === "video") {
        return (
          <ThreadMarkdownVideo
            key={image.href}
            source={{ ...preview.source, name: image.alt ?? preview.source.name }}
          />
        );
      }
      if (presentation.kind === "external") {
        return (
          <ThreadMarkdownImageView
            uri={presentation.href}
            sourceKey={presentation.href}
            unavailable={false}
            format={isSvgImage(presentation.href) ? "svg" : undefined}
            alt={image.alt}
            {...(preview ? { preview: preview.source } : {})}
            onPressPreview={setFilePreview}
          />
        );
      }
      if (presentation.kind !== "file") return null;
      const request = hostRequest(presentation.path);
      if (!request || !preview) return <ThreadMarkdownImageUnavailable alt={image.alt} />;
      return (
        <ThreadMarkdownImage
          connection={app.connections.connection(hostId)}
          request={request}
          alt={image.alt}
          preview={preview.source}
          onPressPreview={setFilePreview}
        />
      );
    },
    [app, hostId, hostRequest, media],
  );

  return (
    <>
      <SelectableMarkdownText
        markdown={props.markdown}
        textStyle={textStyle}
        preserveSoftBreaks={props.tone === "user"}
        recognizeFileMentions={props.tone === "user"}
        onLinkPress={onLinkPress}
        renderImage={renderImage}
        resolveImageSource={resolveImageSource}
        onImagePress={onImagePress}
      />
      <FilePreviewModal source={filePreview} onRequestClose={() => setFilePreview(null)} />
      <VideoPreviewModal source={videoPreview} onRequestClose={() => setVideoPreview(null)} />
    </>
  );
});
