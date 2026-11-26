import { useState } from "react";
import { Image, Pressable, View } from "react-native";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import { hostRequest, type Source } from "./session-media";
export { conversationImageSource, resolveConversationImage } from "./session-media";
import {
  useHostMediaUrl,
} from "@solus-mobile/features/files/host-media-url";
import { FilePreviewModal } from "../components/ui/FilePreviewModal";
import { AppText } from "../components/ui/AppText";
import { solus } from "./runtime";

export function ConversationMedia({
  store,
  source,
  label,
  file = false,
}: {
  store: ConversationStore;
  source: Source;
  label: string;
  file?: boolean;
}) {
  const { hostId } = store.controller;
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = hostRequest(store, source);
  const { state, refresh } = useHostMediaUrl(solus.connections.connection(hostId), request);
  const uri = "uri" in source ? source.uri : state.kind === "ready" ? state.url : null;
  if (failed || (!uri && state.kind === "failed"))
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          setFailed(false);
          void refresh();
        }}
      >
        <AppText>{label} · Retry</AppText>
      </Pressable>
    );
  if (!uri) return <AppText>{label} · Loading…</AppText>;
  return (
    <View className="gap-1">
      <Pressable
        accessibilityRole={file ? "button" : "imagebutton"}
        accessibilityLabel={label}
        onPress={() => setOpen(true)}
      >
        {file ? (
          <AppText className="py-2 font-medium">{label}</AppText>
        ) : (
          <Image
            accessibilityLabel={label}
            resizeMode="contain"
            source={{ uri }}
            style={{ width: "100%", height: 180 }}
            onError={() => setFailed(true)}
          />
        )}
      </Pressable>
      {open && (
        <FilePreviewModal
          source={{
            uri,
            name: label,
            kind: file ? (/\.pdf$/i.test(label) ? "pdf" : "document") : "image",
          }}
          onRequestClose={() => setOpen(false)}
          onOpenError={() => {
            setOpen(false);
            setFailed(true);
          }}
        />
      )}
    </View>
  );
}
