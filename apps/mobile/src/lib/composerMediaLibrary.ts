import type { launchImageLibraryAsync } from "expo-image-picker";
import { beginForegroundHandoff } from "./foreground-handoff";

export async function openComposerMediaLibrary(
  pick: typeof launchImageLibraryAsync,
  options: { allowVideos: boolean; selectionLimit?: number },
) {
  const endHandoff = beginForegroundHandoff();
  try {
    return await pick({
      mediaTypes: options.allowVideos ? ["images", "videos"] : ["images"],
      allowsMultipleSelection: true,
      selectionLimit: options.selectionLimit,
      base64: false,
      quality: 1,
      shouldDownloadFromNetwork: true,
    });
  } finally {
    endHandoff();
  }
}
