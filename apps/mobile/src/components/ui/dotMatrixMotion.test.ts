import { DOT_MARKS, RUN_MOTION_MS, WRITE_MOTION_EASING } from "@solus/client-core/dot-marks";
import { describe, expect, it } from "vite-plus/test";

import {
  cubicBezierEasing,
  dotInterpolation,
  dotMarkPhase,
  msUntilDotMarkCycleEnd,
} from "./dotMatrixMotion";

describe("dotInterpolation", () => {
  it("gives the native driver strictly rising inputs for every dot of every mark", () => {
    // Orbit has two keyframes at one offset; native interpolation divides by each step.
    for (const definition of Object.values(DOT_MARKS)) {
      for (const { keyframes } of definition.dots) {
        const { inputRange, outputRange } = dotInterpolation(keyframes);
        expect(inputRange[0]).toBe(0);
        expect(inputRange.length).toBe(outputRange.length);
        for (let i = 1; i < inputRange.length; i++) expect(inputRange[i]!).toBeGreaterThan(inputRange[i - 1]!);
      }
    }
  });

  it("keeps each keyframe's scale and follows the write-motion easing between them", () => {
    const keyframes = [
      { offset: 0, scale: 0, easing: WRITE_MOTION_EASING },
      { offset: 0.6, scale: 1 },
      { offset: 1, scale: 1 },
    ];
    const { inputRange, outputRange } = dotInterpolation(keyframes);
    const scaleAt = (offset: number) => outputRange[inputRange.findIndex((input) => Math.abs(input - offset) < 1e-9)];
    expect(scaleAt(0)).toBe(0);
    expect(scaleAt(0.6)).toBe(1);
    // Halfway through the eased grow, the scale is the curve's, not the linear 0.5.
    const ease = cubicBezierEasing(WRITE_MOTION_EASING)!;
    expect(scaleAt(0.3)).toBeCloseTo(ease(0.5), 6);
    expect(ease(0.5)).toBeGreaterThan(0.6);
  });

  it("leaves a linear segment as its two ends", () => {
    expect(dotInterpolation([{ offset: 0, scale: 1 }, { offset: 1, scale: 0.5 }])).toEqual({
      inputRange: [0, 1],
      outputRange: [1, 0.5],
    });
  });
});

describe("dot mark timing", () => {
  it("puts copies mounted at different times in the same phase", () => {
    // Both read the shared clock; neither counts from its own mount.
    expect(dotMarkPhase(RUN_MOTION_MS, 10 * RUN_MOTION_MS + 175)).toBeCloseTo(dotMarkPhase(RUN_MOTION_MS, 175), 9);
    expect(dotMarkPhase(1600, 3200)).toBe(0);
    expect(dotMarkPhase(1600, 400)).toBe(0.25);
  });

  it("holds the shown mark until its cycle ends", () => {
    expect(msUntilDotMarkCycleEnd(1600, 400)).toBe(1200);
    expect(msUntilDotMarkCycleEnd(1600, 1600 * 3 + 1500)).toBeCloseTo(100, 6);
  });
});
