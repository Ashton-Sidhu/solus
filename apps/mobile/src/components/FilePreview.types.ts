// Adapted from T3 Code apps/mobile/src/components/FilePreviewModal.types.ts and src/lib/mediaActionsSource.ts (MIT, see UPSTREAM.md).
// T3 names an environment asset; Solus names a function that gives the URL to
// load, because a host signs a new short-lived URL for each file.
import type { RootStackParamList } from "../navigation/routes";

/** What the Markdown or the screen named: a host path or a web address. */
export type MediaReference =
  | { readonly kind: "file"; readonly path: string; readonly relativePath?: string }
  | { readonly kind: "url"; readonly url: string };

/** Authored source metadata, apart from the short-lived URL a preview loads. */
export interface MediaActionsSource {
  readonly reference?: MediaReference;
  readonly name: string;
  readonly mimeType: string;
  /** A URL for the original bytes now: a host signs a new one; a web address is itself. */
  readonly resolveUri: () => Promise<string | null>;
  /** The file screen for a host file ("Open in file viewer"). */
  readonly file?: RootStackParamList["File"];
}

export interface FilePreviewMetadata {
  readonly kind: "image" | "pdf" | "document";
  readonly mimeType?: string;
  readonly name?: string;
  readonly actionsSource?: MediaActionsSource;
}

/** One file a viewer can open. The URL is made when the viewer opens, not before. */
export interface FilePreviewItem extends FilePreviewMetadata {
  /** The identity in a gallery: the authored reference, never a signed URL that changes. */
  readonly key: string;
  readonly resolveUri: () => Promise<string | null>;
}

export interface FilePreviewSource extends FilePreviewItem {
  readonly gallery?: readonly FilePreviewItem[];
}

export interface ResolvedFilePreviewItem extends FilePreviewMetadata {
  readonly uri: string;
}

export interface ResolvedFilePreviewSource extends ResolvedFilePreviewItem {
  readonly gallery?: readonly ResolvedFilePreviewItem[];
}

/** A preview of a web address or a local file, which needs no signature. */
export function directPreviewItem(
  uri: string,
  metadata: FilePreviewMetadata,
): FilePreviewItem {
  return { ...metadata, key: uri, resolveUri: async () => uri };
}
