/** The base64 bytes of a `data:` URL, or null when it carries none. */
export function base64OfDataUrl(dataUrl: string): string | null {
  const match = /^data:[^,]*;base64,(.+)$/s.exec(dataUrl);
  return match?.[1] ?? null;
}
