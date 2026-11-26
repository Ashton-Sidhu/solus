import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import { projectContext } from "@solus-mobile/features/conversation/lib/ipc-context";
import {
  resolveHostMediaUrl,
  type HostMediaRequest,
} from "@solus-mobile/features/files/host-media-url";
import { solus } from "./runtime";

export type Source = { assetId: string } | { path: string } | { uri: string };

export function conversationImageSource(href: string): Source {
  if (/^(?:https?:\/\/|data:image\/)/i.test(href)) return { uri: href };
  return href.startsWith("asset://") ? { assetId: href.slice(8) } : { path: href };
}
export function hostRequest(store: ConversationStore, source: Source): HostMediaRequest | null {
  const { run } = store.controller;
  return "path" in source
    ? { path: source.path, ctx: projectContext(run.workingDirectory, run.organizationId) }
    : "assetId" in source
      ? source
      : null;
}
export async function resolveConversationImage(
  store: ConversationStore,
  href: string,
  refresh = false,
) {
  const source = conversationImageSource(href);
  if ("uri" in source) return source;
  const connection = solus.connections.connection(store.controller.hostId);
  const request = hostRequest(store, source);
  if (!connection || !request) throw new Error("The image host is unavailable.");
  return { uri: await resolveHostMediaUrl(connection, request, refresh) };
}
