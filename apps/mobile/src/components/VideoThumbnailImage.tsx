// Adapted from T3 Code apps/mobile/src/components/VideoThumbnailImage.tsx (MIT, see UPSTREAM.md).
import { Image } from "expo-image";
import { useIsFocused } from "@react-navigation/native";
import type { VideoThumbnail } from "expo-video";
import { useEffect, useState } from "react";
import { StyleSheet } from "react-native";

import { cachedVideoThumbnail, loadVideoThumbnail } from "../lib/videoThumbnails";

export function VideoThumbnailImage(props: {
  readonly cacheKey: string;
  readonly source: string | null;
  readonly contentFit?: "cover" | "contain";
}) {
  const { cacheKey, source } = props;
  const isFocused = useIsFocused();
  const [loaded, setLoaded] = useState<{ key: string; thumbnail: VideoThumbnail } | null>(null);
  const thumbnail = loaded?.key === cacheKey ? loaded.thumbnail : cachedVideoThumbnail(cacheKey);

  useEffect(() => {
    if (!source || !isFocused) return;
    const controller = new AbortController();
    void loadVideoThumbnail(
      cacheKey,
      async () => ({ uri: source, dispose: () => undefined }),
      controller.signal,
    ).then((thumbnail) => {
      if (thumbnail && !controller.signal.aborted) setLoaded({ key: cacheKey, thumbnail });
    });
    return () => controller.abort();
  }, [cacheKey, source, isFocused]);

  return thumbnail ? (
    <Image
      source={thumbnail}
      style={StyleSheet.absoluteFill}
      contentFit={props.contentFit ?? "cover"}
      recyclingKey={cacheKey}
      accessible={false}
    />
  ) : null;
}
