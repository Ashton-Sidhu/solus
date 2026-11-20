// Adapted from T3 Code apps/mobile/src/components/ComposerToolbar.tsx (MIT, see UPSTREAM.md).
import type { ComponentProps, ReactNode } from "react";
import { useRef } from "react";
import { Pressable, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";

import Animated, { FadeIn, useReducedMotion } from "react-native-reanimated";

import { cn } from "../lib/cn";
import { AppText as Text } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { useAndroidControlSizing } from "./useAndroidControlSizing";
import { ComposerActionTouch } from "../features/threads/lib/composer-action-touch";

const INLINE_CONTROL_LABEL_ENTERING = FadeIn.duration(160);

function ComposerControlLabel(props: {
  readonly label: string;
  readonly emphasized?: boolean;
  readonly selected?: boolean;
  readonly size?: "regular" | "large";
  readonly labelEllipsizeMode?: ComponentProps<typeof Text>["ellipsizeMode"];
  readonly summary?: string;
  readonly suffix?: ReactNode;
  readonly suffixWidth?: number;
  readonly animate: boolean;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <>
      <Animated.View
        className="shrink"
        entering={props.animate && !reducedMotion ? INLINE_CONTROL_LABEL_ENTERING : undefined}
      >
        <Text
          className={cn(
            props.size === "large" ? "text-base font-t3-medium" : "text-sm font-t3-medium",
            props.emphasized || props.selected ? "text-foreground" : "text-foreground-muted",
          )}
          numberOfLines={1}
          ellipsizeMode={props.labelEllipsizeMode}
        >
          {props.label}
        </Text>
      </Animated.View>
      {props.suffix || props.summary ? (
        <View
          className={cn("min-w-0", props.suffixWidth === undefined ? "shrink" : "shrink-0")}
          style={{ width: props.suffixWidth }}
        >
          {props.suffix ?? (
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {props.summary}
            </Text>
          )}
        </View>
      ) : null}
    </>
  );
}

export function ComposerInlineControl(props: {
  readonly size?: "regular" | "large";
  readonly accessibilityHint?: string;
  readonly accessibilityLabel?: string;
  readonly disabled?: boolean;
  readonly emphasized?: boolean;
  readonly icon?: ComponentProps<typeof SymbolView>["name"];
  readonly renderIcon?: (size: number) => ReactNode;
  readonly label: string;
  readonly labelEllipsizeMode?: ComponentProps<typeof Text>["ellipsizeMode"];
  readonly summary?: string;
  readonly suffix?: ReactNode;
  readonly suffixWidth?: number;
  /** Show only the icon and chevron; the label still names the control for accessibility. */
  readonly iconOnly?: boolean;
  readonly maxWidth?: ViewStyle["maxWidth"];
  readonly onPress?: () => void;
  readonly selected?: boolean;
  readonly static?: boolean;
  readonly chevronDirection?: "down" | "right";
  readonly showChevron?: boolean;
}) {
  const { scale, smallIconSize } = useAndroidControlSizing();
  // Keep the picker anchored to its parent while the editor changes height.
  const animatesLabel = props.iconOnly !== undefined;
  const iconSize = props.size === "large" ? 20 : smallIconSize;
  return (
    <Animated.View
      style={{
        maxWidth: props.maxWidth ?? 190,
        overflow: animatesLabel ? "hidden" : undefined,
      }}
    >
      <Pressable
        accessibilityLabel={[props.accessibilityLabel ?? props.label, props.summary]
          .filter(Boolean)
          .join(", ")}
        accessibilityHint={props.accessibilityHint}
        accessibilityRole={props.static ? undefined : "button"}
        accessibilityState={
          props.static ? undefined : { disabled: props.disabled, selected: props.selected }
        }
        className="h-[44px] flex-row items-center gap-2 rounded-xl px-2 active:bg-subtle"
        disabled={props.disabled || props.static}
        onPress={props.onPress}
        style={{ opacity: props.disabled ? 0.45 : 1 }}
      >
        {props.renderIcon ? (
          <View
            className="size-4 shrink-0 items-center justify-center"
            style={{ width: iconSize, height: iconSize }}
          >
            {props.renderIcon(iconSize)}
          </View>
        ) : props.icon ? (
          <SymbolView
            name={props.icon}
            size={iconSize}
            tintColorClassName={
              props.emphasized || props.selected ? "accent-icon" : "accent-icon-muted"
            }
            type="monochrome"
          />
        ) : null}
        {props.iconOnly ? null : (
          <ComposerControlLabel
            label={props.label}
            emphasized={props.emphasized}
            selected={props.selected}
            size={props.size}
            labelEllipsizeMode={props.labelEllipsizeMode}
            summary={props.summary}
            suffix={props.suffix}
            suffixWidth={props.suffixWidth}
            animate={animatesLabel}
          />
        )}
        {props.showChevron === false ? null : (
          <SymbolView
            name={props.chevronDirection === "right" ? "chevron.right" : "chevron.down"}
            size={Math.round((props.size === "large" ? 12 : 10) * scale)}
            tintColorClassName={
              props.emphasized || props.selected ? "accent-icon" : "accent-icon-muted"
            }
            type="monochrome"
          />
        )}
      </Pressable>
    </Animated.View>
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
  readonly actionKey?: string;
  readonly size?: "regular" | "large";
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly onPress: NonNullable<PressableProps["onPress"]>;
  readonly variant?: "primary" | "stop";
  // Menu injects onLongPress on Android and onTouchStart/onPress on iOS.
  readonly onLongPress?: PressableProps["onLongPress"];
  readonly onTouchStart?: PressableProps["onTouchStart"];
}) {
  const touch = useRef(new ComposerActionTouch());
  const actionKey = `${props.variant ?? "primary"}:${props.actionKey ?? ""}`;
  const { scale, smallIconSize } = useAndroidControlSizing();
  const circleSize = Math.round((props.size === "large" ? 44 : 30) * scale);
  const fadeIcon = props.disabled === true && props.variant !== "stop";
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center active:opacity-70"
      style={props.size === "large" ? { width: 62 } : undefined}
      disabled={props.disabled}
      onPress={(event) => {
        if (touch.current.accept(actionKey, event.nativeEvent.identifier)) props.onPress(event);
      }}
      onLongPress={props.onLongPress}
      onTouchStart={(event) => {
        touch.current.begin(actionKey, event.nativeEvent.identifier);
        props.onTouchStart?.(event);
      }}
      onTouchCancel={() => touch.current.cancel()}
    >
      <View
        style={{ width: circleSize, height: circleSize }}
        className={cn(
          "items-center justify-center rounded-full",
          props.variant === "stop"
            ? "bg-danger"
            : props.disabled
              ? "bg-foreground/12"
              : "bg-primary",
        )}
      >
        {/* Fade the icon as one layer: a translucent tint, or opacity on a Tabler icon (which
            copies it onto every path), stacks where the SVG strokes overlap. */}
        <View
          className={fadeIcon ? "opacity-38" : undefined}
          needsOffscreenAlphaCompositing={fadeIcon}
        >
          <SymbolView
            name={props.icon}
            size={props.size === "large" ? Math.round(20 * scale) : smallIconSize}
            weight="semibold"
            tintColorClassName={
              props.variant === "stop"
                ? "accent-danger-foreground"
                : props.disabled
                  ? "accent-foreground"
                  : "accent-primary-foreground"
            }
            type="monochrome"
          />
        </View>
      </View>
    </Pressable>
  );
}
