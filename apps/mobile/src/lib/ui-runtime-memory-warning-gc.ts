// Adapted from T3 Code apps/mobile/src/lib/useUiRuntimeMemoryWarningGc.ts (MIT, see UPSTREAM.md).
import { AppState } from "react-native";
import { scheduleOnUI } from "react-native-worklets";

function collectUiRuntimeGarbage() {
  "worklet";
  // SAFETY: Hermes defines `gc` as a function on the UI runtime when it exposes
  // it; a runtime without it leaves it undefined and is skipped.
  const { gc } = globalThis as { gc?: () => void };
  gc?.();
}

/**
 * React Native collects only the main JS runtime on an iOS memory warning. The
 * Reanimated (worklets) UI runtime is a separate Hermes heap that keeps native
 * shadow nodes alive until its own collection runs, so collect it on the same
 * warning. Android sends no memory warning, so there this does nothing.
 * Returns the stop function.
 */
export function collectUiRuntimeGarbageOnMemoryWarning(): () => void {
  const subscription = AppState.addEventListener("memoryWarning", () => {
    scheduleOnUI(collectUiRuntimeGarbage);
  });
  return () => subscription.remove();
}
