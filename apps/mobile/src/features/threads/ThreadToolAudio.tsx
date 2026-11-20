import type { ToolResultAudio } from "@solus/contracts/types";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { audioPlayedFraction, audioSeekForKey, audioSeekForPointer, formatAudioTime } from "@solus/client-core/tool-audio";
import { memo, useState } from "react";
import { Pressable, View } from "react-native";
import { useApp } from "../../app/app-context";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import type { ConversationStore } from "../conversation/conversation-store";
import { useHostMediaUrl } from "../files/host-media-url";

/** Audio a tool returned, played inside the open tool call. The host signs its URL when the call opens. */
export const ThreadToolAudio = memo(function ThreadToolAudio(props: {
  readonly audio: ToolResultAudio;
  readonly label: string;
  readonly store: ConversationStore;
}) {
  const app = useApp();
  const connection = app.connections.connection(props.store.controller.hostId);
  const { state, refresh } = useHostMediaUrl(connection, { assetId: props.audio.assetId });
  const [retried, setRetried] = useState<string | null>(null);
  const uri = retried ?? (state.kind === "ready" ? state.url : null);
  return (
    <View className="gap-1">
      <Text className="text-2xs text-foreground-muted">{props.label}</Text>
      {state.kind === "failed" ? (
        <Text className="text-2xs text-foreground-muted">This file is no longer available.</Text>
      ) : uri === null ? (
        <Text className="text-2xs text-foreground-muted">Loading audio…</Text>
      ) : (
        <ToolAudioControls
          key={uri}
          uri={uri}
          label={props.label}
          canRetry={retried === null}
          onRetry={() => { void refresh().then((url) => setRetried(url ?? "")); }}
        />
      )}
    </View>
  );
});

function ToolAudioControls(props: { uri: string; label: string; canRetry: boolean; onRetry: () => void }) {
  const player = useAudioPlayer(props.uri ? { uri: props.uri } : null, { updateInterval: 500 });
  const status = useAudioPlayerStatus(player);
  const [trackWidth, setTrackWidth] = useState(0);
  if (!props.uri || (status.error && !props.canRetry)) {
    return <Text className="text-2xs text-foreground-muted">This file is no longer available.</Text>;
  }
  if (status.error) {
    return (
      <Pressable accessibilityRole="button" onPress={props.onRetry} className="min-h-11 justify-center self-start">
        <Text className="text-2xs text-foreground">This audio could not be played. Try again</Text>
      </Pressable>
    );
  }
  const current = status.currentTime;
  const duration = status.duration;
  const seek = (to: number | null) => {
    if (to !== null) void player.seekTo(to);
  };
  // The desktop and web player in the native style: play and pause, the time, and a seek bar.
  return (
    <View className="h-11 flex-row items-center gap-2 rounded-xl bg-subtle pr-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${status.playing ? "Pause" : "Play"} ${props.label}`}
        disabled={!status.isLoaded}
        onPress={() => {
          if (status.playing) player.pause();
          else if (status.didJustFinish || status.currentTime >= status.duration) void player.seekTo(0).then(() => player.play());
          else player.play();
        }}
        className="h-11 w-11 items-center justify-center active:opacity-60 disabled:opacity-50"
      >
        <SymbolView name={status.playing ? "pause.fill" : "play.fill"} size={16} tintColorClassName="accent-icon" type="monochrome" />
      </Pressable>
      <Text className="text-2xs text-foreground-muted">{formatAudioTime(current)}</Text>
      <Pressable
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Seek ${props.label}`}
        accessibilityValue={{ min: 0, max: Math.round(duration), now: Math.round(current), text: `${formatAudioTime(current)} of ${formatAudioTime(duration)}` }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) => seek(audioSeekForKey(event.nativeEvent.actionName === "increment" ? "ArrowRight" : "ArrowLeft", current, duration))}
        onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
        onPress={(event) => seek(audioSeekForPointer(event.nativeEvent.locationX, 0, trackWidth, duration))}
        disabled={!status.isLoaded}
        className="h-11 min-w-0 flex-1 justify-center"
      >
        <View className="h-1 w-full overflow-hidden rounded-full bg-secondary-border">
          <View className="h-full rounded-full bg-foreground-muted" style={{ width: `${audioPlayedFraction(current, duration) * 100}%` }} />
        </View>
      </Pressable>
      <Text className="text-2xs text-foreground-muted">{formatAudioTime(duration)}</Text>
    </View>
  );
}
