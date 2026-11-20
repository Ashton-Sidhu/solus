import type { ToolResultAudio } from "@solus/contracts/types";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { memo, useState } from "react";
import { Pressable, View } from "react-native";
import { useApp } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import type { ConversationStore } from "../conversation/conversation-store";
import { useHostMediaUrl } from "../files/host-media-url";

function timestamp(seconds: number) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

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
  if (!props.uri || (status.error && !props.canRetry)) {
    return <Text className="text-2xs text-foreground-muted">This file is no longer available.</Text>;
  }
  if (status.error) {
    return (
      <Pressable accessibilityRole="button" onPress={props.onRetry} className="self-start py-1">
        <Text className="text-2xs text-foreground">This audio could not be played. Try again</Text>
      </Pressable>
    );
  }
  return (
    <View className="flex-row items-center gap-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${status.playing ? "Pause" : "Play"} ${props.label}`}
        disabled={!status.isLoaded}
        onPress={() => {
          if (status.playing) player.pause();
          else if (status.didJustFinish || status.currentTime >= status.duration) void player.seekTo(0).then(() => player.play());
          else player.play();
        }}
        className="rounded-lg bg-subtle px-3 py-1.5"
      >
        <Text className="text-2xs text-foreground">{!status.isLoaded ? "Loading…" : status.playing ? "Pause" : "Play"}</Text>
      </Pressable>
      <Text className="text-2xs text-foreground-muted">
        {timestamp(status.currentTime)} / {timestamp(status.duration)}
      </Text>
    </View>
  );
}
