import { Listeners } from "../../lib/listeners";
import type { KeyValueStore } from "../../platform/ports";

const KEY = "solus.liveActivities.enabled";

/**
 * Whether this device shows agent work as a Live Activity. A device setting,
 * on by default as in T3 Code; iOS Settings can still turn Live Activities off
 * for the app, which `start` then reports by returning nothing.
 */
export class LiveActivityPreference {
  readonly changes = new Listeners();

  constructor(private readonly storage: KeyValueStore) {}

  enabled = (): boolean => this.storage.getItem(KEY) !== "false";

  set(enabled: boolean): void {
    this.storage.setItem(KEY, enabled ? "true" : "false");
    this.changes.notify();
  }
}
