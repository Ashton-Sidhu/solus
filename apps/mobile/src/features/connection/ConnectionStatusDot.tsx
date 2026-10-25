// Adapted from T3 Code apps/mobile/src/features/connection/ConnectionStatusDot.tsx (MIT, see UPSTREAM.md).
import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { isWaitingForHost, type HostReadinessState } from "@solus/client-core/host-readiness";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { themeColorWithAlpha, type MobileThemeVariables } from "../../lib/mobileTheme";

/** A host state the person should act on: it refused this device, or it stopped answering. */
export function isHostReadinessFailure(state: HostReadinessState): boolean {
  return state.readiness === "refused" || (state.readiness === "unreachable" && state.unreachableReason === "no-answer");
}

function statusDotTone(
  state: HostReadinessState,
  theme: MobileThemeVariables,
): {
  readonly dotColor: string;
  readonly haloColor: string;
} {
  if (state.readiness === "ready") {
    return {
      dotColor: theme["--color-adaptive-emerald-600-400"],
      haloColor: themeColorWithAlpha(theme["--color-adaptive-emerald-600-400"], 0.48),
    };
  }
  if (isWaitingForHost(state.readiness)) {
    return {
      dotColor: theme["--color-adaptive-amber-700-400"],
      haloColor: themeColorWithAlpha(theme["--color-adaptive-amber-700-400"], 0.5),
    };
  }
  if (isHostReadinessFailure(state)) {
    return {
      dotColor: theme["--color-adaptive-rose-600-400"],
      haloColor: themeColorWithAlpha(theme["--color-adaptive-rose-600-400"], 0.48),
    };
  }
  // A stopped host, one with no address yet, or a removed one is not a
  // failure of this phone: it wears the neutral dot.
  return {
    dotColor: theme["--color-icon-muted"],
    haloColor: themeColorWithAlpha(theme["--color-icon-muted"], 0.42),
  };
}

function usePulseAnimation(pulse: boolean) {
  const pulseProgress = useSharedValue(0);

  useEffect(() => {
    if (pulse) {
      pulseProgress.value = withRepeat(
        withTiming(1, {
          duration: 1100,
          easing: Easing.out(Easing.cubic),
        }),
        -1,
        false,
      );
      return;
    }

    cancelAnimation(pulseProgress);
    pulseProgress.value = withTiming(0, {
      duration: 180,
      easing: Easing.out(Easing.quad),
    });
  }, [pulse, pulseProgress]);

  return pulseProgress;
}

/** A host's readiness as a dot; it pulses while Solus dials. */
export function ConnectionStatusDot(props: {
  readonly state: HostReadinessState;
  readonly size?: number;
}) {
  const pulse = isWaitingForHost(props.state.readiness);
  const pulseProgress = usePulseAnimation(pulse);
  const { themeVariables } = useAppearancePreferences();
  const tone = statusDotTone(props.state, themeVariables);
  const dotSize = props.size ?? 10;
  const haloSize = dotSize + 4;
  const containerSize = haloSize + 4;

  const haloStyle = useAnimatedStyle(() => ({
    opacity: pulse ? 0.14 + (1 - pulseProgress.value) * 0.3 : 0,
    transform: [{ scale: 0.78 + pulseProgress.value * 1.16 }],
  }));

  return (
    <View
      style={{
        width: containerSize,
        height: containerSize,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Animated.View
        style={[
          haloStyle,
          {
            position: "absolute",
            width: haloSize,
            height: haloSize,
            borderRadius: haloSize / 2,
            backgroundColor: tone.haloColor,
          },
        ]}
      />
      <View
        style={{
          width: dotSize,
          height: dotSize,
          borderRadius: dotSize / 2,
          backgroundColor: tone.dotColor,
        }}
      />
    </View>
  );
}
