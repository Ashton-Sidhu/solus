// Adapted from T3 Code apps/mobile/src/features/threads/use-visible-second-clock.test.tsx (MIT, see apps/mobile/UPSTREAM.md).
import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";

const appState = {
  current: "active",
  listeners: new Set<(state: string) => void>(),
  set(next: string) {
    this.current = next;
    for (const listener of this.listeners) listener(next);
  },
};
mock.module("react-native", () => ({
  AppState: {
    get currentState() {
      return appState.current;
    },
    addEventListener: (_event: "change", listener: (state: string) => void) => {
      appState.listeners.add(listener);
      return { remove: () => appState.listeners.delete(listener) };
    },
  },
}));
mock.module("@react-navigation/native", () => ({ useIsFocused: () => true }));

const { tickWhileAppActive } = await import(
  "../../apps/mobile/src/features/threads/use-visible-second-clock"
);

const START_MS = Date.UTC(2026, 9, 9, 12, 0, 0);
let ticks: number[] = [];
let stop = () => {};
// Bun's fake timers do not move `Date.now`, so the wall clock moves with them here.
let wallClock = START_MS;

function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
    wallClock += 1_000;
    jest.advanceTimersByTime(1_000);
  }
}

function start() {
  stop = tickWhileAppActive((nowMs) => ticks.push(nowMs));
}

beforeEach(() => {
  jest.useFakeTimers();
  wallClock = START_MS;
  spyOn(Date, "now").mockImplementation(() => wallClock);
  appState.current = "active";
  appState.listeners.clear();
  ticks = [];
});

afterEach(() => {
  stop();
  jest.useRealTimers();
  mock.restore();
});

describe("elapsed-time clock", () => {
  it("reads the time at once and then ticks once a second while the app is active", () => {
    start();
    advance(60_000);
    expect(ticks).toHaveLength(61);
    expect(ticks.at(-1)).toBe(START_MS + 60_000);
  });

  it("does not wake while the app is in the background or inactive", () => {
    // WHY: a working thread left on screen must not re-render it every second
    // while the phone is locked or the app is in the background.
    appState.current = "background";
    start();
    advance(60_000);
    appState.set("inactive");
    advance(60_000);
    expect(ticks).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("pauses in the background and shows the true time on return", () => {
    start();
    appState.set("background");
    const paused = ticks.length;
    advance(600_000);
    expect(ticks).toHaveLength(paused);

    appState.set("active");
    expect(ticks.at(-1)).toBe(START_MS + 600_000);
    advance(1_000);
    expect(ticks.at(-1)).toBe(START_MS + 601_000);
  });

  it("does not start a second interval for a repeated active event", () => {
    start();
    appState.set("active");
    advance(10_000);
    expect(ticks).toHaveLength(11);
  });

  it("stops its interval and its AppState listener when stopped", () => {
    start();
    expect(jest.getTimerCount()).toBe(1);
    expect(appState.listeners.size).toBe(1);
    stop();
    expect(jest.getTimerCount()).toBe(0);
    expect(appState.listeners.size).toBe(0);
  });
});
