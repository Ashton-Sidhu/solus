import {
  DOT_GAP_PX,
  DOT_GRID_SIZE,
  DOT_MARKS,
  DOT_SIZE_PX,
  type DotMarkName,
} from "@solus/client-core/dot-marks";
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { Animated, Easing, useAnimatedValue, View } from "react-native";

import { useAppActive, useReduceMotionEnabled } from "../../lib/appState";
import { cn } from "../../lib/cn";
import { dotInterpolation, dotMarkPhase, msUntilDotMarkCycleEnd } from "./dotMatrixMotion";

const BOX_PX = DOT_GRID_SIZE * DOT_SIZE_PX + (DOT_GRID_SIZE - 1) * DOT_GAP_PX;

/**
 * A dot mark: a letter or a pattern on the 3×3 dot grid
 * (docs/plans/session-state-marks.md). Only the scale of each dot moves.
 * It uses a native Animated loop instead of Reanimated, whose per-frame
 * commits starve React's while commit pausing is disabled (package.json).
 */
export function DotMatrix(props: {
  readonly mark: DotMarkName;
  /** A background class for the dots, such as `bg-adaptive-sky-600-400`. */
  readonly dotClassName: string;
}) {
  const reducedMotion = useReduceMotionEnabled();
  const appIsActive = useAppActive();
  const screenIsFocused = useIsFocused();
  // A new mark waits for the shown one to end its cycle; a mark that is
  // shorter than the rest of the cycle does not show.
  const [shown, setShown] = useState(props.mark);
  const definition = DOT_MARKS[shown];
  const animating = !reducedMotion && appIsActive && screenIsFocused;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the shown mark until its cycle ends, with one timeout for each change
  useEffect(() => {
    if (props.mark === shown) return;
    if (!animating) {
      setShown(props.mark);
      return;
    }
    const timer = setTimeout(
      () => setShown(props.mark),
      msUntilDotMarkCycleEnd(DOT_MARKS[shown].durationMs, performance.now()),
    );
    return () => clearTimeout(timer);
  }, [animating, props.mark, shown]);

  const clock = useAnimatedValue(0, { useNativeDriver: true });
  const phase = useAnimatedValue(0, { useNativeDriver: true });
  const offset = useMemo(() => Animated.modulo(Animated.add(clock, phase), 1), [clock, phase]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the native loop in phase with the shared clock, and stops it on cleanup
  useEffect(() => {
    if (!animating) return;
    phase.setValue(dotMarkPhase(definition.durationMs, performance.now()));
    clock.setValue(0);
    const loop = Animated.loop(
      Animated.timing(clock, {
        toValue: 1,
        duration: definition.durationMs,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [animating, clock, definition, phase]);

  const scales = useMemo(
    () =>
      definition.dots.map(({ keyframes }) =>
        offset.interpolate({ ...dotInterpolation(keyframes), extrapolate: "clamp" }),
      ),
    [definition, offset],
  );

  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ width: BOX_PX, height: BOX_PX }}
    >
      {definition.dots.map(({ cell: [row, col] }, index) => (
        <Animated.View
          key={`${row}:${col}`}
          style={{
            position: "absolute",
            top: row * (DOT_SIZE_PX + DOT_GAP_PX),
            left: col * (DOT_SIZE_PX + DOT_GAP_PX),
            width: DOT_SIZE_PX,
            height: DOT_SIZE_PX,
            transform: [{ scale: animating ? scales[index]! : definition.stillScale }],
          }}
        >
          <View className={cn("flex-1 rounded-full", props.dotClassName)} />
        </Animated.View>
      ))}
    </View>
  );
}
