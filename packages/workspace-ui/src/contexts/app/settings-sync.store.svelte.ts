import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import { hostCatalog } from '@solus/client-core/host-catalog'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { SettingsSyncHosts } from '@solus/client-core/settings-sync-hosts'
import type { HostConfigPatch } from '@solus/contracts/host-config'
import type { PersonalSettingsPatch } from '@solus/contracts/settings'

/**
 * Sync settings on desktop and web (docs/plans/settings-sync-hosts.md): the one
 * owner of the `SettingsSyncHosts` engine and of the switch of each host that the
 * Settings host page shows. Signed in, nothing shows and nothing moves host to host.
 */

export interface SettingsSyncStorePorts {
  isSignedIn(): boolean
  /** The home host: what a new host copies from. */
  homeHostId(): string | null
  /** The person may change this host's config (`host.admin`). */
  mayWriteHostConfig(hostId: string): boolean
}

class SettingsSyncStore {
  /** hostId → the person's switch there, once read. */
  readonly switches = new SvelteMap<string, boolean>()
  /** The switch of a host is being changed. */
  readonly saving = new SvelteMap<string, boolean>()
  /** `copyOnAdd` and `isSignedIn`. A map, not `$state`: stores that tests load uncompiled import this one. */
  private readonly flags = new SvelteMap<'copyOnAdd' | 'isSignedIn', boolean>([['copyOnAdd', true], ['isSignedIn', false]])
  private engine: SettingsSyncHosts | null = null
  private ports: SettingsSyncStorePorts | null = null

  /** The Sync settings checkbox of the add or pair flow on screen. Each flow turns it on when it opens (`startAdd`). */
  get copyOnAdd(): boolean {
    return this.flags.get('copyOnAdd') === true
  }

  set copyOnAdd(value: boolean) {
    this.flags.set('copyOnAdd', value)
  }

  /** Signed in, the checkbox and the switch do not show. */
  get isSignedIn(): boolean {
    return this.flags.get('isSignedIn') === true
  }

  /** Once per client, from `runtime-boot.ts`. Answers the stop. */
  start(ports: SettingsSyncStorePorts): () => void {
    const engine = new SettingsSyncHosts({
      knownHostIds: () => serverConnections.serverIds(),
      readyHost: (hostId) => serverConnections.readinessFor(hostId).readiness === 'ready'
        ? { api: serverConnections.apiFor(hostId), mayWriteHostConfig: () => ports.mayWriteHostConfig(hostId) }
        : null,
      isSignedIn: ports.isSignedIn,
      copySourceId: ports.homeHostId,
      storage: localStorage,
      onSwitchesChange: () => this.readSwitches(),
    })
    this.engine = engine
    this.ports = ports
    const stops = [
      serverConnections.onReadinessChange(() => this.refresh()),
      hostCatalog.onForgotten((host) => engine.forget(host.id)),
      subscribeAllHosts('personalDocument.changed', (serverId, payload) => {
        if (payload.kind === 'settings-sync') engine.hostChanged(serverId)
      }),
    ]
    this.refresh()
    return () => {
      for (const stop of stops) stop()
      this.engine = null
      this.ports = null
    }
  }

  /** A host connected or left, or the person signed in or out. */
  refresh(): void {
    this.flags.set('isSignedIn', this.ports?.isSignedIn() ?? false)
    this.engine?.refresh()
  }

  /** On, or null while this client has not read the host's switch. */
  switchOf(hostId: string): boolean | null {
    return this.switches.get(hostId) ?? null
  }

  async setSwitch(hostId: string, syncSettings: boolean): Promise<void> {
    if (!this.engine || this.saving.get(hostId)) return
    this.saving.set(hostId, true)
    try {
      await this.engine.setSwitch(hostId, syncSettings)
    } finally {
      this.saving.delete(hostId)
    }
  }

  /** An add or pair flow opened: its Sync settings checkbox starts on. */
  startAdd(): void {
    this.copyOnAdd = true
  }

  /** The person added or paired a host here, with the Sync settings checkbox as it is now. */
  hostAdded(hostId: string, fromHostId: string | null = null): void {
    this.engine?.hostAdded(hostId, { syncSettings: this.copyOnAdd, fromHostId })
  }

  personalChanged(fromHostId: string | null, change: PersonalSettingsPatch): void {
    if (fromHostId) this.engine?.personalChanged(fromHostId, change)
  }

  /** A host settings store wrote `patch` to `fromHostId`. */
  hostConfigChanged(fromHostId: string, patch: HostConfigPatch): void {
    this.engine?.hostConfigChanged(fromHostId, patch)
  }

  private readSwitches(): void {
    const engine = this.engine
    if (!engine) return
    for (const hostId of serverConnections.serverIds()) {
      const value = engine.switchOf(hostId)
      if (value === null) this.switches.delete(hostId)
      else if (this.switches.get(hostId) !== value) this.switches.set(hostId, value)
    }
  }
}

export const settingsSyncStore = new SettingsSyncStore()
