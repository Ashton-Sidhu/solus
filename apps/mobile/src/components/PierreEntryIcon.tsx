// Adapted from T3 Code apps/mobile/src/components/PierreEntryIcon.tsx (MIT, see UPSTREAM.md).
import { Image } from "react-native";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

import { markdownFileIconSource } from "../lib/markdownFileIcons";
import { resolveFileIcon, fileIconColor } from "@solus/client-core/file-icons";

/** Native raster form of the shared Pierre icon, tinted for the current theme. */
export function PierreEntryIcon(props: { readonly path: string; readonly size?: number }) {
  const size = props.size ?? 16;
  const { themeAppearance } = useAppearancePreferences();
  const icon = resolveFileIcon(props.path);
  const tintColor = fileIconColor(icon.token, themeAppearance);
  return (
    <Image
      source={markdownFileIconSource(icon.token)}
      resizeMode="contain"
      accessible={false}
      style={{ width: size, height: size, tintColor }}
    />
  );
}
