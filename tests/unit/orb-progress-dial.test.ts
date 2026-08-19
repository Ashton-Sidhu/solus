import { describe, expect, it } from "bun:test";
import { dialCountFontRem } from "@solus/workspace-ui/components/layout/lib/orb-progress-dial";

// The dial text must never be wider than the ring it sits inside, or the count
// spills over the circle. Widest safe text box is ~1.55rem at the 2.25rem button.
const DIAL_TEXT_WIDTH_REM = 1.55;

function renderedWidthRem(
  currentStep: number,
  totalSteps: number,
  fontRem: number,
): number {
  const digits = `${currentStep}`.length + `${totalSteps}`.length;
  return fontRem * (digits * 0.6 + 0.42);
}

describe("dialCountFontRem", () => {
  it("keeps every plausible fraction inside the ring", () => {
    for (const [current, total] of [
      [1, 3],
      [8, 9],
      [12, 12],
      [7, 40],
      [128, 256],
    ] as const) {
      const font = dialCountFontRem(current, total);
      expect(renderedWidthRem(current, total, font)).toBeLessThanOrEqual(
        DIAL_TEXT_WIDTH_REM + 1e-9,
      );
    }
  });

  it("does not blow single-digit fractions up past the base text size", () => {
    expect(dialCountFontRem(3, 8)).toBe(0.75);
  });

  it("shrinks as the fraction gets wider", () => {
    expect(dialCountFontRem(12, 12)).toBeLessThan(dialCountFontRem(3, 8));
    expect(dialCountFontRem(128, 256)).toBeLessThan(dialCountFontRem(12, 12));
  });
});
