import { resolveLinkedThreadOpen } from "@t3tools/client-runtime/linked-thread";
import { EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";

import { solus } from "../../solus/runtime";
import { useOpenLinkedThread, useOpenLinkedThreadRead } from "./useOpenLinkedThread";

/**
 * Opens a thread that a link or chip in `viaEnvironmentId` points at: in place when this app is
 * connected to its environment, else read-only through `viaEnvironmentId`'s link to it.
 */
export function useOpenThreadLink(viaEnvironmentId: EnvironmentId | null) {
  const openThread = useOpenLinkedThread();
  const openLinkedRead = useOpenLinkedThreadRead();
  return (thread: ScopedThreadRef, title: string | null = null) => {
    const sources = solus.connections.pairingHolders();
    const ordered = [
      ...sources.filter(({ info }) => info.installationId === viaEnvironmentId),
      ...sources.filter(({ info }) => info.installationId !== viaEnvironmentId),
    ];
    const linkSource = ordered.find(({ snapshot }) =>
      snapshot?.hosts.some(({ listing }) => listing.installationId === thread.environmentId));
    const linked = linkSource?.snapshot?.hosts.find(({ listing }) => listing.installationId === thread.environmentId);
    const sourceId = linkSource ? EnvironmentId.make(linkSource.info.installationId) : viaEnvironmentId;
    const cloud = solus.cloudSessions.recordFor(thread.threadId);
    const connected = solus.connections.state(thread.environmentId)?.readiness === "ready";
    if (
      sourceId !== null &&
      (linked !== undefined || cloud !== undefined && cloud !== null) &&
      resolveLinkedThreadOpen({
        environmentId: thread.environmentId,
        viaEnvironmentId: sourceId,
        own: { connected },
        linked: true,
      }) === "linked"
    ) {
      const label = linked?.listing.label ?? solus.registry.host(thread.environmentId)?.label ?? thread.environmentId;
      openLinkedRead(thread, { viaEnvironmentId: sourceId, label }, title);
      return;
    }
    openThread({
      environmentId: String(thread.environmentId),
      threadId: String(thread.threadId),
    });
  };
}
