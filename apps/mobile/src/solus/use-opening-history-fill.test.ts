// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { useOpeningHistoryFill } from "./use-opening-history-fill";

it.each([true, false])("loads older turns when the reader can scroll back (%s)", async (canScroll) => {
  vi.useFakeTimers();
  vi.stubGlobal("requestIdleCallback", (run: () => void) => setTimeout(run, 0));
  vi.stubGlobal("cancelIdleCallback", clearTimeout);
  const root = createRoot(document.createElement("div"));
  const insert = vi.fn();
  const fill = async (beforeInsert: () => Promise<void>) => {
    await beforeInsert();
    insert();
  };
  const canScrollBack = () => canScroll;
  let gestures: ReturnType<typeof useOpeningHistoryFill>;
  function Feed() {
    gestures = useOpeningHistoryFill(fill, "older", false, "thread", canScrollBack);
    return null;
  }
  try {
    await act(() => root.render(createElement(Feed)));
    await act(() => vi.runAllTimersAsync());
    expect(insert).toHaveBeenCalledTimes(canScroll ? 0 : 1);
    if (canScroll) {
      await act(() => gestures.onScrollBeginDrag());
      await act(() => vi.runAllTimersAsync());
      expect(insert).not.toHaveBeenCalled();
      await act(() => gestures.onScrollEndDrag());
      await act(() => vi.runAllTimersAsync());
      expect(insert).toHaveBeenCalledOnce();
    }
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
