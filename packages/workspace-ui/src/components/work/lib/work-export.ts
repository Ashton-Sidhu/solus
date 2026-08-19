import type { FilePayload } from "../../diagram/lib/diagram-export";

/** One thing a work can be written out as, offered by the shell that owns it. */
export interface WorkExportFormat {
  /** Stable key for the menu row; also the file extension. */
  extension: string;
  /** Shown in the menu — "PNG", "Markdown". */
  label: string;
  mimeType: string;
  /** Encodes the current content. `null` means there was nothing to write. */
  produce: () => Promise<FilePayload | null> | FilePayload | null;
}

/** A clipboard variant of the same content — no destination, so not an export. */
export interface WorkCopyFormat {
  id: string;
  label: string;
  copy: () => Promise<void>;
}

/** What the header hands back when the user picks a format to save. */
export interface WorkExportRequest {
  fileName: string;
  payload: FilePayload;
}

/**
 * Pull a file onto the device running the client, rather than writing it to the
 * host's filesystem. The two are the same machine on desktop, and are not on web
 * or mobile — which is the only reason this path exists alongside the picker.
 */
export function downloadPayload(fileName: string, mimeType: string, payload: FilePayload): void {
  const blob =
    payload.encoding === "base64"
      ? new Blob([Uint8Array.from(atob(payload.contents), (c) => c.charCodeAt(0))], { type: mimeType })
      : new Blob([payload.contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
