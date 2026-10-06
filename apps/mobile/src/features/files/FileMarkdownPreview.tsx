// Adapted from T3 Code apps/mobile/src/features/files/FileMarkdownPreview.tsx (MIT, see UPSTREAM.md).
// Images and file links resolve on the host, next to the Markdown file.
import { resolveMarkdownLinkPresentation } from "@t3tools/mobile-markdown-text/links";
import { useCallback, useMemo, useState } from "react";
import { Linking, RefreshControl, ScrollView, View } from "react-native";

import { useApp } from "../../app/app-context";
import { FilePreview, type ResolvedFilePreviewSource } from "../../components/FilePreview";
import { useNativeMarkdownTextStyle } from "../../lib/nativeMarkdownTextStyle";
import {
  SelectableMarkdownText,
  type MarkdownImageRenderer,
} from "../../native/SelectableMarkdownText";
import { projectContext } from "../conversation/lib/ipc-context";
import { ThreadMarkdownImage, ThreadMarkdownImageView } from "../threads/ThreadMarkdownImage";
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
  const [preview, setPreview] = useState<ResolvedFilePreviewSource | null>(null);
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
  const renderImage = useCallback<MarkdownImageRenderer>(
    (image) => {
      const presentation = resolveMarkdownLinkPresentation(image.href);
      if (presentation.kind === "external") {
        return (
          <ThreadMarkdownImageView
            uri={presentation.href}
            sourceKey={presentation.href}
            unavailable={false}
            alt={image.alt}
            caption={presentation.href}
            onPressPreview={setPreview}
          />
        );
      }
      if (presentation.kind !== "file") return null;
      const path = resolveMarkdownRelativePath(props.path, presentation.path);
      return (
        <ThreadMarkdownImage
          connection={app.connections.connection(props.hostId)}
          request={{ path, ctx }}
          alt={image.alt}
          name={image.alt ?? presentation.label}
          onPressPreview={setPreview}
        />
      );
    },
    [app, ctx, props.hostId, props.path],
  );
  const onLinkPress = useCallback(
    (href: string) => {
      const presentation = resolveMarkdownLinkPresentation(href);
      if (presentation.kind === "file") {
        props.onOpenFile(resolveMarkdownRelativePath(props.path, presentation.path));
      } else if (presentation.kind === "external") {
        void app.platform.openBrowser(presentation.href);
      } else if (presentation.href) {
        void Linking.openURL(presentation.href);
      }
    },
    [app, props],
  );

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
          textStyle={textStyle}
        />
      </View>
      {preview ? <FilePreview source={preview} onRequestClose={() => setPreview(null)} /> : null}
    </ScrollView>
  );
}
