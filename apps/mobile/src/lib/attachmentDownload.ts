// Adapted from T3 Code apps/mobile/src/lib/attachmentDownload.ts (MIT, see UPSTREAM.md).
// Only the paths Solus uses: a document opened in another app's viewer (Android)
// and the original bytes for the save or share sheet. No foreground handoff
// tracking (Solus has no deferred restart) and no source-anchored iOS share sheet.
import type { Directory } from "expo-file-system";

const ATTACHMENT_DOWNLOAD_DIRECTORY = "solus-attachment-downloads";
const DOWNLOAD_RETENTION_MS = 24 * 60 * 60_000;
const DOWNLOAD_DIRECTORY_NAME = /^(\d+)-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const activeDirectories = new Set<string>();

export interface AttachmentFileMetadata {
  readonly name: string;
  readonly mimeType: string;
}

function downloadFileName(name: string): string {
  const basename = name.split(/[\\/]/).at(-1) ?? "";
  const sanitized = Array.from(basename, (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 32 ||
      (codePoint >= 127 && codePoint <= 159) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? "_"
      : character;
  })
    .join("")
    .trim();
  if (!sanitized || /^\.+$/.test(sanitized)) {
    return "attachment";
  }
  const encoder = new TextEncoder();
  if (encoder.encode(sanitized).byteLength <= 255) {
    return sanitized;
  }
  const extensionMatch = /\.[a-z0-9]{1,16}$/i.exec(sanitized);
  const extension = extensionMatch && extensionMatch.index > 0 ? extensionMatch[0] : "";
  const stem = extension ? sanitized.slice(0, -extension.length) : sanitized;
  let remainingBytes = 255 - encoder.encode(extension).byteLength;
  let shortStem = "";
  for (const character of stem) {
    const bytes = encoder.encode(character).byteLength;
    if (bytes > remainingBytes) break;
    shortStem += character;
    remainingBytes -= bytes;
  }
  return `${shortStem || "attachment"}${extension}`;
}

function removeDownloadDirectory(directory: Directory): void {
  try {
    if (directory.exists) {
      directory.delete();
    }
  } catch (error) {
    console.warn("[attachment-downloads] could not remove a cached file", error);
  }
}

function mimeTypeOf(attachment: AttachmentFileMetadata): string {
  return attachment.mimeType.split(";", 1)[0]?.trim() || "application/octet-stream";
}

async function availableSharing(signal: AbortSignal) {
  if (signal.aborted) return null;
  const Sharing = await import("expo-sharing");
  const canShare = await Sharing.isAvailableAsync();
  if (signal.aborted) return null;
  if (!canShare) {
    throw new Error("Saving and sharing files is unavailable on this device.");
  }
  return Sharing;
}

/** A new cache folder for one file. Folders older than a day go when the next one is made. */
async function createCachedAttachmentFile(attachment: AttachmentFileMetadata) {
  const { Directory, File, Paths } = await import("expo-file-system");
  const { randomUUID } = await import("expo-crypto");
  const cache = new Directory(Paths.cache, ATTACHMENT_DOWNLOAD_DIRECTORY);
  cache.create({ idempotent: true, intermediates: true });
  const now = Date.now();
  try {
    for (const entry of cache.list()) {
      const match = DOWNLOAD_DIRECTORY_NAME.exec(entry.name);
      if (
        entry instanceof Directory &&
        match &&
        Number(match[1]) < now - DOWNLOAD_RETENTION_MS &&
        !activeDirectories.has(entry.uri)
      ) {
        removeDownloadDirectory(entry);
      }
    }
  } catch (error) {
    console.warn("[attachment-downloads] could not inspect cached files", error);
  }

  const directory = new Directory(cache, `${now}-${randomUUID()}`);
  directory.create();
  let file: InstanceType<typeof File>;
  try {
    file = new File(directory, downloadFileName(attachment.name));
  } catch (error) {
    removeDownloadDirectory(directory);
    throw error;
  }
  activeDirectories.add(directory.uri);
  // A receiver can still read the file after the share sheet or viewer returns.
  let retained = false;
  return {
    file,
    retain: () => {
      retained = true;
    },
    dispose: () => {
      activeDirectories.delete(directory.uri);
      if (!retained) removeDownloadDirectory(directory);
    },
  };
}

/** A readable reason for a viewer refusing a file; native rejections carry stack text. */
export function nativeViewerErrorMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return /ActivityNotFound|cannot be previewed/i.test(text)
    ? "No app on this device can show this format. Save or share it to open it elsewhere."
    : "The file could not be opened. Check the connection and try again.";
}

/** Open an Android document in a viewer, keeping the cache while another app reads it. */
export async function openAttachmentInViewer(input: {
  readonly uri: string;
  readonly attachment: AttachmentFileMetadata;
  readonly signal: AbortSignal;
}): Promise<void> {
  const { File } = await import("expo-file-system");
  const { requireNativeModule } = await import("expo");
  if (input.signal.aborted) return;
  const cached = await createCachedAttachmentFile(input.attachment);
  try {
    if (/^(file|content):/.test(input.uri)) {
      new File(input.uri).copy(cached.file);
    } else {
      await File.downloadFileAsync(input.uri, cached.file, { idempotent: true });
    }
    if (input.signal.aborted) return;
    await requireNativeModule<{ openFile(uri: string, mimeType: string): Promise<void> }>(
      "SolusFilePreview",
    ).openFile(cached.file.uri, mimeTypeOf(input.attachment));
    cached.retain();
  } finally {
    cached.dispose();
  }
}

/** Downloads the original bytes for the native save or share sheet. */
export async function downloadAndShareAttachment(input: {
  readonly url: string;
  readonly attachment: AttachmentFileMetadata;
  readonly signal: AbortSignal;
}): Promise<void> {
  const Sharing = await availableSharing(input.signal);
  if (Sharing === null) return;
  const { File } = await import("expo-file-system");
  const cached = await createCachedAttachmentFile(input.attachment);
  try {
    try {
      if (/^(file|content):/i.test(input.url)) new File(input.url).copy(cached.file);
      else await File.downloadFileAsync(input.url, cached.file, { idempotent: true });
    } catch (cause) {
      if (input.signal.aborted) return;
      throw new Error("Could not download the file. Check the connection and try again.", {
        cause,
      });
    }
    if (input.signal.aborted) return;
    try {
      await Sharing.shareAsync(cached.file.uri, {
        mimeType: mimeTypeOf(input.attachment),
        dialogTitle: input.attachment.name,
      });
      cached.retain();
    } catch (cause) {
      if (!input.signal.aborted) {
        throw new Error("Could not open the share sheet. Try again.", { cause });
      }
    }
  } finally {
    cached.dispose();
  }
}
