// Adapted from T3 Code apps/mobile/src/features/connection/ConnectionSheetButton.tsx (MIT, see UPSTREAM.md).
import { SymbolView } from "../../components/AppSymbol";
import { Platform, Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { MaterialButton } from "../../components/MaterialButton";

const CARD_SHADOW = Platform.select({
  ios: {
    shadowColor: "rgba(23,23,23,0.08)",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1,
    shadowRadius: 16,
  },
  android: { elevation: 3 },
});

const CARD_SHADOW_DARK = Platform.select({
  ios: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
  },
  android: { elevation: 4 },
});

export { CARD_SHADOW, CARD_SHADOW_DARK };

export function ConnectionSheetButton(props: {
  readonly icon: React.ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly disabled?: boolean;
  readonly tone?: "primary" | "secondary" | "danger";
  readonly compact?: boolean;
  readonly fullWidth?: boolean;
  readonly onPress: () => void;
}) {
  if (Platform.OS === "android")
    return (
      <MaterialButton
        label={props.label}
        disabled={props.disabled}
        onPress={props.onPress}
        tone={props.tone}
        fullWidth={props.fullWidth}
      />
    );
  const tone = props.tone ?? "secondary";

  const textColorClassName =
    tone === "primary"
      ? "accent-primary-foreground"
      : tone === "danger"
        ? "accent-danger-foreground"
        : "accent-foreground";

  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled ?? false }}
      className={cn(
        props.compact
          ? "min-h-9 flex-row items-center justify-center gap-1.5 rounded-[10px] px-3"
          : "min-h-11 flex-row items-center justify-center gap-1.5 rounded-[12px] px-4",
        "active:opacity-80 disabled:opacity-50",
        tone === "primary"
          ? "bg-primary"
          : tone === "danger"
            ? "border border-danger-border bg-danger"
            : "border border-border",
      )}
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <SymbolView
        name={props.icon}
        size={props.compact ? 13 : 14}
        tintColorClassName={textColorClassName}
        type="monochrome"
      />
      <Text
        className={cn(
          "text-[15px] font-t3-medium",
          tone === "primary"
            ? "text-primary-foreground"
            : tone === "danger"
              ? "text-danger-foreground"
              : "text-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
