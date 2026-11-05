import * as Clipboard from "expo-clipboard";
import { parseAttachmentClipboardHtml, type ClipboardAttachmentRef } from "@solus/client-core/attachment-clipboard";

/** The Solus attachment references on the clipboard, or null when it holds none. */
export async function readClipboardAttachmentRefs(): Promise<ClipboardAttachmentRef[] | null> {
  try {
    const html = await Clipboard.getStringAsync({ preferredFormat: Clipboard.StringFormat.HTML });
    return parseAttachmentClipboardHtml(html);
  } catch {
    return null;
  }
}
