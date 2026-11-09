// Adapted from T3 Code apps/mobile/src/lib/saveImageToLibrary.ts (MIT, see UPSTREAM.md).
// The native method lives in Solus's SolusFilePreview module, not a controls module.
import type { PlatformOSType } from "react-native";

const SAVABLE_IMAGE_MIME_TYPE = /^image\/(png|jpe?g|gif|webp|heic|heif)$/i;

function baseMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim() ?? "";
}

/** Formats Photos can import, on iOS or Android 10+. Android 9 and older need a
 *  storage permission to add photos, so they keep the share sheet. */
export function canSaveImageToLibrary(
  mimeType: string,
  platform: { readonly OS: PlatformOSType; readonly Version: number | string },
): boolean {
  return (
    SAVABLE_IMAGE_MIME_TYPE.test(baseMimeType(mimeType)) &&
    (platform.OS === "ios" || (platform.OS === "android" && Number(platform.Version) >= 29))
  );
}

/** Adds a local image file to Photos on iOS or Pictures/Solus on Android. */
export async function saveImageToLibrary(uri: string, mimeType: string, name: string): Promise<void> {
  const { requireNativeModule } = await import("expo");
  await requireNativeModule<{
    saveImageToLibrary(uri: string, mimeType: string, name: string): Promise<void>;
  }>("SolusFilePreview").saveImageToLibrary(uri, baseMimeType(mimeType), name);
}
