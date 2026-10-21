import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { Listeners } from "../../lib/listeners";

const MINUTE_MS = 60_000;
// Fire just after the boundary, so a label computed at the tick is already the new minute.
const BOUNDARY_SLACK_MS = 50;

/**
 * The time a thread list reads its row times, snooze countdowns and snooze
 * menus against (pingdotgg/t3code#20814). The list surface owns one and runs it
 * while it is on screen; each row reads it. A minute passing re-renders only
 * the rows whose answer changes, not the list: the rows are not rebuilt and the
 * shelves are not partitioned again. A snooze ending is not a minute tick; the
 * list arms its own timer at the exact wake time.
 */
export class ThreadListClock {
  private readonly changes = new Listeners();
  private readonly runningChanges = new Listeners();
  private time = Date.now();
  private runs = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private appState: { remove(): void } | null = null;

  readonly subscribe = this.changes.subscribe;

  /** Epoch milliseconds of the last tick. */
  readonly now = (): number => this.time;

  /** Hears the clock start and stop, not its ticks. */
  readonly subscribeRunning = this.runningChanges.subscribe;

  /** Whether the list shows and the app is active: a row's second clock
      (a "Working 26s" label) runs only then. */
  readonly isRunning = (): boolean => this.timer !== null;

  /** Ticks at each minute boundary while the app is active, until the
      returned stop runs. Each start and each return to active ticks at once:
      the last tick can be hours old. */
  start(): () => void {
    this.runs += 1;
    if (this.runs === 1) {
      this.appState = AppState.addEventListener("change", this.sync);
      // Read after subscribing: a change before the subscription has no event to replay.
      this.sync(AppState.currentState);
    }
    let hasStopped = false;
    return () => {
      if (hasStopped) return;
      hasStopped = true;
      this.runs -= 1;
      if (this.runs > 0) return;
      this.appState?.remove();
      this.appState = null;
      this.pause();
    };
  }

  private readonly sync = (state: typeof AppState.currentState): void => {
    if (state !== "active") this.pause();
    else if (this.timer === null) {
      this.tick();
      this.runningChanges.notify();
    }
  };

  private readonly tick = (): void => {
    const time = Date.now();
    this.time = time;
    this.changes.notify();
    this.timer = setTimeout(this.tick, MINUTE_MS - (time % MINUTE_MS) + BOUNDARY_SLACK_MS);
  };

  private pause(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.runningChanges.notify();
  }
}

/** What a row draws from the clock. It re-renders only when this answer changes. */
export function useThreadListTime<T extends string | number | null | undefined>(
  clock: ThreadListClock,
  read: (now: number) => T,
): T {
  const snapshot = () => read(clock.now());
  return useSyncExternalStore(clock.subscribe, snapshot, snapshot);
}

/** Runs the clock while `running`. A pane that stays mounted while hidden does
    not tick; shown again, it reads the time at once. */
export function useThreadListClockWhile(clock: ThreadListClock, running: boolean): void {
  useEffect(() => (running ? clock.start() : undefined), [clock, running]);
}
