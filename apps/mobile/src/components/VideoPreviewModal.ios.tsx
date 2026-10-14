// Adapted from T3 Code apps/mobile/src/components/VideoPreviewModal.ios.tsx (MIT, see UPSTREAM.md).
// iOS: AVPlayerViewController plays the video (`SolusFilePreview.presentVideo`).
// The URL comes from the source's own `resolveUri` (a host signs host files),
// minted once per opening; no local draft videos or presentation source views.
import { useIsFocused } from "@react-navigation/native";
import { requireNativeModule } from "expo";
import { useEffect, useEffectEvent, useId } from "react";
import { Alert, Keyboard } from "react-native";

import type { VideoPreviewSource } from "../lib/videoPreviewSource";

export type { VideoPreviewSource } from "../lib/videoPreviewSource";

const VideoPresentation = requireNativeModule<{
  presentVideo(uri: string, title: string, identifier: string): Promise<void>;
  dismissVideo(identifier: string): Promise<void>;
}>("SolusFilePreview");

function NativeVideoPreview(props: {
  readonly source: VideoPreviewSource;
  readonly onRequestClose: () => void;
}) {
  const { source } = props;
  const identifier = useId();
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const resolveUri = useEffectEvent(source.resolveUri);

  useEffect(() => Keyboard.dismiss(), []);

  useEffect(() => {
    const controller = new AbortController();
    const fail = (message: string) => {
      if (controller.signal.aborted) return;
      Alert.alert("Could not open video", message);
      onRequestClose();
    };
    void (async () => {
      const uri = await resolveUri().catch(() => null);
      if (controller.signal.aborted) return;
      if (uri === null) {
        fail("Could not load this video. Check the connection and try again.");
        return;
      }
      try {
        await VideoPresentation.presentVideo(uri, source.name, identifier);
      } catch {
        fail(
          "This video couldn't be loaded or played. Check the connection, or touch and hold the video to save or share the original.",
        );
        return;
      }
      if (!controller.signal.aborted) onRequestClose();
    })();
    return () => {
      controller.abort();
      void VideoPresentation.dismissVideo(identifier).catch(() => undefined);
    };
  }, [source.key, source.name, identifier]);

  return null;
}

/** AVKit's full-screen player for a video link while `source` is set; it closes when the screen loses focus. */
export function VideoPreviewModal(props: {
  readonly source: VideoPreviewSource | null;
  readonly onRequestClose: () => void;
}) {
  const isFocused = useIsFocused();
  const hasSource = props.source !== null;
  const onRequestClose = useEffectEvent(props.onRequestClose);
  useEffect(() => {
    if (!isFocused && hasSource) onRequestClose();
  }, [isFocused, hasSource]);

  if (props.source === null || !isFocused) return null;
  return (
    <NativeVideoPreview
      key={props.source.key}
      source={props.source}
      onRequestClose={props.onRequestClose}
    />
  );
}
