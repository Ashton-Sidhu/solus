/**
 * Put the image the viewer shows on the clipboard.
 *
 * The source is the URL the viewer already loaded, so no second signed URL is
 * minted for it. The clipboard takes only PNG in Chromium, so another format is
 * drawn once and written as PNG.
 */
export async function copyImage(src: string): Promise<void> {
  const response = await fetch(src);
  if (!response.ok) throw new Error("The image is not available.");
  const blob = await response.blob();
  const png = blob.type === "image/png" ? blob : await asPng(blob);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

async function asPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/png" });
}
