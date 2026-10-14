// Adapted from T3 Code apps/mobile/src/lib/filePreviewGallery.ts (MIT, see UPSTREAM.md).
import type { FilePreviewItem, FilePreviewSource } from "../components/FilePreview.types";

/** Preserve document order and the tapped image's own metadata. */
export function filePreviewGallery(
  source: FilePreviewSource,
  group: readonly FilePreviewItem[],
): FilePreviewItem[] {
  if (source.kind !== "image") return [source];
  const seen = new Set<string>();
  const items: FilePreviewItem[] = [];
  for (const item of source.gallery ?? group) {
    if (item.kind !== "image" || seen.has(item.key)) continue;
    seen.add(item.key);
    items.push(item.key === source.key ? source : item);
  }
  if (!seen.has(source.key)) items.unshift(source);
  return items;
}

/** Markdown captions are display text, never file names for native file type detection. */
export function filePreviewName(source: FilePreviewItem): string {
  const keyName = source.key.split(/[?#]/)[0]?.split("/").pop() || undefined;
  const name = source.name ?? keyName ?? "Preview";
  const extension = /\.(png|jpe?g|gif|webp|heic|heif|avif|svg|pdf|docx?|xlsx?|pptx?|txt|rtf)$/i;
  const filename =
    source.kind !== "image" || extension.test(name)
      ? name
      : keyName && extension.test(keyName)
        ? keyName
        : name.replace(/\./g, "_");
  return Array.from(filename, (character) =>
    character.charCodeAt(0) < 32 || "/:\\".includes(character) ? "_" : character,
  ).join("");
}
