// Adapted from T3 Code apps/mobile/src/features/threads/use-visible-second-clock.ts (MIT, see UPSTREAM.md).
import { useIsFocused } from "@react-navigation/native";
import { useLayoutEffect, useState } from "react";
import { AppState } from "react-native";

/**
 * Calls `onTick` with the time now and then once a second, only while the app
 * is active. Each return to active reads the clock at once, so a label never
 * shows the moment it paused. Returns the stop function.
 */
export function tickWhileAppActive(onTick: (nowMs: number) => void): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const sync = (state: typeof AppState.currentState) => {
    if (state !== "active") {
      if (timer !== null) clearInterval(timer);
      timer = null;
      return;
    }
    if (timer !== null) return;
    onTick(Date.now());
    timer = setInterval(() => onTick(Date.now()), 1_000);
  };
  const subscription = AppState.addEventListener("change", sync);
  // Read after subscribing: a change before the subscription has no event to replay.
  sync(AppState.currentState);
  return () => {
    subscription.remove();
    if (timer !== null) clearInterval(timer);
  };
}

/**
 * The time now for an elapsed-time label, advanced once a second only while
 * `enabled`, the screen is focused, and the app is active. A thread route stays
 * mounted when hidden, so an ungated interval re-renders it all the time.
 */
export function useVisibleSecondClock(enabled: boolean): number {
  const focused = useIsFocused();
  const [nowMs, setNowMs] = useState(() => Date.now());
  // A layout effect, so the first frame after a return shows the current time.
  useLayoutEffect(() => (enabled && focused ? tickWhileAppActive(setNowMs) : undefined), [enabled, focused]);
  return nowMs;
}
