import { solus } from "./runtime";

export interface DraftAttachmentSource {
  hostId: string;
  sessionId: string;
}

/** Prepare the destination before changing the route. Cancelling the picker keeps the original draft. */
export function prepareDraftCheckout(
  source: DraftAttachmentSource,
  hostId: string,
  cwd: string,
): string {
  const original = solus.openConversation(source.hostId, source.sessionId)?.controller;
  if (!original?.mayDrive || !original.canRoute)
    throw new Error("The original draft is no longer available.");
  const files = original.filesForDraftCheckout(hostId);
  if (!solus.connections.may(hostId, "host.use")) throw new Error("This host is unavailable.");
  const sessionId = solus.newSessionId();
  const store = solus.conversation(hostId, {
    newSession: {
      sessionId,
      provider: original.run.provider,
      workingDirectory: cwd,
      attachments: files.uploaded,
    },
  });
  if (!store) throw new Error("Connect to this host and try again.");
  void store.controller.attach(files.picked);
  return sessionId;
}
