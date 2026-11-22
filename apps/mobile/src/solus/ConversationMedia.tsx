import { useState } from "react";
import { Image, Pressable, View } from "react-native";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import { projectContext } from "@solus-mobile/features/conversation/lib/ipc-context";
import {
  resolveHostMediaUrl,
  useHostMediaUrl,
  type HostMediaRequest,
} from "@solus-mobile/features/files/host-media-url";
import { FilePreviewModal } from "../components/ui/FilePreviewModal";
import { AppText } from "../components/ui/AppText";
import { solus } from "./runtime";

type Source = { assetId: string } | { path: string } | { uri: string };

export function conversationImageSource(href: string): Source {
  if (/^(?:https?:\/\/|data:image\/)/i.test(href)) return { uri: href };
  return href.startsWith("asset://") ? { assetId: href.slice(8) } : { path: href };
}
function hostRequest(store: ConversationStore, source: Source): HostMediaRequest | null {
  const { run } = store.controller;
  return "path" in source
    ? { path: source.path, ctx: projectContext(run.workingDirectory, run.organizationId) }
    : "assetId" in source
      ? source
      : null;
}
export async function resolveConversationImage(store: ConversationStore, href: string, refresh = false) {
  const source = conversationImageSource(href);
  if ("uri" in source) return source;
  const connection = solus.connections.connection(store.controller.hostId);
  const request = hostRequest(store, source);
  if (!connection || !request) throw new Error("The image host is unavailable.");
  return { uri: await resolveHostMediaUrl(connection, request, refresh) };
}

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
