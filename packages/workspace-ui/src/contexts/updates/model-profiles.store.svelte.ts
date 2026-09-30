import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { onServerRemoving } from '@solus/client-core/server-registry'
import { replaceModelProfiles, type ModelProfilesStatus } from '@solus/contracts/types'
import type { SolusAPI } from '@solus/contracts/host-api'

type ModelProfilesConnections = Pick<typeof serverConnections, 'statusFor' | 'capabilitiesFor' | 'connectedServerIds' | 'onConnectionCreated' | 'onStatusChange'> & {
  apiFor(serverId: string): Pick<SolusAPI, 'modelProfilesStatus' | 'modelProfilesRefresh'>
}

/**
 * The model list each connected host runs on (`docs/model-profiles.md`). The
 * client puts the newest one in effect in `MODEL_PROFILES`, so the pickers,
 * labels, and effort menus show a model GitHub published after this build.
 */
export class ModelProfilesStore {
  constructor(private readonly connections: ModelProfilesConnections = serverConnections) {}
  readonly statuses = new SvelteMap<string, ModelProfilesStatus>()
  /** A refresh the host could not answer, per host. */
  readonly errors = new SvelteMap<string, string>()
  readonly refreshing = new SvelteSet<string>()
  /**
   * Zero until a host's list is in effect, then bumped each time the list
   * changes. `MODEL_PROFILES` is not reactive: a derivation that reads it also
   * reads this, and runs again when a new list arrives.
   */
  revision = $state(0)
  /** `fetchedAt` of the list in effect; 0 for a host's bundled list. */
  private inEffect: number | null = null
  private started = false

  start(): void {
    if (this.started) return
    this.started = true
    subscribeAllHosts('host.modelProfilesChanged', (serverId, status) => this.apply(serverId, status))
    this.connections.onConnectionCreated((connection) => { if (connection.status === 'connected') void this.load(connection.serverId) })
    this.connections.onStatusChange((serverId, status) => { if (status === 'connected') void this.load(serverId) })
    onServerRemoving((server) => {
      this.statuses.delete(server.id)
      this.errors.delete(server.id)
    })
    for (const serverId of this.connections.connectedServerIds()) void this.load(serverId)
  }

  async load(serverId: string): Promise<void> {
    try {
      if (!(await this.connections.capabilitiesFor(serverId)).modelProfiles) return
      const status = await this.connections.apiFor(serverId).modelProfilesStatus()
      if (this.connections.statusFor(serverId) === 'connected') this.apply(serverId, status)
    } catch {
      // An older host, or a dropped connection: the list in effect stays.
    }
  }

  apply(serverId: string, status: ModelProfilesStatus): void {
    this.statuses.set(serverId, status)
    this.putNewestInEffect()
  }

  statusFor(serverId: string): ModelProfilesStatus | undefined {
    return this.statuses.get(serverId)
  }

  /** Clears the host's cached list and downloads the published one. */
  async refresh(serverId: string): Promise<void> {
    if (this.refreshing.has(serverId)) return
    this.refreshing.add(serverId)
    this.errors.delete(serverId)
    try {
      this.apply(serverId, await this.connections.apiFor(serverId).modelProfilesRefresh())
    } catch (error) {
      this.errors.set(serverId, error instanceof Error ? error.message : String(error))
    } finally {
      this.refreshing.delete(serverId)
    }
  }

  /** Every host downloads the same file, so the most recent download is the best answer. */
  private putNewestInEffect(): void {
    let newest: ModelProfilesStatus | null = null
    for (const status of this.statuses.values()) {
      if (!newest || (status.fetchedAt ?? 0) > (newest.fetchedAt ?? 0)) newest = status
    }
    if (!newest || (newest.fetchedAt ?? 0) === this.inEffect) return
    this.inEffect = newest.fetchedAt ?? 0
    replaceModelProfiles(newest.profiles)
    this.revision += 1
  }
}

export const modelProfilesStore = new ModelProfilesStore()
