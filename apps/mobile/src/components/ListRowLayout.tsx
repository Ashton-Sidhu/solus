// Adapted from T3 Code apps/mobile/src/components/ListRowLayout.tsx (MIT, see UPSTREAM.md).
import type { ReactNode } from "react";
import { useWindowDimensions, View } from "react-native";

import { cn } from "../lib/cn";
import { AppText } from "./AppText";
import type { AppSymbolName } from "./AppSymbol";
import { SymbolView } from "./AppSymbol";
import { Platform } from "react-native";

export interface ListRowContentProps {
  readonly icon?: AppSymbolName;
  readonly leading?: ReactNode;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly disabled?: boolean;
}

/** Shared row geometry; controls own their behavior and accessibility. */
export function ListRowLayout({
  icon,
  leading,
  label,
  description,
  detail,
  disabled,
  accessory,
  tone = "default",
}: ListRowContentProps & { readonly accessory?: ReactNode; readonly tone?: "default" | "danger" }) {
  const { fontScale } = useWindowDimensions();
  // Leave the label room to wrap at accessibility text sizes.
  const stackDetail = fontScale >= 1.5;
  return (
    <View
      className={cn(
        "min-h-14 flex-row items-center gap-3 px-4 py-3",
        description && "min-h-18",
        disabled && "opacity-45",
      )}
    >
      {leading || icon ? (
        <View className="size-6 items-center justify-center">
          {leading ?? (icon ? <SymbolView name={icon} size={Platform.OS === "android" ? 24 : 22} tintColorClassName={tone === "danger" ? "accent-danger-foreground" : "accent-icon"} type="monochrome" weight="regular" /> : null)}
        </View>
      ) : null}
      <View className="min-w-0 flex-1 gap-1">
        <AppText className={tone === "danger" ? "text-base text-danger-foreground" : "text-base text-foreground"}>{label}</AppText>
        {description ? (
          <AppText className="text-sm text-foreground-muted">{description}</AppText>
        ) : null}
        {detail && stackDetail ? (
          <AppText className="text-sm text-foreground-muted">{detail}</AppText>
        ) : null}
      </View>
      {detail && !stackDetail ? (
        <AppText
          className="max-w-[40%] shrink text-right text-sm text-foreground-muted"
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {detail}
        </AppText>
      ) : null}
      {accessory}
    </View>
  );
}
