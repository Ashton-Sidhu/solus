import type { HostOperatingSystem } from "@solus/contracts/types";
import { useEffect, type ReactNode } from "react";
import { Platform, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  hostColumnLabel,
  pairingStatusLine,
  thisDeviceLabel,
  type BridgeColumnLabel,
  type PairingPhase,
} from "./lib/pairing-bridge";
import { OsLogo } from "./OsLogo";

const TILE = 64;
const TILE_RADIUS = 19;
const COMET = 64;
/** The band the line, its fill, and the comet's glow share, centred on the tiles. */
const TRACK_BAND = 10;
const SPRING = { damping: 14, stiffness: 220, mass: 0.8 };

type BridgeHost = { readonly name: string; readonly os?: HostOperatingSystem };

interface BridgePalette {
  readonly accent: string;
  readonly destructive: string;
  readonly card: string;
  readonly border: string;
  readonly foreground: string;
  readonly muted: string;
  readonly shadow: string;
  readonly highlight: string;
}

/**
 * This device, a hairline, and the host, as the desktop and web pairing stage
 * draws them. The one accent is light on the line: a comet while the exchange
 * runs, a fill when it lands. Nothing loops once the phase is settled, and
 * with reduced motion every phase shows its end state at once.
 */
export function PairingBridge({ phase, host }: { readonly phase: PairingPhase; readonly host: BridgeHost | null }) {
  const { themeVariables: theme, themeAppearance } = useAppearancePreferences();
  const reduceMotion = useReducedMotion();
  const palette: BridgePalette = {
    // Mobile's theme names the Solus accent (`--solus-accent`) as its focus colour.
    accent: theme["--color-focus"],
    destructive: theme["--color-danger-foreground"],
    card: theme["--color-card"],
    border: theme["--color-border"],
    foreground: theme["--color-foreground"],
    muted: theme["--color-foreground-muted"],
    shadow: theme["--color-drawer-shadow"],
    highlight: themeAppearance === "dark" ? "rgba(255, 255, 255, 0.08)" : "rgba(255, 255, 255, 0.9)",
  };
  const device = thisDeviceLabel(Platform.OS === "android" ? "android" : "ios", Platform.OS === "ios" && Platform.isPad);
  const hostLabel = hostColumnLabel(host);
  const status = pairingStatusLine(phase, host?.name ?? null);

  const trackWidth = useSharedValue(0);
  const glint = useSharedValue(0);
  const comet = useSharedValue(0);
  const fill = useSharedValue(0);
  const warm = useSharedValue(0);
  const ring = useSharedValue(0);
  const badge = useSharedValue(0);
  const failMark = useSharedValue(0);
  const shake = useSharedValue(0);
  const logo = useSharedValue(0);
  const hasHost = host !== null;

  useEffect(() => {
    if (!hasHost) {
      logo.value = 0;
      return;
    }
    logo.value = reduceMotion ? 1 : withSpring(1, SPRING);
  }, [hasHost, logo, reduceMotion]);

  useEffect(() => {
    for (const value of [glint, comet, fill, warm, ring, badge, failMark, shake]) {
      cancelAnimation(value);
      value.value = 0;
    }
    if (phase === "looking" && !reduceMotion) {
      glint.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.quad) }), -1, false);
    }
    if (phase === "pairing") {
      comet.value = reduceMotion
        ? 0.5
        : withRepeat(withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.cubic) }), -1, false);
    }
    if (phase === "paired") {
      if (reduceMotion) {
        fill.value = 1;
        warm.value = 1;
        badge.value = 1;
        return;
      }
      const lineFill = { duration: 550, easing: Easing.out(Easing.cubic) };
      fill.value = withTiming(1, lineFill);
      warm.value = withTiming(1, lineFill);
      ring.value = withDelay(450, withTiming(1, { duration: 700, easing: Easing.out(Easing.quad) }));
      glint.value = withDelay(450, withTiming(1, { duration: 700, easing: Easing.inOut(Easing.quad) }));
      badge.value = withDelay(600, withSpring(1, SPRING));
    }
    if (phase === "error") {
      if (reduceMotion) {
        fill.value = 0.5;
        failMark.value = 1;
        return;
      }
      fill.value = withTiming(0.5, { duration: 450, easing: Easing.out(Easing.cubic) });
      failMark.value = withDelay(350, withSpring(1, SPRING));
      const step = { duration: 75, easing: Easing.inOut(Easing.quad) };
      shake.value = withSequence(
        withTiming(-3, step),
        withTiming(3, step),
        withTiming(-3, step),
        withTiming(3, step),
        withTiming(-2, step),
        withTiming(0, step),
      );
    }
  }, [badge, comet, failMark, fill, glint, phase, reduceMotion, ring, shake, warm]);

  const cometStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -COMET + comet.value * (trackWidth.value + COMET) }],
  }));
  const fillStyle = useAnimatedStyle(() => ({ width: fill.value * trackWidth.value }));
  const failMarkStyle = useAnimatedStyle(() => ({ opacity: Math.min(failMark.value, 1), transform: [{ scale: failMark.value }] }));
  const logoStyle = useAnimatedStyle(() => ({ opacity: Math.min(logo.value, 1), transform: [{ scale: 0.6 + 0.4 * logo.value }] }));
  const shakeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));
  const warmStyle = useAnimatedStyle(() => ({ opacity: warm.value * 0.45 }));
  const ringStyle = useAnimatedStyle(() => ({
    opacity: ring.value > 0 ? (1 - ring.value) * 0.6 : 0,
    transform: [{ scale: 1 + 0.5 * ring.value }],
  }));
  const badgeStyle = useAnimatedStyle(() => ({ opacity: Math.min(badge.value, 1), transform: [{ scale: badge.value }] }));

  return (
    <View
      accessible
      accessibilityLabel={[device.name, hostLabel.name, status].filter(Boolean).join(", ")}
      accessibilityLiveRegion="polite"
      className="w-full max-w-[360px] items-center gap-3 self-center"
    >
      <View className="w-full flex-row items-start">
        <BridgeColumn label={device}>
          <BridgeTile palette={palette} washId="pairing-bridge-device-wash">
            {Platform.OS === "android" ? (
              <SymbolView name={{ ios: "iphone", android: "smartphone" }} size={28} tintColor={palette.foreground} />
            ) : (
              <OsLogo os="ios" size={30} color={palette.foreground} />
            )}
          </BridgeTile>
        </BridgeColumn>

        <View
          className="mx-2 flex-1"
          style={{ height: TILE }}
          onLayout={(event: LayoutChangeEvent) => {
            trackWidth.value = event.nativeEvent.layout.width;
          }}
        >
          <View
            className="absolute inset-x-0 justify-center overflow-hidden"
            style={{ top: TILE / 2 - TRACK_BAND / 2, height: TRACK_BAND }}
          >
            <View style={{ height: 1, backgroundColor: palette.border }} />
            <Animated.View
              className="absolute left-0 rounded-full"
              style={[
                { top: (TRACK_BAND - 1.5) / 2, height: 1.5 },
                { backgroundColor: phase === "error" ? palette.destructive : palette.accent },
                fillStyle,
              ]}
            />
            {phase === "pairing" ? (
              <Animated.View className="absolute left-0 top-0" style={[{ width: COMET, height: TRACK_BAND }, cometStyle]}>
                <Svg width={COMET} height={TRACK_BAND}>
                  <Defs>
                    <LinearGradient id="pairing-bridge-comet" x1="0" y1="0" x2="1" y2="0">
                      <Stop offset="0" stopColor={palette.accent} stopOpacity={0} />
                      <Stop offset="0.8" stopColor={palette.accent} stopOpacity={1} />
                      <Stop offset="1" stopColor="#ffffff" stopOpacity={1} />
                    </LinearGradient>
                    <LinearGradient id="pairing-bridge-comet-glow" x1="0" y1="0" x2="1" y2="0">
                      <Stop offset="0.3" stopColor={palette.accent} stopOpacity={0} />
                      <Stop offset="1" stopColor={palette.accent} stopOpacity={0.22} />
                    </LinearGradient>
                  </Defs>
                  <Rect x={0} y={2} width={COMET} height={TRACK_BAND - 4} rx={3} fill="url(#pairing-bridge-comet-glow)" />
                  <Rect x={0} y={(TRACK_BAND - 2) / 2} width={COMET} height={2} rx={1} fill="url(#pairing-bridge-comet)" />
                </Svg>
              </Animated.View>
            ) : null}
          </View>
          {phase === "error" ? (
            <Animated.View
              className="absolute items-center justify-center rounded-full"
              style={[
                {
                  left: "50%",
                  top: TILE / 2 - 9,
                  width: 18,
                  height: 18,
                  marginLeft: -9,
                  borderWidth: 1,
                  borderColor: themeColorWithAlpha(palette.destructive, 0.5),
                  backgroundColor: palette.card,
                },
                failMarkStyle,
              ]}
            >
              <SymbolView name="xmark" size={9} weight="bold" tintColor={palette.destructive} />
            </Animated.View>
          ) : null}
        </View>

        <BridgeColumn label={hostLabel}>
          <Animated.View style={[{ width: TILE, height: TILE }, shakeStyle]}>
            <BridgeTile palette={palette} washId="pairing-bridge-host-wash" glint={glint}>
              {host ? (
                <Animated.View style={logoStyle}>
                  {host.os ? (
                    <OsLogo os={host.os} size={30} color={palette.foreground} />
                  ) : (
                    <SymbolView name="globe" size={28} tintColor={palette.foreground} />
                  )}
                </Animated.View>
              ) : (
                <SymbolView name="plus" size={22} tintColor={palette.muted} />
              )}
            </BridgeTile>
            <Animated.View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, { borderRadius: TILE_RADIUS, borderWidth: 1, borderColor: palette.accent }, warmStyle]}
            />
            <Animated.View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, { borderRadius: TILE_RADIUS, borderWidth: 1, borderColor: palette.accent }, ringStyle]}
            />
            {phase === "paired" ? (
              <Animated.View
                className="absolute items-center justify-center rounded-full"
                style={[
                  {
                    right: -6,
                    bottom: -6,
                    width: 25,
                    height: 25,
                    borderWidth: 2.5,
                    borderColor: palette.card,
                    backgroundColor: palette.foreground,
                  },
                  badgeStyle,
                ]}
              >
                <SymbolView name="checkmark" size={10} weight="bold" tintColor={palette.card} />
              </Animated.View>
            ) : null}
          </Animated.View>
        </BridgeColumn>
      </View>

      <Text className="text-center text-[13px] text-foreground-muted">{status ?? " "}</Text>
    </View>
  );
}

/** A tile, its name, and its sub line. The sub line keeps its height when empty so both tiles stay level. */
function BridgeColumn({ label, children }: { readonly label: BridgeColumnLabel; readonly children: ReactNode }) {
  return (
    <View className="w-24 items-center">
      {children}
      <Text numberOfLines={1} className="mt-2 text-[12.5px] font-t3-medium text-foreground">
        {label.name}
      </Text>
      <Text numberOfLines={1} className="mt-px text-[12px] text-foreground-muted">
        {label.sub || " "}
      </Text>
    </View>
  );
}

function BridgeTile({
  palette,
  washId,
  glint,
  children,
}: {
  readonly palette: BridgePalette;
  readonly washId: string;
  readonly glint?: SharedValue<number>;
  readonly children: ReactNode;
}) {
  return (
    <View
      className="items-center justify-center"
      style={{
        width: TILE,
        height: TILE,
        borderRadius: TILE_RADIUS,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.card,
        boxShadow: `0 1px 2px ${palette.shadow}, 0 6px 16px ${palette.shadow}`,
      }}
    >
      <View pointerEvents="none" className="overflow-hidden" style={[StyleSheet.absoluteFill, { borderRadius: TILE_RADIUS - 1 }]}>
        <Svg width="100%" height="100%">
          <Defs>
            <LinearGradient id={washId} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={palette.foreground} stopOpacity={0} />
              <Stop offset="1" stopColor={palette.foreground} stopOpacity={0.07} />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width="100%" height="100%" fill={`url(#${washId})`} />
        </Svg>
        <View className="absolute top-0" style={{ left: 12, right: 12, height: 1, backgroundColor: palette.highlight }} />
        {glint ? <TileGlint progress={glint} id={`${washId}-glint`} /> : null}
      </View>
      {children}
    </View>
  );
}

/** A soft white band that crosses the tile corner to corner once per run of `progress` from 0 to 1. */
function TileGlint({ progress, id }: { readonly progress: SharedValue<number>; readonly id: string }) {
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: -TILE + progress.value * TILE * 2.2 }, { rotate: "22deg" }],
  }));
  return (
    <Animated.View className="absolute" style={[{ top: -TILE / 2, left: 0, width: 28, height: TILE * 2 }, style]}>
      <Svg width={28} height={TILE * 2}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor="#ffffff" stopOpacity={0} />
            <Stop offset="0.5" stopColor="#ffffff" stopOpacity={0.45} />
            <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={28} height={TILE * 2} fill={`url(#${id})`} />
      </Svg>
    </Animated.View>
  );
}
