export function uploadAttachmentId(sessionId: string, path: string): string {
  return "upload:" + encodeURIComponent(sessionId) + "/" + path;
}

export function readUploadAttachmentId(id: string) {
  const separator = id.indexOf("/");
  if (!id.startsWith("upload:") || separator <= 7) return null;
  try {
    return { sessionId: decodeURIComponent(id.slice(7, separator)), path: id.slice(separator + 1) };
  } catch {
    return null;
  }
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
