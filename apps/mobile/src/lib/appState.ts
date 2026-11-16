// Adapted from T3 Code apps/mobile/src/lib/appState.ts (MIT, see UPSTREAM.md).
import { useEffect, useState } from "react";
import { AppState } from "react-native";

/** True while the app is in the foreground: a live stream stops behind the lock screen. */
export function useAppForeground(): boolean {
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => setForeground(next === "active"));
    return () => subscription.remove();
  }, []);
  return foreground;
}
