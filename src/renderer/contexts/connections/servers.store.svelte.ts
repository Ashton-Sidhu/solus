import type { ConnectionStatus } from '@client-core/ws-transport'
import type { HostPhase } from '@client-core/host-supervisor'
import {
  dismissSkew,
  forgetSkewDismissals,
  isSkewDismissed,
  skewDismissalKey,
  versionSkewNotice,
  type VersionSkewNotice,
} from '@client-core/version-skew'
import { sendOutbox } from '@client-core/send-outbox'
import { connectionState, subscribe } from '@client-core/connection-state'
import { localApi } from '@client-core/local-api'
import { serverConnections } from '@client-core/server-connections'
import type { LocalConnectionInfoLike, SolusServerTarget } from '@client-core/server-connection'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import {
  getActiveServerId,
  loadServers,
  LOCAL_SERVER_ID,
  onServerRemoving,
  removeServer,
  setActiveServerId,
  touchLastConnected,
  upsertServer,
  type SavedServer,
} from '@client-core/server-registry'
import type { DiscoveredServer, HostOperatingSystem, ProjectIdentity } from '../../../shared/types'
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

export type ServerItemStatus = 'online' | 'connecting' | 'offline' | 'saved' | 'different-server'

const DISCOVERY_INTERVAL_MS = 30_000
const HOST_PROBE_STALE_MS = 30_000
const RECENT_PROJECTS_STALE_MS = 30_000
interface ServerConnectionState {
  transportStatus: ConnectionStatus
  /** The supervisor's word on this host, when one supervises it. */
  phase?: HostPhase
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
  os?: HostOperatingSystem
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
  /** What the local server calls itself — its hostname, from /health. Null
   *  until the probe answers; the row falls back to a generic label. The row
   *  deliberately carries no `os`: OS logos mark machines you are not sitting
   *  at, and the local row keeps the plain device glyph everywhere. */
  private localIdentity = $state<{ name: string } | null>(null)
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
    // Hosts are symmetric rows (dispatch-client step 5): the desktop's own
    // machine is the one genuinely local row; a web client has no machine of
    // its own, so every host — including the one it booted against — appears
    // under its real id. Platform-managed entries (the serving origin) join
    // from the live connection registry, since they are never persisted.
    const rows: ServerItem[] = []
    if (this.local) {
      rows.push({
        id: LOCAL_SERVER_ID,
        label: this.localIdentity?.name ?? 'This computer',
        url: `http://127.0.0.1:${this.local.port}`,
        installationId: this.local.installationId,
        local: true,
        status: this.statusFor(LOCAL_SERVER_ID),
      })
    }
    for (const server of this.remotes) {
      rows.push({
        id: server.id,
        label: server.label,
        url: server.url,
        installationId: server.installationId,
        os: server.os,
        local: false,
        status: this.statusFor(server.id),
      })
    }
    for (const serverId of serverConnections.connectedServerIds()) {
      if (serverId === LOCAL_SERVER_ID || rows.some((row) => row.id === serverId)) continue
      const target = serverConnections.connectionFor(serverId)?.target
      if (!target || target.local) continue
      rows.push({
        id: serverId,
        label: target.label,
        url: target.url,
        installationId: target.installationId,
        local: false,
        status: this.statusFor(serverId),
      })
    }
    return rows
  }

  /**
   * Remotes reachable right now, not merely saved. A host answers a health
   * probe or holds a live transport before it counts, so the run-on picker
   * only offers machines a session could actually start on.
   */
  get connectedRemotes(): ServerItem[] {
    return this.servers.filter((server) => !server.local && server.status === 'online')
  }

  /** On web the primary connection plays the local role; see `servers`.
   *  `typeof` guard: unit tests read this store without a `window` at all. */
  private get isWebClient(): boolean {
    return localApi.getPlatform?.() === 'web'
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
    const nativeApi = window.solusNative
    if (nativeApi) {
      void nativeApi.getLocalConnection().then((local) => {
        this.local = local
        this.updateAutoDiscovery()
        // The row should carry the machine's real name, not a placeholder —
        // /health is the one source that knows it.
        void serverConnections.probeHealth(LOCAL_SERVER_ID).then((health) => {
          if (health) this.localIdentity = { name: health.name }
        })
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

    // The supervisor's phase outranks the transport status: it is the one
    // owner of the retry ladder, and `offline` is a phase it can actually
    // reach — the transport only ever said "reconnecting" forever.
    serverConnections.onPhaseChange((serverId, phase) => {
      this.connectionStateFor(serverId).phase = phase
    })

    // Forgetting a host is total: its skew dismissals and queued sends leave
    // with it (the session snapshot cache purges itself the same way).
    onServerRemoving((server) => {
      forgetSkewDismissals(server.id)
      sendOutbox.forgetHost(server.id)
    })
  }

  /** The per-host version-skew notice, or null when versions match, the host
   *  has no session record yet, or this exact pairing was dismissed. */
  versionSkewNoticeFor(serverId: string): VersionSkewNotice | null {
    const capabilities = serverConnections.cachedCapabilitiesFor(serverId)
    const host = this.hostFor(serverId)
    const notice = versionSkewNotice(host?.label ?? serverId, capabilities?.version, capabilities)
    if (!notice) return null
    const dismissalKey = skewDismissalKey(serverId, notice.clientVersion, notice.serverVersion)
    return isSkewDismissed(dismissalKey) ? null : notice
  }

  dismissVersionSkewNotice(serverId: string): void {
    const notice = this.versionSkewNoticeFor(serverId)
    if (notice) dismissSkew(skewDismissalKey(serverId, notice.clientVersion, notice.serverVersion))
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
      if (this.isWebClient && !serverConnections.defaultServerId()) {
        // Without a connected host the stub RPC never resolves. Saved remotes
        // can still answer health checks directly, so retain their reachability.
        await Promise.all(this.remotes.map((server) => this.checkReachable(server.id)))
        return { newServers: 0 }
      }
      // Discovery runs where a network can be scanned: the local app on
      // desktop, and the connected default host's own network on web — so a
      // phone still sees the hosts sitting next to the machine it is paired with.
      const discoveryServerId = this.local ? LOCAL_SERVER_ID : serverConnections.defaultServerId()
      if (!discoveryServerId) return { newServers: 0 }
      const discovered = await serverConnections.apiFor(discoveryServerId).discoverServers()
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
    // In-place (dispatch-client step 5): hosts are symmetric and already hold
    // supervised sockets, so "switching" is only the client remembering a
    // different default for new work. Reloading threw away every mounted pane
    // to change a preference.
    serverConnections.setPrimary(serverId)
    setActiveServerId(serverId)
    this.activeServerId = serverConnections.resolveId(serverId)
    if (serverId !== LOCAL_SERVER_ID) touchLastConnected(serverId)
    this.refreshServers()
    requestInputFocus()
  }

  remove(serverId: string): void {
    if (serverId === LOCAL_SERVER_ID) return
    if (serverId === this.activeServerId) {
      // The active host is only the new-work default now: step aside to
      // another catalog host in place, then forget as usual. Only the last
      // host has nowhere to step to.
      const fallbackId = this.local
        ? LOCAL_SERVER_ID
        : this.remotes.find((server) => server.id !== serverId)?.id
      if (!fallbackId) {
        const serverLabel = this.remotes.find((server) => server.id === serverId)?.label ?? 'this host'
        toasts.error(`Pair another host before forgetting ${serverLabel}`)
        requestInputFocus()
        return
      }
      this.switchTo(fallbackId)
    }
    const forgottenInstallationId = this.remotes.find((server) => server.id === serverId)?.installationId
    removeServer(serverId)
    // No longer a catalog entry, so the eager supervisor leaves with it.
    serverConnections.release(serverId)
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
    // The supervisor owns the ladder: a user retry resets it and dials now.
    serverConnections.dialNow(this.activeServerId)
    requestInputFocus()
  }

  /** Falls back to the local host when a remote one cannot be recovered. */
  useLocalHost(): void {
    // Only a client with a machine of its own has a local host to fall back
    // to; the web recovery surfaces offer re-pairing instead.
    if (!serverConnections.localServerId()) return
    this.switchTo(LOCAL_SERVER_ID)
  }

  /**
   * Dials one host and records the verdict. The single probe path, so the host
   * list and the host page can never disagree about whether a host is up.
   */
  async checkReachable(serverId: string): Promise<boolean> {
    if (!serverConnections.localServerId() && serverId === LOCAL_SERVER_ID) {
      this.connectionStateFor(serverId).probeStatus = 'offline'
      return false
    }
    let health = null
    try {
      health = await serverConnections.probeHealth(serverId, true)
    } catch {}
    if (health?.os) {
      const remote = this.remotes.find((server) => server.id === serverId)
      if (remote) remote.os = health.os
    }
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
    if (!serverConnections.localServerId() && serverId === LOCAL_SERVER_ID) {
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
    if (!serverConnections.localServerId() && serverId === LOCAL_SERVER_ID) {
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
    const host = this.servers.find((server) => server.id === serverId)
    if (host) return host
    if (serverId === LOCAL_SERVER_ID) return null
    return { id: serverId, label: 'Unknown host', local: false, unknown: true }
  }

  statusFor(serverId: string): ServerItemStatus {
        const state = this.connectionStatesByServer[serverId]
    // The supervisor's phase is authoritative for a supervised host: `offline`
    // is a real phase now, so the perpetual-"connecting" reading is gone.
    switch (state?.phase) {
      case 'connected': return 'online'
      case 'offline': return 'offline'
      case 'connecting':
      case 'reconnecting': return 'connecting'
      case 'blocked':
        return state.transportStatus === 'identity-mismatch' ? 'different-server' : 'offline'
    }
    if (state?.transportStatus === 'connected') return 'online'
    if (state?.transportStatus === 'identity-mismatch') return 'different-server'
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
    if (status === 'identity-mismatch') return 'different-server'
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
    const title = unannounced.length === 1
      ? 'Solus host found'
      : `${unannounced.length} Solus hosts found nearby`
    toasts.info(title, {
      description: unannounced.length === 1 ? unannounced[0].name : undefined,
      duration: 5_000,
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
