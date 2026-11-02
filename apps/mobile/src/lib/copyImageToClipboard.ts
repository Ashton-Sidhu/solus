import * as Clipboard from "expo-clipboard";

import { base64OfDataUrl } from "./dataUrlBase64";


async function base64OfUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`The host answered ${response.status}.`);
  const blob = await response.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Unreadable picture.")));
    reader.onerror = () => reject(reader.error ?? new Error("Unreadable picture."));
    reader.readAsDataURL(blob);
  });
  const base64 = base64OfDataUrl(dataUrl);
  if (!base64) throw new Error("Unreadable picture.");
  return base64;
}

/**
 * Put a picture's bytes on the system clipboard, so it pastes into any app.
 * The source is the bytes the prompt carried, or a URL the host signed.
 */
export async function copyImageToClipboard(source: { readonly dataUrl: string } | { readonly url: string }): Promise<void> {
  const base64 = "dataUrl" in source ? base64OfDataUrl(source.dataUrl) : await base64OfUrl(source.url);
  if (!base64) throw new Error("Unreadable picture.");
  await Clipboard.setImageAsync(base64);
}
