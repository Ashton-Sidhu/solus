// Adapted from T3 Code `packages/client-runtime/src/device/renderScheduler.test.ts` (MIT, pingdotgg/t3code@77823bd102).
import { expect, it, vi } from "bun:test";
import { createRenderScheduler } from "../../packages/workspace-ui/src/components/devices/lib/phone-viewer/render-scheduler";

it("coalesces frame and pointer invalidations, then stops scheduling when idle or disposed", () => {
  const callbacks: FrameRequestCallback[] = [];
  const request = vi.fn((callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  const cancel = vi.fn();
  const render = vi.fn();
  const scheduler = createRenderScheduler(render, request, cancel);
  scheduler.invalidate();
  scheduler.invalidate();
  expect(request).toHaveBeenCalledTimes(1);
  callbacks[0]?.(0);
  expect(render).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(1);
  scheduler.invalidate();
  scheduler.dispose();
  scheduler.dispose();
  scheduler.invalidate();
  callbacks[1]?.(0);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledWith(2);
  expect(render).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(2);
});
