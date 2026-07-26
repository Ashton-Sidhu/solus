import type { ConnectionStatus } from '@client-core/ws-transport'
import { connectionState, subscribe } from '@client-core/connection-state'
import { serverConnections } from '@client-core/server-connections'
import type { LocalConnectionInfoLike, SolusServerTarget } from '@client-core/server-connection'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import {
  getActiveServerId,
  loadServers,
  LOCAL_SERVER_ID,
  removeServer,
  setActiveServerId,
  touchLastConnected,
  upsertServer,
  type SavedServer,
} from '@client-core/server-registry'
import type { DiscoveredServer, ProjectIdentity } from '../../../shared/types'
import { requestInputFocus } from '../../lib/inputFocus'
import { toasts } from '../app/toast.store.svelte'
import {
  compareNearbyHosts,
  filterUnsavedDiscoveredServers,
  mergeNearbyHosts,
  unannouncedDiscoveredServers,
  type NearbyHost,
} from '../../components/servers/discovery'
import { hostAffinityGlyph, type HostAffinityGlyph } from '../../components/servers/lib/host-affinity'

export type ServerItemStatus = 'online' | 'connecting' | 'offline' | 'saved'

const DISCOVERY_INTERVAL_MS = 30_000
interface ServerConnectionState {
  transportStatus: ConnectionStatus
  probeStatus?: Extract<ServerItemStatus, 'online' | 'offline'>
  attempt: number
  hasConnected: boolean
}

export interface ServerItem {
  id: string
  label: string
  url: string
  installationId?: string
  local: boolean
  status: ServerItemStatus
}

class ServersStore {
  local = $state<LocalConnectionInfoLike | null>(null)
  remotes = $state<SavedServer[]>(loadServers())
  activeServerId = $state(connectionState.target?.id ?? getActiveServerId())
  addServerOpen = $state(false)
  addServerUrl = $state('')
  switcherOpen = $state(false)
  pendingRunOnTabId = $state<string | null>(null)
  justPairedServerId = $state<string | null>(null)
  discoveryBusy = $state(false)
  private connectionStatesByServer = $state<Record<string, ServerConnectionState>>({})
  projectIdentitiesByServer = $state<Record<string, ProjectIdentity[]>>({})
  probingServers = $state(false)
  readonly nearby = new SvelteMap<string, NearbyHost>()
  readonly toastSnoozedInstallationIds = new SvelteSet<string>()

  private initialized = false
  private discoveryTimer: ReturnType<typeof setInterval> | null = null
  private scanInFlight = false
  private readonly announcedDiscoveredInstallationIds = new Set<string>()

  get servers(): ServerItem[] {
    const local = this.local
      ? [{
          id: LOCAL_SERVER_ID,
          label: 'This Mac',
          url: `http://127.0.0.1:${this.local.port}`,
          installationId: this.local.installationId,
          local: true,
          status: this.statusFor(LOCAL_SERVER_ID),
        } satisfies ServerItem]
      : []
    return [
      ...local,
      ...this.remotes.map((server) => ({
        id: server.id,
        label: server.label,
        url: server.url,
        installationId: server.installationId,
        local: false,
        status: this.statusFor(server.id),
      })),
    ]
  }

  get activeServer(): ServerItem | null {
    return this.servers.find((server) => server.id === this.activeServerId) ?? this.servers[0] ?? null
  }

  get activeTarget(): SolusServerTarget | null {
    return connectionState.target ?? null
  }

  get connectionStatus(): ConnectionStatus {
    return this.connectionStatesByServer[this.activeServerId]?.transportStatus ?? connectionState.status
  }

  get reconnectAttempt(): number {
    return this.connectionStatesByServer[this.activeServerId]?.attempt ?? connectionState.attempt
  }

  get hasConnected(): boolean {
    return this.connectionStatesByServer[this.activeServerId]?.hasConnected
      ?? connectionState.status === 'connected'
  }

  get nearbyHosts(): NearbyHost[] {
    const registeredInstallationIds = new Set(
      this.servers.flatMap((server) => server.installationId ? [server.installationId] : []),
    )
    return [...this.nearby.values()]
      .filter((host) => !registeredInstallationIds.has(host.server.installationId))
      .sort(compareNearbyHosts)
  }

  init(): void {
    if (this.initialized) return
    this.initialized = true

    const updateAutoDiscovery = () => this.updateAutoDiscovery()
    window.addEventListener('focus', updateAutoDiscovery)
    window.addEventListener('blur', updateAutoDiscovery)
    document.addEventListener('visibilitychange', updateAutoDiscovery)
    updateAutoDiscovery()

    void window.solusNative.getLocalConnection().then((local) => {
      this.local = local
      this.updateAutoDiscovery()
    })

    subscribe(({ status, attempt, target }) => {
      if (target) {
        this.activeServerId = target.id
        this.setConnectionStatus(target.id, status, attempt)
      }
      this.updateAutoDiscovery()
    })

    serverConnections.onStatusChange((serverId, status, attempt) => {
      this.setConnectionStatus(serverId, status, attempt)
    })

  }

  refreshServers(): void {
    this.remotes = loadServers()
  }

  savePairedServer(server: SavedServer): void {
    upsertServer(server)
    this.refreshServers()
    if (server.installationId) this.nearby.delete(server.installationId)
    this.justPairedServerId = server.id
  }

  openAddServer(prefillUrl = ''): void {
    this.addServerUrl = prefillUrl
    this.addServerOpen = true
  }

  closeAddServer(): void {
    this.addServerOpen = false
    this.addServerUrl = ''
    requestInputFocus()
  }

  async scanForServers(): Promise<{ newServers: number } | { error: string } | null> {
    if (this.scanInFlight) return null
    this.scanInFlight = true
    this.discoveryBusy = true
    try {
      const discovered = await serverConnections.apiFor(LOCAL_SERVER_ID).discoverServers()
      const filtered = filterUnsavedDiscoveredServers({
        discovered,
        savedServers: loadServers(),
        selfInstallationId: this.local?.installationId,
      })
      const merged = mergeNearbyHosts(this.nearby, filtered, Date.now())
      const mergedInstallationIds = new Set<string>()
      for (const nearbyHost of merged) {
        const installationId = nearbyHost.server.installationId
        mergedInstallationIds.add(installationId)
        this.nearby.set(installationId, nearbyHost)
      }
      for (const installationId of this.nearby.keys()) {
        if (!mergedInstallationIds.has(installationId)) this.nearby.delete(installationId)
      }
      this.showDiscoveryToast(filtered)
      return { newServers: merged.length }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.discoveryBusy = false
      this.scanInFlight = false
    }
  }

  switchTo(serverId: string): void {
    if (serverId === this.activeServerId) {
      requestInputFocus()
      return
    }
    setActiveServerId(serverId)
    if (serverId !== LOCAL_SERVER_ID) touchLastConnected(serverId)
    requestInputFocus()
    location.reload()
  }

  remove(serverId: string): void {
    if (serverId === LOCAL_SERVER_ID) return
    if (serverId === this.activeServerId) {
      const serverLabel = this.remotes.find((server) => server.id === serverId)?.label ?? 'this host'
      toasts.error(`Switch to another host before forgetting ${serverLabel}`)
      requestInputFocus()
      return
    }
    const forgottenInstallationId = this.remotes.find((server) => server.id === serverId)?.installationId
    removeServer(serverId)
    this.refreshServers()
    requestInputFocus()
    // A forgotten host becomes discoverable again — rescan so it drops straight
    // back into Nearby instead of vanishing until the next sweep. Suppress its
    // toast: the user just dismissed this host, they don't need it announced.
    if (forgottenInstallationId) this.announcedDiscoveredInstallationIds.add(forgottenInstallationId)
    void this.scanForServers()
  }

  retryActive(): void {
    location.reload()
  }

  async probeRunOnServers(): Promise<void> {
    if (this.probingServers) return
    this.probingServers = true
    try {
      await Promise.all(this.servers.map(async (server) => {
        let health = null
        try {
          health = await serverConnections.probeHealth(server.id)
        } catch {}
        const state = this.connectionStateFor(server.id)
        state.probeStatus = health ? 'online' : 'offline'
        if (!health) return
        const hadConnection = serverConnections.connectionFor(server.id) !== undefined
        try {
          this.projectIdentitiesByServer[server.id] = await serverConnections.projectIdentities(server.id)
        } catch {
          this.projectIdentitiesByServer[server.id] = []
        } finally {
          if (!hadConnection) serverConnections.release(server.id)
        }
      }))
    } finally {
      this.probingServers = false
    }
  }

  projectIdentitiesFor(serverId: string): ProjectIdentity[] {
    return this.projectIdentitiesByServer[serverId] ?? []
  }

  /** An empty list means "no repos here" only once the host has actually been asked. */
  hasProbedIdentities(serverId: string): boolean {
    return this.projectIdentitiesByServer[serverId] !== undefined
  }

  /**
   * The host badge for a surface that holds a session's `serverId` rather than a
   * resolved host. A saved host that has since been forgotten still earns one:
   * the session on it is no more local for having lost its name.
   */
  affinityFor(serverId: string | null | undefined): HostAffinityGlyph | null {
    if (!serverId || serverId === LOCAL_SERVER_ID) return null
    const host = this.servers.find((server) => server.id === serverId)
    return hostAffinityGlyph({ label: host?.label ?? 'Unknown host', local: false }, this.statusFor(serverId))
  }

  statusFor(serverId: string): ServerItemStatus {
    const state = this.connectionStatesByServer[serverId]
    if (state?.transportStatus && state.transportStatus !== 'disconnected') {
      return this.itemStatus(state.transportStatus)
    }
    if (state?.probeStatus) return state.probeStatus
    if (serverId !== this.activeServerId) return 'saved'
    return this.itemStatus(this.connectionStatus)
  }

  setConnectionStatus(serverId: string, status: ConnectionStatus, attempt = 0): void {
    const state = this.connectionStateFor(serverId)
    state.transportStatus = status
    state.attempt = attempt
    if (status === 'connected') state.hasConnected = true
  }

  private connectionStateFor(serverId: string): ServerConnectionState {
    let state = this.connectionStatesByServer[serverId]
    if (!state) {
      state = {
        transportStatus: 'disconnected',
        attempt: 0,
        hasConnected: false,
      }
      this.connectionStatesByServer[serverId] = state
    }
    return state
  }

  private itemStatus(status: ConnectionStatus): ServerItemStatus {
    if (status === 'connected') return 'online'
    if (status === 'connecting' || status === 'reconnecting') return 'connecting'
    return 'offline'
  }

  private updateAutoDiscovery(): void {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer)
      this.discoveryTimer = null
    }
    if (!this.shouldAutoDiscover()) return
    void this.scanForServers()
    this.discoveryTimer = setInterval(() => {
      if (!this.shouldAutoDiscover()) {
        this.updateAutoDiscovery()
        return
      }
      void this.scanForServers()
    }, DISCOVERY_INTERVAL_MS)
  }

  private shouldAutoDiscover(): boolean {
    if (document.hidden || !document.hasFocus()) return false
    return window.solus.getPlatform?.() !== 'web'
  }

  private showDiscoveryToast(servers: DiscoveredServer[]): void {
    const unsnoozed = servers.filter(
      (server) => !this.toastSnoozedInstallationIds.has(server.installationId),
    )
    const unannounced = unannouncedDiscoveredServers(
      unsnoozed,
      this.announcedDiscoveredInstallationIds,
    )
    if (unannounced.length === 0) return
    for (const server of unannounced) {
      this.announcedDiscoveredInstallationIds.add(server.installationId)
    }
    const installationIds = unannounced.map((server) => server.installationId)
    const message = unannounced.length === 1
      ? `Solus host found: ${unannounced[0].name}`
      : `${unannounced.length} Solus hosts found nearby`
    toasts.info(message, {
      duration: 12_000,
      action: {
        label: 'Show',
        onAction: () => {
          this.switcherOpen = true
        },
      },
      onDismiss: () => {
        for (const installationId of installationIds) {
          this.toastSnoozedInstallationIds.add(installationId)
        }
      },
    })
  }
}

export const serversStore = new ServersStore()
