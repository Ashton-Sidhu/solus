import { View } from "react-native";

import { appMonogram } from "@solus/client-core/app-tile";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { appTileColors } from "./app-tile-colors";

/**
 * An app's tile: the first letter of its name on its hue, in the same colours
 * as the desktop and the web tile. `large` is the Overview header; `small` is
 * one choice of the colour picker.
 */
export function AppTile(props: { readonly hue: number; readonly name: string; readonly size: "large" | "small" }) {
  const { themeAppearance } = useAppearancePreferences();
  const colors = appTileColors(props.hue, themeAppearance);
  return (
    <View
      accessible={false}
      className={cn(
        "items-center justify-center border-continuous",
        props.size === "large" ? "size-16 rounded-[18px]" : "size-10 rounded-xl",
      )}
      style={{ backgroundColor: colors.background }}
    >
      <Text
        className={cn("font-t3-bold", props.size === "large" ? "text-2xl" : "text-base")}
        style={{ color: colors.text }}
      >
        {appMonogram(props.name)}
      </Text>
    </View>
  );
}
