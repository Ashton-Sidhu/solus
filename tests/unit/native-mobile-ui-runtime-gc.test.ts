import { afterEach, describe, expect, it, mock } from "bun:test";

const listeners = new Map<string, Set<() => void>>();
const scheduled: Array<() => void> = [];
mock.module("react-native", () => ({
  AppState: {
    addEventListener: (event: string, listener: () => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return { remove: () => set.delete(listener) };
    },
  },
}));
mock.module("react-native-worklets", () => ({
  scheduleOnUI: (worklet: () => void) => scheduled.push(worklet),
}));

const { collectUiRuntimeGarbageOnMemoryWarning } = await import(
  "../../apps/mobile/src/lib/ui-runtime-memory-warning-gc"
);

const runtime = globalThis as { gc?: () => void };
const originalGc = runtime.gc;

function warnMemory() {
  for (const listener of listeners.get("memoryWarning") ?? []) listener();
}

afterEach(() => {
  runtime.gc = originalGc;
  scheduled.length = 0;
  listeners.clear();
});

describe("UI runtime collection on a memory warning", () => {
  it("collects the UI runtime once per warning", () => {
    // WHY: React Native collects only the main runtime on a memory warning; the
    // UI runtime keeps native views alive until something collects it.
    const stop = collectUiRuntimeGarbageOnMemoryWarning();
    expect(scheduled).toHaveLength(0);
    warnMemory();
    expect(scheduled).toHaveLength(1);

    const gc = mock(() => {});
    runtime.gc = gc;
    scheduled[0]!();
    expect(gc).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does nothing on a runtime without gc", () => {
    const stop = collectUiRuntimeGarbageOnMemoryWarning();
    warnMemory();
    runtime.gc = undefined;
    expect(() => scheduled[0]!()).not.toThrow();
    stop();
  });

  it("stops listening when stopped", () => {
    const stop = collectUiRuntimeGarbageOnMemoryWarning();
    stop();
    warnMemory();
    expect(scheduled).toHaveLength(0);
  });
});
