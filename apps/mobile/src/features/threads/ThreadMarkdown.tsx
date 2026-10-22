// Adapted from T3 Code apps/mobile/src/features/threads/ThreadFeed.tsx and src/native/useMarkdownImageSource.ts (MIT, see UPSTREAM.md).
// T3's Markdown text styles (`useMarkdownStyles`), link press handler
// (`onMarkdownLinkPress`), image renderer (`renderMarkdownImage`), and native
// image source, on Solus's host connection. A media link (image, PDF, video)
// opens its viewer before ordinary routing; any other host file opens the file
// screen. Every host file loads through a URL the host signs.
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { imageFileChips, replyImages } from "@solus/client-core/reply-images";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { createContext, memo, useCallback, useContext, useMemo, useState } from "react";
import { Linking } from "react-native";

import { useApp } from "../../app/app-context";
import type { FilePreviewSource } from "../../components/FilePreview.types";
import { FilePreviewGallery, useFilePreviewGallery } from "../../components/FilePreviewGallery";
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
import { linkedFolderPath } from "../files/lib/file-tree";
import {
  isSvgImage,
  ThreadMarkdownImage,
  ThreadMarkdownImageUnavailable,
  ThreadMarkdownImageView,
} from "./ThreadMarkdownImage";
import { ThreadMarkdownVideo } from "./ThreadMarkdownVideo";
import { parseReviewCommentMessageSegments } from "@solus/contracts/review-comment";
import { ReviewCommentCard } from "../review/ReviewCommentCard";

function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * "Quote in reply" for the selection menu of transcript Markdown. Only the
 * thread screen gives it, where the composer that takes the quote is mounted.
 */
export const QuoteInReplyContext = createContext<((text: string) => void) | null>(null);

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
  readonly imagesOnly?: boolean;
  readonly imageLabel?: string;
}) {
  const markdown = useMemo(() => props.tone === "assistant" && !props.imagesOnly ? imageFileChips(props.markdown) : props.markdown, [props.markdown, props.tone, props.imagesOnly]);
  // A user message can hold review cards between its prose.
  const reviewSegments = useMemo(
    () => (props.tone === "user" ? parseReviewCommentMessageSegments(markdown) : []),
    [markdown, props.tone],
  );
  const hasReviewComments = reviewSegments.some((segment) => segment.kind === "review-comment");
  const fileChipHrefs = useMemo(() => props.tone === "assistant" && !props.imagesOnly ? replyImages(props.markdown).map((image) => image.href) : [], [props.markdown, props.tone, props.imagesOnly]);
  const images = useMemo(() => props.imagesOnly ? replyImages(props.markdown) : [], [props.markdown, props.imagesOnly]);
  const gallery = useContext(FilePreviewGallery);
  const quoteInReply = useContext(QuoteInReplyContext);
  const withGallery = useFilePreviewGallery();
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
      assetUrl: async (assetId) => {
        const connection = app.connections.connection(hostId);
        return connection ? resolveHostMediaUrl(connection, { assetId }) : null;
      },
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
        // A partial or `~` path goes to the host as written: `readProjectFile`
        // expands `~` and completes a basename against the project index.
        const folderPath = workingDirectory ? linkedFolderPath(presentation.path, workingDirectory) : null;
        if (folderPath !== null) {
          navigation.navigate("Files", { hostId, projectPath: workingDirectory, folderPath });
          return;
        }
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
      if (presentation.kind === "session") {
        void Haptics.selectionAsync();
        navigation.navigate("Thread", { hostId: presentation.serverId ?? hostId, sessionId: presentation.sessionId });
        return;
      }
      if (presentation.href) void Linking.openURL(presentation.href);
    },
    [app, hostId, media, navigation, workingDirectory],
  );
  const onLinkPress = useCallback((href: string) => openMarkdownLink(href, fileChipHrefs.includes(href)), [openMarkdownLink, fileChipHrefs]);
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
      if (image.href.startsWith("asset://")) {
        return <ThreadMarkdownImage connection={app.connections.connection(hostId)} request={{ assetId: image.href.slice(8) }} preview={gallery.find((item) => item.key === image.href)} alt={image.alt} thumbnail={props.imagesOnly} onPressPreview={setFilePreview} />;
      }
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
            thumbnail={props.imagesOnly}
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
          thumbnail={props.imagesOnly}
          connection={app.connections.connection(hostId)}
          request={request}
          alt={image.alt}
          preview={preview.source}
          onPressPreview={setFilePreview}
        />
      );
    },
    [app, gallery, hostId, hostRequest, media, props.imagesOnly],
  );

  return (
    <>
      {hasReviewComments ? (
        <View className="w-full gap-2">
          {reviewSegments.map((segment) =>
            segment.kind === "review-comment" ? (
              <ReviewCommentCard key={segment.comment.id} comment={segment.comment} />
            ) : (
              <ThreadMarkdown key={segment.id} markdown={segment.text} tone={props.tone} store={props.store} />
            ),
          )}
        </View>
      ) : props.imagesOnly ? images.map((image, index) => (
        <Pressable
          key={index}
          accessibilityRole="imagebutton"
          accessibilityLabel={`Open ${props.imageLabel ?? image.label}`}
          onPress={() => {
            const resolved = resolveMarkdownMediaPreview(image.href, media, true);
            const preview = gallery.find((item) => item.key === image.href) ?? (resolved?.kind === "image" ? resolved.source : undefined);
            if (preview) setFilePreview(withGallery(preview));
          }}
          className="my-1 rounded-lg border border-border-subtle bg-subtle p-2"
          style={{ width: 128 }}
        >
          <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {renderImage({ href: image.href, alt: props.imageLabel ?? image.label, title: null })}
          <Text numberOfLines={1} className="mt-1.5 text-xs text-foreground">{props.imageLabel ?? image.label}</Text>
          <Text className="text-xs text-foreground-muted">{image.format}</Text>
          </View>
        </Pressable>
      )) : <SelectableMarkdownText
        markdown={markdown}
        textStyle={textStyle}
        preserveSoftBreaks={props.tone === "user"}
        recognizeFileMentions={props.tone === "user"}
        fileChipHrefs={fileChipHrefs}
        onLinkPress={onLinkPress}
        renderImage={renderImage}
        resolveImageSource={resolveImageSource}
        onImagePress={onImagePress}
        onQuote={quoteInReply ?? undefined}
      />}
      <FilePreviewModal source={filePreview} onRequestClose={() => setFilePreview(null)} />
      <VideoPreviewModal source={videoPreview} onRequestClose={() => setVideoPreview(null)} />
    </>
  );
});
