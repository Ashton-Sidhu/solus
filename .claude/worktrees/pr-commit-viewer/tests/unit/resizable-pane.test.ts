import { describe, expect, test } from "bun:test";
import {
  paneBoundsPercent,
  percentToPixels,
  pixelsToPercent,
} from "../../src/renderer/lib/resizablePane";

describe("resizable pane geometry", () => {
  test("converts persisted pixel widths without changing their physical size", () => {
    const percent = pixelsToPercent(288, 960);

    expect(percent).toBe(30);
    expect(percentToPixels(percent, 960)).toBe(288);
  });

  test("expresses pixel floors as percentages for PaneForge constraints", () => {
    expect(paneBoundsPercent(800, 192, 320)).toEqual({ min: 24, max: 40 });
  });

  test("keeps impossible narrow-container bounds valid instead of inverting them", () => {
    expect(paneBoundsPercent(160, 192, 120)).toEqual({ min: 100, max: 100 });
  });

  test("returns safe geometry before a pane has been measured", () => {
    expect(pixelsToPercent(280, 0)).toBe(0);
    expect(percentToPixels(40, 0)).toBe(0);
    expect(paneBoundsPercent(0, 192, 480)).toEqual({ min: 0, max: 100 });
  });
});
