// Adapted from T3 Code apps/mobile/src/components/ComposerToolbar.tsx (MIT, see UPSTREAM.md).
import type { ComponentProps, ReactNode } from "react";
import {
  Platform,
  Pressable,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { cn } from "../lib/cn";
import { AppText as Text } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { useAndroidControlSizing } from "./useAndroidControlSizing";

/**
 * Quiet inline composer control used inside cards and their context rows.
 * Unlike ComposerToolbarButton, this does not draw another pill inside the
 * composer surface, so model and workspace controls read as part of the card.
 */
export function ComposerInlineControl(props: {
  readonly accessibilityHint?: string;
  readonly accessibilityLabel?: string;
  readonly disabled?: boolean;
  readonly emphasized?: boolean;
  readonly icon?: ComponentProps<typeof SymbolView>["name"];
  readonly renderIcon?: (size: number) => ReactNode;
  readonly label: string;
  /** Muted text after the label (the model's reasoning); it shrinks before the label does. */
  readonly summary?: string;
  readonly maxWidth?: ViewStyle["maxWidth"];
  readonly onPress?: () => void;
  readonly selected?: boolean;
  readonly static?: boolean;
  readonly chevronDirection?: "down" | "right";
  readonly showChevron?: boolean;
}) {
  const { scale, smallIconSize } = useAndroidControlSizing();
  return (
    <Pressable
      accessibilityLabel={[props.accessibilityLabel ?? props.label, props.summary].filter(Boolean).join(", ")}
      accessibilityHint={props.accessibilityHint}
      accessibilityRole={props.static ? undefined : "button"}
      accessibilityState={
        props.static ? undefined : { disabled: props.disabled, selected: props.selected }
      }
      className="h-11 flex-row items-center gap-2 rounded-xl px-2 active:bg-subtle"
      disabled={props.disabled || props.static}
      onPress={props.onPress}
      style={{ maxWidth: props.maxWidth ?? 190, opacity: props.disabled ? 0.45 : 1 }}
    >
      {props.renderIcon ? (
        <View
          className="size-4 shrink-0 items-center justify-center"
          style={Platform.OS === "android" ? { width: 14 * scale, height: 14 * scale } : undefined}
        >
          {props.renderIcon(smallIconSize)}
        </View>
      ) : props.icon ? (
        <SymbolView
          name={props.icon}
          size={smallIconSize}
          tintColorClassName={
            props.emphasized || props.selected ? "accent-icon" : "accent-icon-muted"
          }
          type="monochrome"
        />
      ) : null}
      <Text
        className={cn(
          "shrink text-sm font-t3-medium",
          props.emphasized || props.selected ? "text-foreground" : "text-foreground-muted",
        )}
        numberOfLines={1}
      >
        {props.label}
      </Text>
      {props.summary ? (
        <Text className="min-w-0 text-xs text-foreground-muted" numberOfLines={1} style={{ flexShrink: 100 }}>
          {props.summary}
        </Text>
      ) : null}
      {props.showChevron === false ? null : (
        <SymbolView
          name={props.chevronDirection === "right" ? "chevron.right" : "chevron.down"}
          size={Math.round(10 * scale)}
          tintColorClassName={
            props.emphasized || props.selected ? "accent-icon" : "accent-icon-muted"
          }
          type="monochrome"
        />
      )}
    </Pressable>
  );
}

export function ComposerToolbarRow(props: {
  readonly children: ReactNode;
  readonly paddingBottom?: number;
  readonly paddingHorizontal?: number;
  readonly paddingTop?: number;
  readonly style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      className="flex-row items-center gap-1.5"
      style={[
        {
          paddingBottom: props.paddingBottom ?? 8,
          paddingHorizontal: props.paddingHorizontal ?? 6,
          paddingTop: props.paddingTop ?? 8,
        },
        props.style,
      ]}
    >
      {props.children}
    </View>
  );
}

export function ComposerActionButton(props: {
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly onPress: () => void;
  readonly variant?: "primary" | "danger";
  // Forwarded so a ControlPillMenu can drive this button as its long-press
  // anchor: Android injects onLongPress, iOS injects onTouchStart and onPress.
  readonly onLongPress?: PressableProps["onLongPress"];
  readonly onTouchStart?: PressableProps["onTouchStart"];
}) {
  const { scale, smallIconSize } = useAndroidControlSizing();
  const circleSize = Math.round(30 * scale);
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center active:opacity-70"
      disabled={props.disabled}
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      onTouchStart={props.onTouchStart}
    >
      <View
        style={{ width: circleSize, height: circleSize }}
        className={cn(
          "items-center justify-center rounded-full",
          props.variant === "danger"
            ? "bg-danger"
            : props.disabled
              ? "bg-primary/15"
              : "bg-primary",
        )}
      >
        <SymbolView
          name={props.icon}
          size={smallIconSize}
          weight="semibold"
          tintColorClassName={
            props.variant === "danger" ? "accent-danger-foreground" : "accent-primary-foreground"
          }
          type="monochrome"
        />
      </View>
    </Pressable>
  );
}
