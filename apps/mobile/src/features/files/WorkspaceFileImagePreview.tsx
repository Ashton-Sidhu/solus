// Adapted from T3 Code apps/mobile/src/features/files/WorkspaceFileImagePreview.tsx (MIT, see UPSTREAM.md).
import { useMemo, useState } from "react";
import { ActivityIndicator, Image, Pressable, View } from "react-native";

import { EmptyState } from "../../components/EmptyState";
import { FilePreview, type ResolvedFilePreviewSource } from "../../components/FilePreview";

function ResolvedWorkspaceFileImagePreview(props: {
  readonly accessibilityLabel: string;
  readonly uri: string;
  readonly caption: string;
}) {
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ResolvedFilePreviewSource | null>(null);
  const imageSource = useMemo(
    () => ({ uri: props.uri, cache: "force-cache" as const }),
    [props.uri],
  );

  return (
    <View className="relative flex-1 bg-subtle">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open full-screen preview of ${props.accessibilityLabel}`}
        disabled={loadError !== null}
        className="flex-1 p-4 active:bg-subtle-strong"
        onPress={() =>
          setPreview({
            kind: "image",
            uri: props.uri,
            name: props.accessibilityLabel,
            caption: props.caption,
          })
        }
      >
        <Image
          accessible={false}
          source={imageSource}
          className="h-full w-full"
          resizeMode="contain"
          onLoadStart={() => setLoadError(null)}
          onError={(event) => {
            setLoadError(event.nativeEvent.error || "The image could not be rendered.");
          }}
        />
      </Pressable>
      {loadError !== null ? (
        <View
          pointerEvents="none"
          className="absolute inset-0 items-center justify-center bg-card px-6"
        >
          <EmptyState title="Image unavailable" detail={loadError} />
        </View>
      ) : null}
      {preview ? <FilePreview source={preview} onRequestClose={() => setPreview(null)} /> : null}
    </View>
  );
}

export function WorkspaceFileImagePreview(props: {
  readonly accessibilityLabel: string;
  readonly uri: string | null;
  /** The host path, shown under the name in the full-screen viewer. */
  readonly caption: string;
}) {
  if (props.uri === null) {
    return (
      <View className="flex-1 items-center justify-center bg-card">
        <ActivityIndicator accessibilityLabel="Preparing image preview" />
      </View>
    );
  }

  return (
    <ResolvedWorkspaceFileImagePreview
      accessibilityLabel={props.accessibilityLabel}
      uri={props.uri}
      caption={props.caption}
    />
  );
}
