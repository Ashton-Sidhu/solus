// Adapted from T3 Code apps/mobile/src/features/files/FileMarkdownPreview.tsx (MIT, see UPSTREAM.md).
// Images and file links resolve on the host, next to the Markdown file. A media
// link (image, PDF, video) opens its viewer before the file screen.
import { useCallback, useMemo, useState } from "react";
import { Linking, RefreshControl, ScrollView, View } from "react-native";

import { useApp } from "../../app/app-context";
import type { FilePreviewSource } from "../../components/FilePreview.types";
import { FilePreviewModal } from "../../components/FilePreviewModal";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { resolveMarkdownLinkPresentation } from "../../lib/markdownLinks";
import {
  resolveMarkdownMediaPreview,
  type MarkdownMediaContext,
} from "../../lib/markdownMedia";
import { useNativeMarkdownTextStyle } from "../../lib/nativeMarkdownTextStyle";
import {
  SelectableMarkdownText,
  type MarkdownImageRenderer,
  type MarkdownImageSourceResolver,
} from "../../native/SelectableMarkdownText";
import { projectContext } from "../conversation/lib/ipc-context";
import { resolveHostMediaUrl } from "./host-media-url";
import {
  isSvgImage,
  ThreadMarkdownImage,
  ThreadMarkdownImageView,
} from "../threads/ThreadMarkdownImage";
import { ThreadMarkdownVideo } from "../threads/ThreadMarkdownVideo";
import { resolveMarkdownRelativePath } from "./lib/file-preview-kind";

export function FileMarkdownPreview(props: {
  readonly hostId: string;
  readonly projectPath: string;
  readonly markdown: string;
  /** The Markdown file, as the file screen names it: project-relative or absolute. */
  readonly path: string;
  readonly onOpenFile: (path: string) => void;
  readonly onRefresh?: () => Promise<void> | void;
}) {
  const app = useApp();
  const textStyle = useNativeMarkdownTextStyle("assistant");
  const [filePreview, setFilePreview] = useState<FilePreviewSource | null>(null);
  const [videoPreview, setVideoPreview] = useState<VideoPreviewSource | null>(null);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const handlePullToRefresh = useCallback(async () => {
    if (!props.onRefresh) {
      return;
    }
    setIsPullRefreshing(true);
    try {
      await props.onRefresh();
    } finally {
      setIsPullRefreshing(false);
    }
  }, [props.onRefresh]);
  const ctx = useMemo(
    () => projectContext(props.projectPath, app.account.organizationId),
    [app, props.projectPath],
  );
  const media = useMemo<MarkdownMediaContext>(
    () => ({
      hostFile: (target) => {
        const path = resolveMarkdownRelativePath(props.path, target);
        return {
          path,
          relativePath: path.startsWith("/") || path.startsWith("~") ? undefined : path,
          resolveUri: async () => {
            const connection = app.connections.connection(props.hostId);
            return connection ? resolveHostMediaUrl(connection, { path, ctx }) : null;
          },
          route: { hostId: props.hostId, projectPath: props.projectPath, path },
        };
      },
    }),
    [app, ctx, props.hostId, props.path, props.projectPath],
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
      if (presentation.kind !== "file" || !preview) return null;
      const path = resolveMarkdownRelativePath(props.path, presentation.path);
      return (
        <ThreadMarkdownImage
          connection={app.connections.connection(props.hostId)}
          request={{ path, ctx }}
          alt={image.alt}
          preview={preview.source}
          onPressPreview={setFilePreview}
        />
      );
    },
    [app, ctx, media, props.hostId, props.path],
  );
  /** An image Enriched draws itself: its own URL, or a URL the host signs for the file next to this one. */
  const resolveImageSource = useCallback<MarkdownImageSourceResolver>(
    async (image) => {
      const preview = resolveMarkdownMediaPreview(image.href, media, true);
      const uri = preview?.kind === "image" ? await preview.source.resolveUri() : null;
      if (uri === null) throw new Error("Markdown image is unavailable");
      return { uri };
    },
    [media],
  );
  const openMarkdownLink = useCallback(
    (href: string, imageEmbed: boolean) => {
      const preview = resolveMarkdownMediaPreview(href, media, imageEmbed);
      if (preview?.kind === "video") {
        setVideoPreview((current) => current ?? preview.source);
        return;
      }
      if (preview) {
        setFilePreview((current) => current ?? preview.source);
        return;
      }
      const presentation = resolveMarkdownLinkPresentation(href);
      if (presentation.kind === "file") {
        props.onOpenFile(resolveMarkdownRelativePath(props.path, presentation.path));
      } else if (presentation.kind === "external") {
        void app.platform.openBrowser(presentation.href);
      } else if (presentation.href) {
        void Linking.openURL(presentation.href);
      }
    },
    [app, media, props],
  );
  const onLinkPress = useCallback((href: string) => openMarkdownLink(href, false), [openMarkdownLink]);
  const onImagePress = useCallback((href: string) => openMarkdownLink(href, true), [openMarkdownLink]);

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 18 }}
      refreshControl={
        props.onRefresh ? (
          <RefreshControl
            refreshing={isPullRefreshing}
            onRefresh={() => void handlePullToRefresh()}
          />
        ) : undefined
      }
    >
      <View className="mx-auto w-full max-w-[760px]">
        <SelectableMarkdownText
          markdown={props.markdown}
          onLinkPress={onLinkPress}
          renderImage={renderImage}
          resolveImageSource={resolveImageSource}
          onImagePress={onImagePress}
          textStyle={textStyle}
        />
      </View>
      <FilePreviewModal source={filePreview} onRequestClose={() => setFilePreview(null)} />
      <VideoPreviewModal source={videoPreview} onRequestClose={() => setVideoPreview(null)} />
    </ScrollView>
  );
}
