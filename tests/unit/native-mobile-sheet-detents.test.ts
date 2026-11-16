import { describe, expect, test } from "bun:test";
import { formSheetDetents } from "../../apps/mobile/src/native/sheet-detents";

describe("mobile sheet expansion", () => {
  test("iOS can expand every partial sheet to the full window", () => {
    for (const initial of [0.5, 0.65, 0.75, 0.92]) {
      expect(formSheetDetents("ios", initial, 0.95)).toEqual([initial, 1]);
    }
  });
  test("Android retains the route's expanded height", () => {
    expect(formSheetDetents("android", 0.5, 0.9)).toEqual([0.5, 0.9]);
    expect(formSheetDetents("android", 0.65, 0.95)).toEqual([0.65, 0.95]);
    expect(formSheetDetents("android", 0.75)).toEqual([0.75, 0.92]);
  });
});
