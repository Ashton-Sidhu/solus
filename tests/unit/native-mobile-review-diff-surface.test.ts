// Adapted from T3 Code apps/mobile/src/features/diffs/nativeReviewDiffSurface.test.ts (MIT, see apps/mobile/UPSTREAM.md).
// Each case loads a fresh copy of the module (a query string) in place of vitest's `resetModules`.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

import { NativeViewResolutionError } from "../../apps/mobile/src/native/nativeViewResolutionError";

const requireNativeView = mock<(name: string) => unknown>(() => undefined);
mock.module("expo", () => ({ requireNativeView }));

const SURFACE = "../../apps/mobile/src/features/diffs/nativeReviewDiffSurface";
type Surface = typeof import("../../apps/mobile/src/features/diffs/nativeReviewDiffSurface");
let loadCount = 0;
const loadSurface = (): Promise<Surface> => import(`${SURFACE}.ts?case=${loadCount++}`);

interface ExpoGlobal {
  expo?: { getViewConfig?: (moduleName: string) => unknown };
}
const expoGlobal = globalThis as typeof globalThis & ExpoGlobal;
const originalExpo = expoGlobal.expo;
const nativeView = () => null;

function setExpoViewConfigAvailable() {
  expoGlobal.expo = { getViewConfig: () => ({ validAttributes: {}, directEventTypes: {} }) };
}

describe("resolveNativeReviewDiffView", () => {
  beforeEach(() => {
    requireNativeView.mockReset();
    expoGlobal.expo = undefined;
  });

  afterEach(() => {
    expoGlobal.expo = originalExpo;
  });

  it("returns null when the native review diff view config is unavailable", async () => {
    const { resolveNativeReviewDiffView } = await loadSurface();
    expect(resolveNativeReviewDiffView()).toBeNull();
    expect(requireNativeView).not.toHaveBeenCalled();
  });

  it("returns the payload bridge when the native review diff view is installed", async () => {
    setExpoViewConfigAvailable();
    requireNativeView.mockReturnValue(nativeView);
    const { resolveNativeReviewDiffView } = await loadSurface();
    const resolvedView = resolveNativeReviewDiffView();
    expect(resolvedView).not.toBeNull();
    expect(resolvedView).not.toBe(nativeView);
    expect(resolveNativeReviewDiffView()).toBe(resolvedView);
    expect(requireNativeView).toHaveBeenCalledWith("T3ReviewDiffSurface");
  });

  it("returns null when the view manager cannot be required", async () => {
    setExpoViewConfigAvailable();
    const cause = new Error("boom");
    requireNativeView.mockImplementation(() => {
      throw cause;
    });
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { resolveNativeReviewDiffView } = await loadSurface();

      expect(resolveNativeReviewDiffView()).toBeNull();
      expect(resolveNativeReviewDiffView()).toBeNull();
      expect(requireNativeView).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledTimes(1);
      const [error] = consoleError.mock.calls[0]!;
      expect(error).toBeInstanceOf(NativeViewResolutionError);
      expect(error).toMatchObject({ nativeModuleName: "T3ReviewDiffSurface", cause });
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("isPendingNativeViewRegistration", () => {
  it("recognizes registration races for the installed native view name", async () => {
    const { isPendingNativeViewRegistration } = await loadSurface();

    expect(
      isPendingNativeViewRegistration(
        new Error("Unable to find the 'T3ReviewDiffSurface' view for this native tag"),
      ),
    ).toBe(true);
    expect(
      isPendingNativeViewRegistration(
        new Error("Unable to find the 'T3ReviewDiffView' view for this native tag"),
      ),
    ).toBe(false);
    expect(
      isPendingNativeViewRegistration(
        new Error(
          "Unable to find the class expo.modules.t3reviewdiff.T3ReviewDiffView view with tag 1150",
        ),
      ),
    ).toBe(true);
  });
});

describe("isNativeReviewDiffDrawEvent", () => {
  it("accepts only native events emitted after diff rows draw", async () => {
    const { isNativeReviewDiffDrawEvent } = await loadSurface();

    expect(isNativeReviewDiffDrawEvent({ message: "draw-metrics" })).toBe(true);
    expect(isNativeReviewDiffDrawEvent({ message: "visible-range" })).toBe(true);
    expect(isNativeReviewDiffDrawEvent({ message: "rows-decoded" })).toBe(false);
  });
});
