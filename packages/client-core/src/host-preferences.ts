import type { SolusAPI } from '@solus/contracts/host-api'
import type { ExecutionPreferences } from '@solus/contracts/settings'

/** A host this client can call now. */
export interface ReadyHost {
  hostId: string
  api: Pick<SolusAPI, 'executionPreferencesSet'>
}

export interface HostPreferencesPorts {
  /** The person's execution preferences as this client holds them now. */
  preferences(): ExecutionPreferences
  /** The hosts this client is connected to now. */
  readyHosts(): ReadyHost[]
}

/**
 * Keeps each connected host's copy of the person's execution preferences
 * current (docs/plans/host-preferences.md). A host reads that copy for the
 * person's work; no request carries the preferences. Call `publish` when a host
 * connects or leaves, and when the preferences change: each ready host that
 * does not hold this copy yet gets it once. A host that leaves gets it again
 * when it is back, so a host restart is covered. A failed write is tried again
 * at the next `publish`.
 */
export class HostPreferencesPublisher {
  /** hostId → the copy this client last wrote there. */
  private readonly written = new Map<string, string>()

  constructor(private readonly ports: HostPreferencesPorts) {}

  publish(): void {
    const preferences = this.ports.preferences()
    const copy = JSON.stringify(preferences)
    const ready = this.ports.readyHosts()
    for (const hostId of this.written.keys()) {
      if (!ready.some((host) => host.hostId === hostId)) this.written.delete(hostId)
    }
    for (const host of ready) {
      if (this.written.get(host.hostId) === copy) continue
      this.written.set(host.hostId, copy)
      host.api.executionPreferencesSet(preferences).catch(() => {
        // An older host, or a connection that dropped: the next publish writes again.
        if (this.written.get(host.hostId) === copy) this.written.delete(host.hostId)
      })
    }
  }
}
