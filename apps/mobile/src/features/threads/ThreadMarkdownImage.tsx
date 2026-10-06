// Adapted from T3 Code apps/mobile/src/features/threads/ThreadMarkdownImage.tsx (MIT, see UPSTREAM.md).
// No media actions menu or Quick Look source; host files load through `useHostMediaUrl`.
import { createContext, useContext, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { ResolvedFilePreviewSource } from "../../components/FilePreview";
import type { HostConnection } from "../hosts/host-connections";
import { useHostMediaUrl, type HostMediaRequest } from "../files/host-media-url";
import {
  MARKDOWN_IMAGE_MAX_WIDTH,
  type MarkdownImageDisplaySize,
  resolveMarkdownImageDisplaySize,
} from "./markdownImageSize";

/**
 * Width the feed lays markdown out in. The feed already knows this from its
 * viewport, so an image can size its frame on the first render instead of
 * waiting for its own onLayout, which would change the row's height once
 * more after the list has positioned the rows below it. It is an upper
 * bound: a list item or blockquote indents its column, and the measured
 * width takes over once it is known.
 */
export const MarkdownImageAvailableWidthContext = createContext(0);

export function ThreadMarkdownImageView(props: {
  readonly uri: string | null;
  readonly sourceKey: string;
  readonly unavailable: boolean;
  readonly alt: string | null;
  /** Pixel size from the server, when it could read the header; the frame is final from the first render. */
  readonly knownSize?: { readonly width: number; readonly height: number } | undefined;
  /** The authored reference: a host path or a URL. */
  readonly caption?: string;
  readonly name?: string;
  readonly onPressPreview: (source: ResolvedFilePreviewSource) => void;
}) {
  const contextWidth = useContext(MarkdownImageAvailableWidthContext);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const availableWidth =
    measuredWidth > 0 && contextWidth > 0
      ? Math.min(contextWidth, measuredWidth)
      : contextWidth || measuredWidth;
  const [decodedSize, setDecodedSize] = useState<{ width: number; height: number } | null>(null);
  const [failedUri, setFailedUri] = useState<string | null>(null);

  useEffect(() => {
    setDecodedSize(null);
  }, [props.sourceKey]);

  useEffect(() => {
    setFailedUri(null);
  }, [props.uri]);

  // The decoded size is what the platform actually drew, so it wins over the
  // server's header hint once it exists.
  const sourceSize = decodedSize ?? props.knownSize ?? null;
  const displaySize: MarkdownImageDisplaySize | null =
    sourceSize === null || availableWidth <= 0
      ? null
      : resolveMarkdownImageDisplaySize({
          sourceWidth: sourceSize.width,
          sourceHeight: sourceSize.height,
          availableWidth,
        });
  const failed = props.unavailable || (props.uri !== null && failedUri === props.uri);
  const placeholderWidth: ViewStyle["width"] =
    availableWidth > 0 ? Math.min(availableWidth, MARKDOWN_IMAGE_MAX_WIDTH) : "100%";
  const frameStyle: ViewStyle = displaySize ?? { width: placeholderWidth, aspectRatio: 16 / 9 };

  return (
    <View
      onLayout={(event) => setMeasuredWidth(event.nativeEvent.layout.width)}
      style={{ alignSelf: "stretch", gap: 6 }}
    >
      {props.uri === null || failed ? (
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={props.alt ?? "Markdown image"}
          className="items-center justify-center rounded-[10px] bg-md-code-bg"
          style={frameStyle}
        >
          {failed ? (
            <Text className="text-xs text-foreground-muted">Image unavailable</Text>
          ) : (
            <ActivityIndicator />
          )}
        </View>
      ) : (
        <Pressable
          accessibilityRole="imagebutton"
          accessibilityLabel={props.alt ?? "Markdown image"}
          onPress={() =>
            props.onPressPreview({
              kind: "image",
              uri: props.uri!,
              name: props.name ?? props.alt ?? "Image",
              ...(props.caption ? { caption: props.caption } : {}),
            })
          }
          style={{ alignSelf: "flex-start" }}
        >
          <View
            className="items-center justify-center overflow-hidden rounded-[10px] bg-md-code-bg"
            style={frameStyle}
          >
            <ThreadMarkdownImageRequest
              key={props.uri}
              uri={props.uri}
              onLoad={setDecodedSize}
              onError={() => setFailedUri(props.uri)}
            />
          </View>
        </Pressable>
      )}
      {props.alt ? (
        <Text selectable className="text-xs text-foreground-muted">
          {props.alt}
        </Text>
      ) : null}
    </View>
  );
}

function ThreadMarkdownImageRequest(props: {
  readonly uri: string;
  readonly onLoad: (sourceSize: { width: number; height: number }) => void;
  readonly onError: () => void;
}) {
  const [loaded, setLoaded] = useState(false);

  return (
    <>
      <Image
        source={{ uri: props.uri }}
        resizeMode="contain"
        accessible={false}
        onLoad={(event) => {
          setLoaded(true);
          props.onLoad(event.nativeEvent.source);
        }}
        onError={props.onError}
        style={{ width: "100%", height: "100%", opacity: loaded ? 1 : 0 }}
      />
      {loaded ? null : (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}
        >
          <Text className="text-xs text-foreground-muted">Loading image…</Text>
        </View>
      )}
    </>
  );
}

/** A host file image that loads through a URL the host signs. */
export function ThreadMarkdownImage(props: {
  readonly connection: HostConnection | null;
  readonly request: HostMediaRequest;
  readonly alt: string | null;
  readonly name: string;
  readonly onPressPreview: (source: ResolvedFilePreviewSource) => void;
}) {
  const { state } = useHostMediaUrl(props.connection, props.request);

  return (
    <ThreadMarkdownImageView
      uri={state.kind === "ready" ? state.url : null}
      sourceKey={`host:${props.request.path}`}
      unavailable={state.kind === "failed"}
      alt={props.alt}
      name={props.name}
      caption={props.request.path}
      onPressPreview={props.onPressPreview}
    />
  );
}

export function ThreadMarkdownImageUnavailable(props: { readonly alt: string | null }) {
  return (
    <ThreadMarkdownImageView
      uri={null}
      sourceKey="unavailable"
      unavailable
      alt={props.alt}
      onPressPreview={() => undefined}
    />
  );
}
