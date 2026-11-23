import type { DotKeyframe } from "@solus/client-core/dot-marks";

/**
 * The timing of a dot mark on mobile (docs/plans/session-state-marks.md). The
 * native driver interpolates linearly and starts each loop at its own mount,
 * so this module turns the shared keyframes into linear ranges and tells
 * every copy where the shared cycle is now.
 */

/** Points sampled inside an eased segment; enough that the curve reads smooth at 3px. */
const EASED_SAMPLES = 6;
/** The native interpolation divides by each step, so equal inputs are pulled apart. */
const MIN_INPUT_STEP = 1e-6;

/** `cubic-bezier(x1,y1,x2,y2)` as a function of progress; null for an easing it does not know. */
export function cubicBezierEasing(easing: string): ((x: number) => number) | null {
  const match = /^cubic-bezier\(([^)]+)\)$/.exec(easing.replaceAll(" ", ""));
  const points = match?.[1]?.split(",").map(Number);
  if (points?.length !== 4 || points.some((point) => !Number.isFinite(point))) return null;
  const [x1, y1, x2, y2] = points as [number, number, number, number];
  const at = (t: number, a: number, b: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
  return (x) => {
    // Bisection on x(t): x1 and x2 stay in 0..1, so x(t) does not decrease.
    let low = 0;
    let high = 1;
    for (let i = 0; i < 30; i++) {
      const mid = (low + high) / 2;
      if (at(mid, x1, x2) < x) low = mid;
      else high = mid;
    }
    return at((low + high) / 2, y1, y2);
  };
}

/** One dot's keyframes as the input and output ranges of a linear interpolation. */
export function dotInterpolation(keyframes: readonly DotKeyframe[]): {
  inputRange: number[];
  outputRange: number[];
} {
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  const push = (offset: number, scale: number) => {
    const last = inputRange.at(-1);
    inputRange.push(last !== undefined && offset < last + MIN_INPUT_STEP ? last + MIN_INPUT_STEP : offset);
    outputRange.push(scale);
  };
  keyframes.forEach((from, index) => {
    push(from.offset, from.scale);
    const to = keyframes[index + 1];
    const ease = to && from.easing ? cubicBezierEasing(from.easing) : null;
    if (!to || !ease) return;
    for (let step = 1; step < EASED_SAMPLES; step++) {
      const progress = step / EASED_SAMPLES;
      push(
        from.offset + (to.offset - from.offset) * progress,
        from.scale + (to.scale - from.scale) * ease(progress),
      );
    }
  });
  return { inputRange, outputRange };
}

/** How far into its cycle a mark is at `nowMs`. Every copy counts from the same
 *  clock origin, so all copies of a mark are in phase. */
export function dotMarkPhase(durationMs: number, nowMs: number): number {
  return (((nowMs % durationMs) + durationMs) % durationMs) / durationMs;
}

/** The time until the shown mark ends its cycle: the next mark starts then. */
export function msUntilDotMarkCycleEnd(durationMs: number, nowMs: number): number {
  return durationMs * (1 - dotMarkPhase(durationMs, nowMs));
}
