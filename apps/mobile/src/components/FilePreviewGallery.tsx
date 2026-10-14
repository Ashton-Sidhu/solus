// Adapted from T3 Code apps/mobile/src/components/FilePreviewGallery.tsx (MIT, see UPSTREAM.md).
import { createContext, useContext } from "react";

import { filePreviewGallery } from "../lib/filePreviewGallery";
import type { FilePreviewItem, FilePreviewSource } from "./FilePreview.types";

/** The images a tapped image swipes through: those of one message or pull request text. */
export const FilePreviewGallery = createContext<readonly FilePreviewItem[]>([]);

export function useFilePreviewGallery() {
  const group = useContext(FilePreviewGallery);
  return (source: FilePreviewSource): FilePreviewSource =>
    group.length === 0 ? source : { ...source, gallery: filePreviewGallery(source, group) };
}
