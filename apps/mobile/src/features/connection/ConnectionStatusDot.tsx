// Adapted from T3 Code apps/mobile/src/features/connection/ConnectionStatusDot.tsx (MIT, see UPSTREAM.md).
import { View } from "react-native";

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

/** A host's readiness as a dot; it wears a still halo while Solus dials. */
export function ConnectionStatusDot(props: {
  readonly state: HostReadinessState;
  readonly size?: number;
}) {
  const isWaiting = isWaitingForHost(props.state.readiness);
  const { themeVariables } = useAppearancePreferences();
  const tone = statusDotTone(props.state, themeVariables);
  const dotSize = props.size ?? 10;
  const haloSize = dotSize + 4;
  const containerSize = haloSize + 4;

  return (
    <View
      style={{
        width: containerSize,
        height: containerSize,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* A still halo, not a loop: a looping Reanimated update can starve React commits (T3 #24273). */}
      {isWaiting ? (
        <View
          style={{
            position: "absolute",
            width: haloSize,
            height: haloSize,
            borderRadius: haloSize / 2,
            backgroundColor: tone.haloColor,
            opacity: 0.3,
          }}
        />
      ) : null}
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
