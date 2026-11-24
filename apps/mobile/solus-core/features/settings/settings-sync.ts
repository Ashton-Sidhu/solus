import { SettingsSyncHosts } from '@solus/client-core/settings-sync-hosts'
import type { DocumentSyncStorage } from '@solus/client-core/document-sync'
import type { HostConfigPatch } from '@solus/contracts/host-config'
import type { PersonalSettingsPatch } from '@solus/contracts/settings'
import type { HostConnection } from '../hosts/host-connections'
import { Listeners } from '../../lib/listeners'

export interface SettingsSyncDeps {
  /** Every host this phone keeps, ready or not. */
  hostIds(): string[]
  /** The hosts this phone is connected to now. */
  readyConnections(): HostConnection[]
  /** Changes when a host connects or leaves. */
  connectionChanges: Listeners
  /** The person may change this host's config (`host.admin`). */
  mayWriteHostConfig(hostId: string): boolean
  isSignedIn(): boolean
  /** The phone's home host, its first host: what a new host copies from. */
  homeHostId(): string | null
  storage: DocumentSyncStorage
}

/**
 * Sync settings on the phone (docs/plans/settings-sync-hosts.md), as
 * `settingsSyncStore` does it on desktop and web: the one owner of the
 * `SettingsSyncHosts` engine and of the switch of each host that the environment
 * page shows. Signed in, nothing shows and nothing moves host to host.
 */
export class SettingsSync {
  readonly changes = new Listeners()
  private readonly engine: SettingsSyncHosts
  private readonly saving = new Set<string>()
  /** One `personalDocument.changed` subscription per ready connection. */
  private readonly watches = new Map<string, { connection: HostConnection; stop: () => void }>()
  private readonly stopConnections: () => void

  constructor(private readonly deps: SettingsSyncDeps) {
    this.engine = new SettingsSyncHosts({
      knownHostIds: deps.hostIds,
      readyHost: (hostId) => {
        const connection = deps.readyConnections().find((candidate) => candidate.hostId === hostId)
        return connection ? { api: connection.api, mayWriteHostConfig: () => deps.mayWriteHostConfig(hostId) } : null
      },
      isSignedIn: deps.isSignedIn,
      copySourceId: deps.homeHostId,
      storage: deps.storage,
      onSwitchesChange: () => this.changes.notify(),
    })
    this.stopConnections = deps.connectionChanges.subscribe(() => this.refresh())
    this.refresh()
  }

  /** Signed in, the checkbox and the switch do not show. */
  get isShown(): boolean {
    return !this.deps.isSignedIn()
  }

  /** On, or null while the phone has not read the host's switch. */
  switchOf = (hostId: string): boolean | null => this.engine.switchOf(hostId)

  isSaving = (hostId: string): boolean => this.saving.has(hostId)

  /** A host connected or left, or the person signed in or out. */
  refresh(): void {
    this.watchConnections()
    this.engine.refresh()
    this.changes.notify()
  }

  async setSwitch(hostId: string, syncSettings: boolean): Promise<void> {
    if (this.saving.has(hostId)) return
    this.saving.add(hostId)
    this.changes.notify()
    try {
      await this.engine.setSwitch(hostId, syncSettings)
    } finally {
      this.saving.delete(hostId)
      this.changes.notify()
    }
  }

  /** The person added or paired a host on this phone, with the Sync settings checkbox as they left it. */
  hostAdded(hostId: string, syncSettings: boolean): void {
    this.engine.hostAdded(hostId, { syncSettings })
  }

  personalChanged(fromHostId: string | null, change: PersonalSettingsPatch): void {
    if (fromHostId) this.engine.personalChanged(fromHostId, change)
  }

  hostConfigChanged(fromHostId: string, patch: HostConfigPatch): void {
    this.engine.hostConfigChanged(fromHostId, patch)
  }

  forgetHost(hostId: string): void {
    this.watches.get(hostId)?.stop()
    this.watches.delete(hostId)
    this.engine.forget(hostId)
  }

  dispose(): void {
    this.stopConnections()
    for (const watch of this.watches.values()) watch.stop()
    this.watches.clear()
  }

  /** Another client of the person turned a switch: the host says so. */
  private watchConnections(): void {
    const ready = this.deps.readyConnections()
    for (const [hostId, watch] of this.watches) {
      if (!ready.includes(watch.connection)) {
        watch.stop()
        this.watches.delete(hostId)
      }
    }
    for (const connection of ready) {
      if (this.watches.get(connection.hostId)?.connection === connection) continue
      const stop = connection.events.subscribe('personalDocument.changed', ({ kind }) => {
        if (kind === 'settings-sync') this.engine.hostChanged(connection.hostId)
      })
      this.watches.set(connection.hostId, { connection, stop })
    }
  }
}
