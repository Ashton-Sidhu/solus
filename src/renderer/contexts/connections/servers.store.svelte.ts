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
import type { SolusAPI } from '../../../preload'
import { requestInputFocus } from '../../lib/inputFocus'
import { toasts } from '../../lib/toasts'
import {
  compareNearbyHosts,
  filterUnsavedDiscoveredServers,
  mergeNearbyHosts,
  unannouncedDiscoveredServers,
  type NearbyHost,
} from './discovery'
import { hostAffinityGlyph, type HostAffinityGlyph } from './host-affinity'

export type ServerItemStatus = 'online' | 'connecting' | 'offline' | 'saved'

const DISCOVERY_INTERVAL_MS = 30_000
const HOST_PROBE_STALE_MS = 30_000
const RECENT_PROJECTS_STALE_MS = 30_000
interface ServerConnectionState {
  transportStatus: ConnectionStatus
  probeStatus?: Extract<ServerItemStatus, 'online' | 'offline'>
  attempt: number
  hasConnected: boolean
  /** When this host last stopped being connected, for the reconnect counter. */
  offlineSince: number | null
  /** When this host last came back after a drop — null on a first connect. */
  lastReconnectAt: number | null
}

export interface ServerItem {
  id: string
  label: string
  url: string
  installationId?: string
  local: boolean
  status: ServerItemStatus
}

/** A session can outlive the saved-host entry that once named its remote host. */
export interface UnknownRemoteHost {
  id: string
  label: string
  local: false
  unknown: true
}

interface RecentProjectsCacheEntry {
  projects: Awaited<ReturnType<SolusAPI['listRecentProjects']>>
  expiresAt: number
}

class ServersStore {
  local = $state<LocalConnectionInfoLike | null>(null)
  remotes = $state<SavedServer[]>(loadServers())
  activeServerId = $state(connectionState.target?.id ?? getActiveServerId())
  addServerOpen = $state(false)
  addServerUrl = $state('')
  /** Which Run-on picker opened the add-server dialog, so a host paired from
   *  there is handed back to that picker and not to another one. A correlation
   *  breadcrumb between two UI moments — any stable id will do, and a session
   *  draft has one before it has a tab. */
  pendingRunOnRequesterId = $state<string | null>(null)
  justPairedServerId = $state<string | null>(null)
  discoveryBusy = $state(false)
  private connectionStatesByServer = $state<Record<string, ServerConnectionState>>({})
  projectIdentitiesByServer = $state<Record<string, ProjectIdentity[]>>({})
  probingHosts = $state(false)
  readonly nearby = new SvelteMap<string, NearbyHost>()
  readonly toastSnoozedInstallationIds = new SvelteSet<string>()

  private initialized = false
  private discoveryTimer: ReturnType<typeof setInterval> | null = null
  private scanInFlight = false
  private lastHostProbeAt = 0
  private readonly recentProjectsByServer = new Map<string, RecentProjectsCacheEntry>()
  private readonly announcedDiscoveredInstallationIds = new Set<string>()

  get servers(): ServerItem[] {
    const local: ServerItem[] = []
    if (this.local) {
      local.push({
        id: LOCAL_SERVER_ID,
        label: 'This Mac',
        url: `http://127.0.0.1:${this.local.port}`,
        installationId: this.local.installationId,
        local: true,
        status: this.statusFor(LOCAL_SERVER_ID),
      })
    } else if (this.isWebClient && this.hasPrimaryConnection) {
      // A web client has no machine of its own: the host it is connected to
      // plays the local role, so it heads the list as the unmarked case.
      const active = this.remotes.find((server) => server.id === this.activeServerId)
      if (active) {
        local.push({
          id: LOCAL_SERVER_ID,
          label: active.label,
          url: active.url,
          installationId: active.installationId,
          local: true,
          status: this.statusFor(LOCAL_SERVER_ID),
        })
      }
    }
    return [
      ...local,
      ...this.remotes
        .filter((server) => !this.isWebClient || !this.hasPrimaryConnection || server.id !== this.activeServerId)
        .map((server) => ({
          id: server.id,
          label: server.label,
          url: server.url,
          installationId: server.installationId,
          local: false,
          status: this.statusFor(server.id),
        })),
    ]
  }

  /** On web the primary connection plays the local role; see `servers`.
   *  `typeof` guard: unit tests read this store without a `window` at all. */
  private get isWebClient(): boolean {
    return typeof window !== 'undefined' && window.solus?.getPlatform?.() === 'web'
  }

  private get hasPrimaryConnection(): boolean {
    return !!serverConnections.connectionFor()
  }

  /**
   * The two names the web primary answers to, folded onto the one that has
   * state: transport status lives under the real server id, while the host
   * list shows that server as the local row.
   */
  private resolveHostId(serverId: string): string {
    if (this.local || !this.isWebClient || !this.hasPrimaryConnection) return serverId
    if (serverId === LOCAL_SERVER_ID) return this.activeServerId
    return serverId
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

  /** Null while the active host is connected. */
  get offlineSince(): number | null {
    return this.connectionStatesByServer[this.activeServerId]?.offlineSince ?? null
  }

  /** Null until the active host has recovered from at least one drop. */
  get lastReconnectAt(): number | null {
    return this.connectionStatesByServer[this.activeServerId]?.lastReconnectAt ?? null
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

    // The browser client has no native bridge and therefore no "This Mac".
    const nativeApi = (window as { solusNative?: typeof window.solusNative }).solusNative
    if (nativeApi) {
      void nativeApi.getLocalConnection().then((local) => {
        this.local = local
        this.updateAutoDiscovery()
      })
    }

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

  pairForRunOn(requesterId: string): void {
    this.pendingRunOnRequesterId = requesterId
  }

  /** Returns a just-paired host to the picker that initiated pairing, once. */
  consumeJustPaired(requesterId: string): string | null {
    if (!this.justPairedServerId || this.pendingRunOnRequesterId !== requesterId) return null
    const serverId = this.justPairedServerId
    this.justPairedServerId = null
    this.pendingRunOnRequesterId = null
    return serverId
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
      if (this.isWebClient && !this.hasPrimaryConnection) {
        // Without a connected host the stub RPC never resolves. Saved remotes
        // can still answer health checks directly, so retain their reachability.
        await Promise.all(this.remotes.map((server) => this.checkReachable(server.id)))
        return { newServers: 0 }
      }
      // Discovery runs where a network can be scanned: the local app on
      // desktop, and the connected server's own network on web — so a phone
      // still sees the hosts sitting next to the machine it is paired with.
      const discoveryApi = this.local
        ? serverConnections.apiFor(LOCAL_SERVER_ID)
        : window.solus
      const discovered = await discoveryApi.discoverServers()
      const filtered = filterUnsavedDiscoveredServers({
        discovered,
        savedServers: loadServers(),
        selfInstallationId: this.local?.installationId
          ?? this.activeServer?.installationId,
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
    serverId = this.resolveHostId(serverId)
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

  /**
   * Dials the active host again without discarding the window. Reloading was
   * the old retry, and it threw away every mounted pane to recover from what is
   * usually a few seconds of missing network.
   */
  retryActive(): void {
    serverConnections.connectionFor(this.activeServerId)?.transport.reconnectNow()
    requestInputFocus()
  }

  /** Falls back to the local host when a remote one cannot be recovered. */
  useLocalHost(): void {
    this.switchTo(LOCAL_SERVER_ID)
  }

  /**
   * Dials one host and records the verdict. The single probe path, so the host
   * list and the host page can never disagree about whether a host is up.
   */
  async checkReachable(serverId: string): Promise<boolean> {
    serverId = this.resolveHostId(serverId)
    if (this.isWebClient && !this.hasPrimaryConnection && serverId === LOCAL_SERVER_ID) {
      this.connectionStateFor(serverId).probeStatus = 'offline'
      return false
    }
    let health = null
    try {
      health = await serverConnections.probeHealth(serverId, true)
    } catch {}
    this.connectionStateFor(serverId).probeStatus = health ? 'online' : 'offline'
    return !!health
  }

  async probeHosts(): Promise<void> {
    if (this.probingHosts || Date.now() - this.lastHostProbeAt < HOST_PROBE_STALE_MS) return
    this.probingHosts = true
    try {
      await Promise.all(this.servers.map((server) => this.checkReachable(server.id)))
    } finally {
      this.probingHosts = false
      this.lastHostProbeAt = Date.now()
    }
  }

  /** Loads repository identity only from the host that owns the source path. */
  async loadProjectIdentities(serverId: string): Promise<void> {
    if (this.isWebClient && !this.hasPrimaryConnection && serverId === LOCAL_SERVER_ID) {
      this.projectIdentitiesByServer[serverId] = []
      return
    }
    try {
      this.projectIdentitiesByServer[serverId] = await serverConnections.withTemporaryConnection(
        serverId,
        () => serverConnections.projectIdentities(serverId),
      )
    } catch {
      this.projectIdentitiesByServer[serverId] = []
    }
  }

  async recentProjectsFor(serverId: string): Promise<Awaited<ReturnType<SolusAPI['listRecentProjects']>>> {
    const cached = this.recentProjectsByServer.get(serverId)
    if (cached && cached.expiresAt > Date.now()) return cached.projects

    let projects: Awaited<ReturnType<SolusAPI['listRecentProjects']>> = []
    if (this.isWebClient && !this.hasPrimaryConnection && serverId === LOCAL_SERVER_ID) {
      this.recentProjectsByServer.set(serverId, {
        projects,
        expiresAt: Date.now() + RECENT_PROJECTS_STALE_MS,
      })
      return projects
    }
    try {
      projects = await serverConnections.withTemporaryConnection(
        serverId,
        (api) => api.listRecentProjects(),
      )
    } catch {}
    this.recentProjectsByServer.set(serverId, {
      projects,
      expiresAt: Date.now() + RECENT_PROJECTS_STALE_MS,
    })
    return projects
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
    const host = this.hostFor(serverId)
    if (!host || host.local) return null
    return hostAffinityGlyph(host, this.statusFor(host.id))
  }

  hostFor(serverId: string | null | undefined): ServerItem | UnknownRemoteHost | null {
    if (!serverId) return null
    // On web the active server is listed as the local row, so its real id
    // resolves to that row rather than reading as a forgotten host.
    if (!this.local && this.isWebClient && this.hasPrimaryConnection && serverId === this.activeServerId) {
      serverId = LOCAL_SERVER_ID
    }
    const host = this.servers.find((server) => server.id === serverId)
    if (host) return host
    if (serverId === LOCAL_SERVER_ID) return null
    return { id: serverId, label: 'Unknown host', local: false, unknown: true }
  }

  statusFor(serverId: string): ServerItemStatus {
    serverId = this.resolveHostId(serverId)
    const state = this.connectionStatesByServer[serverId]
    if (state?.transportStatus === 'connected') return 'online'
    // A socket retries for as long as a saved host is unavailable. Once the
    // picker has checked that host and found it unreachable, that fresh result
    // is more useful than displaying the transport's perpetual "connecting".
    if (state?.probeStatus === 'offline') return 'offline'
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
    if (status === 'connected') {
      // Only a host that had already been up can have *re*connected. A first
      // connect must not announce a recovery that never happened.
      if (state.hasConnected) state.lastReconnectAt = Date.now()
      state.hasConnected = true
      state.offlineSince = null
      // A host that just answered has plainly not stayed offline, and the stale
      // probe would otherwise keep the picker showing it as unreachable.
      state.probeStatus = 'online'
    } else if (state.offlineSince === null) {
      state.offlineSince = Date.now()
    }
  }

  private connectionStateFor(serverId: string): ServerConnectionState {
    let state = this.connectionStatesByServer[serverId]
    if (!state) {
      state = {
        transportStatus: 'disconnected',
        attempt: 0,
        hasConnected: false,
        offlineSince: null,
        lastReconnectAt: null,
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
    return !document.hidden && document.hasFocus()
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
        // Settings → Connections → Nearby is the surface that can actually act
        // on this, and unlike the switcher chip it exists in every view mode.
        onAction: () => {
          window.dispatchEvent(new CustomEvent('solus:show-connections'))
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
