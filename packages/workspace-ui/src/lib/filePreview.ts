import { mediaTypeFor } from "@solus/contracts/media-types";
import type { BrowserSnapshotRef } from "@solus/contracts/browser-types";
import type { IpcContext } from "@solus/contracts/types";
import { requestInputFocus } from "./inputFocus";
import { splitFileLine } from "./file-href";

export const FILE_PREVIEW_EVENT = "solus:preview-file";

export interface FilePreviewRequest {
  path: string;
  line?: number;
  tabId?: string;
  mediaKind?: "image" | "video";
  /** Images in the carousel, in display order. Paths use the same source. */
  gallery?: readonly string[];
  /** The browser captures among the gallery's paths. The viewer offers their
   *  page actions when it shows one. */
  snapshots?: readonly BrowserSnapshotRef[];
  source?: { serverId?: string; cwd?: string; ctx?: IpcContext };
}

/** Only images and videos use the media modal. Other files keep the file pane. */
export function filePreviewMediaKind(path: string): "image" | "video" | null {
  if (/^data:image\//i.test(path)) return "image";
  if (/^data:video\//i.test(path)) return "video";
  const kind = mediaTypeFor(path.split(/[?#]/, 1)[0])?.kind;
  return kind === "image" || kind === "video" ? kind : null;
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export function parseFileHref(href: string): FilePreviewRequest | null {
  if (!href || href.startsWith("#")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("file://")) {
    return null;
  }

  let rawPath = href;
  if (href.startsWith("file://")) {
    try {
      rawPath = new URL(href).pathname;
    } catch {
      return null;
    }
  }

  rawPath = decodePath(rawPath.split(/[?#]/, 1)[0] ?? "");
  if (!rawPath) return null;

  return splitFileLine(rawPath);
}

export function requestFilePreview(request: FilePreviewRequest) {
  window.dispatchEvent(
    new CustomEvent<FilePreviewRequest>(FILE_PREVIEW_EVENT, {
      detail: request,
    }),
  );
  if (!request.mediaKind && !filePreviewMediaKind(request.path)) requestInputFocus();
}
