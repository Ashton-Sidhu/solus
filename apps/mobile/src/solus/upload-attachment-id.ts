export function uploadAttachmentId(sessionId: string, path: string): string {
  return "upload:" + encodeURIComponent(sessionId) + "/" + path;
}

export function attachmentRoute(
  hostId: string,
  sessionId: string,
  path: string,
  name: string,
  mimeType = "application/octet-stream",
  size = 0,
) {
  return {
    environmentId: hostId,
    threadId: sessionId,
    attachmentId: uploadAttachmentId(sessionId, path),
    name,
    mimeType,
    sizeBytes: String(size),
  };
}
