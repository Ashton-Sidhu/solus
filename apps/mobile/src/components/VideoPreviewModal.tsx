// Adapted from T3 Code apps/mobile/src/components/VideoPreviewModal.tsx (MIT, see UPSTREAM.md).
// Android: the React Native player. iOS uses AVPlayerViewController
// (`VideoPreviewModal.ios.tsx`), as T3. Solus has no local draft videos.
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useEffectEvent, useState } from "react";
import { ActivityIndicator, Keyboard, Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useMediaActions } from "../lib/mediaActions";
import type { VideoPreviewSource } from "../lib/videoPreviewSource";
import { AppText } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { MediaActionsMenu } from "./MediaActionsMenu";
import { MediaSourceCaption } from "./MediaSourceCaption";
import { MediaVideoPlayer } from "./MediaVideoPlayer";

export type { VideoPreviewSource } from "../lib/videoPreviewSource";

function OpenVideoPreviewModal(props: {
  readonly source: VideoPreviewSource;
  readonly onRequestClose: () => void;
}) {
  const { source } = props;
  const insets = useSafeAreaInsets();
  const mediaActions = useMediaActions(source.actionsSource, props.onRequestClose);
  const [playback, setPlayback] = useState<{ uri: string | null; unavailable: boolean }>({
    uri: null,
    unavailable: false,
  });
  const resolveUri = useEffectEvent(source.resolveUri);

  useEffect(() => Keyboard.dismiss(), []);
  useEffect(() => {
    let active = true;
    void resolveUri().then(
      (uri) => {
        if (active) setPlayback({ uri, unavailable: uri === null });
      },
      () => {
        if (active) setPlayback({ uri: null, unavailable: true });
      },
    );
    return () => {
      active = false;
    };
  }, []);

  return (
    <Modal
      visible
      animationType="fade"
      presentationStyle="fullScreen"
      onRequestClose={props.onRequestClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <View
        className="flex-1 bg-black"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <View className="min-h-14 flex-row items-center gap-3 pl-4 pr-2">
          <AppText className="flex-1 font-t3-medium text-base text-white" numberOfLines={2}>
            {source.name}
          </AppText>
          <MediaActionsMenu media={mediaActions} inModal />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close video"
            onPress={props.onRequestClose}
            className="size-12 items-center justify-center"
          >
            <SymbolView name="xmark" size={20} tintColor="#ffffff" type="monochrome" />
          </Pressable>
        </View>
        <MediaSourceCaption source={mediaActions.title} />
        {playback.uri === null && !playback.unavailable ? (
          <View className="flex-1 items-center justify-center gap-3 px-6">
            <ActivityIndicator color="#ffffff" />
            <AppText className="text-sm text-white/80">Loading video...</AppText>
          </View>
        ) : (
          <MediaVideoPlayer
            uri={playback.uri}
            resolvePlaybackUri={source.resolveUri}
            name={source.name}
            thumbnailKey={source.key}
            unavailable={playback.unavailable}
            paused={mediaActions.sharing}
            expanded
            autoPlay
          />
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save or share video"
          disabled={source.actionsSource === undefined || mediaActions.sharing}
          onPress={mediaActions.share}
          className="mx-4 my-3 min-h-12 items-center justify-center rounded-xl bg-white/15 px-4"
        >
          <AppText className="font-t3-medium text-base text-white">
            {mediaActions.sharing ? "Opening share sheet..." : "Save or share video"}
          </AppText>
        </Pressable>
      </View>
    </Modal>
  );
}

/** A full-screen player for a video link while `source` is set; it closes when the screen loses focus. */
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
    <OpenVideoPreviewModal
      key={props.source.key}
      source={props.source}
      onRequestClose={props.onRequestClose}
    />
  );
}
