// Adapted from T3 Code `packages/client-runtime/src/device/shapeProfile.test.ts` (MIT, pingdotgg/t3code@77823bd102).
import { expect, it } from "bun:test";
import { resolveDeviceBody } from "../../packages/workspace-ui/src/components/devices/lib/phone-viewer/body-profile";

it("chooses tablet and phone families without mistaking display rotation for device shape", () => {
  expect(
    resolveDeviceBody({ platform: "ios", name: "iPad Pro 11-inch (M5)", portraitAspect: 0.75 }).id,
  ).toBe("ios-tablet");
  expect(
    resolveDeviceBody({ platform: "ios", name: "iPhone 18 Pro", portraitAspect: 0.46 }).id,
  ).toBe("ios-phone");
  expect(
    resolveDeviceBody({ platform: "android", name: "Pixel 9", portraitAspect: 0.45 }).id,
  ).toBe("android-phone");
  expect(
    resolveDeviceBody({ platform: "android", name: "Pixel Tablet", portraitAspect: 0.625 }).id,
  ).toBe("android-tablet");
});

it("uses the screen shape for renamed devices and a phone fallback before metadata arrives", () => {
  expect(resolveDeviceBody({ platform: "ios", name: "Julius", portraitAspect: 0.75 }).id).toBe(
    "ios-tablet",
  );
  expect(resolveDeviceBody({ platform: "android", portraitAspect: 0.45 }).id).toBe(
    "android-phone",
  );
  expect(resolveDeviceBody({ platform: "ios", portraitAspect: Number.NaN }).id).toBe("ios-phone");
});
