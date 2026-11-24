import { Listeners } from "../../lib/listeners";
import type { KeyValueStore } from "../../platform/ports";

const KEY = "solus.liveActivities.enabled";

/**
 * Whether this device shows a Live Activity on iOS or an ongoing notification
 * on Android. This is on by default, subject to the device's permissions.
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
