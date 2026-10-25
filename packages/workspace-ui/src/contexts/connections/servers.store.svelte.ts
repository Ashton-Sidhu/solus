import { hostReadinessCopy, type HostReadiness, type HostReadinessState } from '@solus/client-core/host-readiness'
import type { HostDiagnostics } from '@solus/client-core/host-diagnostics'
import {
  dismissSkew,
  forgetSkewDismissals,
  isSkewDismissed,
  skewDismissalKey,
  versionSkewNotice,
  type VersionSkewNotice,
} from '@solus/client-core/version-skew'
import { sendOutbox } from '@solus/client-core/send-outbox'
import { sameNameHostAddresses } from '@solus/client-core/host-address'
import { localApi } from '@solus/client-core/local-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { preferredRouteUrl, type LocalConnectionInfoLike, type SolusServerTarget } from '@solus/client-core/server-connection'
import { onWakeSignal } from '@solus/client-core/wake-signals'
import { uplinkAccountSource } from '@solus/client-core/uplink-account'
import { mergeDirectoryIntoSaved, withDiscoveredRoutes } from '@solus/client-core/uplink-session'
import { loadWorkspaces, saveDirectoryWorkspaces, workspaceTarget, type SavedWorkspace } from '@solus/client-core/workspace-registry'
import { windowOrganizationSelection } from '@solus/client-core/organization-selection'
import { organizationSelection } from './organization-selection.store.svelte'
import { SvelteMap } from 'svelte/reactivity'
import {
  getActiveServerId,
  loadServers,
  LOCAL_SERVER_ID,
  managedHostNeedsStart,
  markDirectoryAnswered,
  onServerRemoving,
  removeServer,
  saveServers,
  setActiveServerId,
  touchLastConnected,
  upsertServer,
  type SavedServer,
  type SavedServerUplink,
} from '@solus/client-core/server-registry'
import type { HostOperatingSystem, ProjectIdentity } from '@solus/contracts/types'
import { isSolusApiId, solusApiId, type OrganizationPolicy } from '@solus/contracts/uplink'
import { routeForUrl, type HostRoute } from '@solus/contracts/host-routes'
import { requestInputFocus } from '../../lib/inputFocus'
import { toasts } from '../../lib/toasts'
import { accountStore } from '../account/account.store.svelte'
import {
  compareNearbyHosts,
  filterUnsavedDiscoveredServers,
  mergeNearbyHosts,
  type NearbyHost,
} from './discovery'
import { hosts } from '../hosts/hosts.svelte'
import { hostRowLabel, SOLUS_CLOUD_LABEL } from './host-label'
import { hostAffinityGlyph, type HostAffinityGlyph } from './host-affinity'
import { DIRECTORY_FOCUS_GAP_MS, directoryRefreshDelayMs } from './directory-refresh'
import { askBeforeDiscardingUnsent } from '../works/work-live-discard'

const DISCOVERY_INTERVAL_MS = 30_000

export interface ServerItem {
  id: string
  label: string
  url: string
  installationId?: string
  os?: HostOperatingSystem
  local: boolean
  /** Whether this client can do work on the host now (docs/plans/host-readiness.md). */
  readiness: HostReadiness
  /** Every way this client knows to reach the host (direct-first dialing, C3). */
  routes: HostRoute[]
  /** Set when the owner's cloud directory lists the host. */
  uplink?: SavedServerUplink
}

/** A session can outlive the saved-host entry that once named its remote host. */
export interface UnknownRemoteHost {
  id: string
  label: string
  local: false
  unknown: true
}

/** One organization the account belongs to, as the switcher lists it (organization-scope §2). */
export interface OrganizationChoice {
  organizationId: string
  name: string
  policy: OrganizationPolicy
  /** The organization this window works in. */
  isActive: boolean
}

type OrganizationListener = (organizationId: string | null) => void

class ServersStore {
  local = $state<LocalConnectionInfoLike | null>(null)
  /** What the local server calls itself — its hostname, from /health. Null
   *  until the probe answers; the row falls back to a generic label. The row
   *  deliberately carries no `os`: OS logos mark machines you are not sitting
   *  at, and the local row keeps the plain device glyph everywhere. */
  private localIdentity = $state<{ name: string; os?: HostOperatingSystem } | null>(null)
  remotes = $state<SavedServer[]>(loadServers())
  /** The organizations' workspace services, as the account directory last listed them. */
  workspaces = $state<SavedWorkspace[]>(loadWorkspaces())
  private readonly organizationListeners = new Set<OrganizationListener>()
  activeServerId = $state(serverConnections.defaultServerId() ?? getActiveServerId())
  addServerOpen = $state(false)
  addServerUrl = $state('')
  /** Which Run-on picker opened the add-server dialog, so a host paired from
   *  there is handed back to that picker and not to another one. A correlation
   *  breadcrumb between two UI moments — any stable id will do, and a session
   *  draft has one before it has a tab. */
  pendingRunOnRequesterId = $state<string | null>(null)
  justPairedServerId = $state<string | null>(null)
  discoveryBusy = $state(false)
  /** What the account's host directory last said about being signed in: null until asked. */
  directorySignedIn = $state<boolean | null>(null)
  private directoryRefreshInFlight = false
  private directoryRefreshTimer: ReturnType<typeof setTimeout> | null = null
  private lastDirectoryReadAt = 0
  /** Bumps on every readiness change: `readinessFor` reads the connections through it. */
  private readinessVersion = $state(0)
  /** What `/health` reported, for a host with no saved entry to carry it. */
  private osByServer = $state<Record<string, HostOperatingSystem>>({})
  projectIdentitiesByServer = $state<Record<string, ProjectIdentity[]>>({})
  readonly nearby = new SvelteMap<string, NearbyHost>()

  private initialized = false
  private connectionsTracked = false
  private discoveryTimer: ReturnType<typeof setInterval> | null = null
  private scanInFlight = false
  private lastDiscoveryScanAt = 0

  /** The workspace service connections this account holds, one per organization. */
  get cloudConnections(): ServerItem[] {
    return this.workspaces.map((workspace) => {
      const target = workspaceTarget(workspace)
      return {
        id: target.id,
        label: target.label,
        url: target.url,
        local: false,
        readiness: this.readinessFor(target.id).readiness,
        routes: target.routes ?? [],
      }
    })
  }

  /**
   * The machines: every host a person can see, pick, or open. The
   * organization's workspace service is not one of them — it is the cloud
   * service the records live in (docs/plans/cloud-service-model.md §15), reached
   * through `cloudConnections` and never listed beside a machine.
   */
  get servers(): ServerItem[] {
    // Hosts are symmetric rows (dispatch-client step 5): the desktop's own
    // machine is the one genuinely local row; a web client has no machine of
    // its own, so every host — including the one it booted against — appears
    // under its real id. Platform-managed entries (the serving origin) join
    // from the live connection registry, since they are never persisted.
    const rows: ServerItem[] = []
    if (this.local) {
      const url = `http://127.0.0.1:${this.local.port}`
      rows.push({
        id: LOCAL_SERVER_ID,
        label: this.localIdentity?.name ?? 'This computer',
        url,
        installationId: this.local.installationId,
        os: this.localIdentity?.os,
        local: true,
        readiness: this.readinessFor(LOCAL_SERVER_ID).readiness,
        routes: [{ kind: 'lan', url }],
      })
    }
    for (const server of this.remotes) {
      if (server.installationId === this.local?.installationId) continue
      const row: ServerItem = {
        id: server.id,
        label: hostRowLabel(server, hosts.get(server.id)?.capabilityRecord?.name),
        // A directory host saves no address of its own; its row shows the route it is dialed on.
        url: preferredRouteUrl(server),
        installationId: server.installationId,
        os: server.os,
        local: false,
        readiness: this.readinessFor(server.id).readiness,
        routes: server.routes,
      }
      if (server.uplink) row.uplink = server.uplink
      rows.push(row)
    }
    for (const serverId of serverConnections.connectedServerIds()) {
      if (serverId === LOCAL_SERVER_ID || isSolusApiId(serverId) || rows.some((row) => row.id === serverId)) continue
      const target = serverConnections.connectionFor(serverId)?.target
      if (!target || target.local) continue
      rows.push({
        id: serverId,
        label: hostRowLabel(target, hosts.get(serverId)?.capabilityRecord?.name),
        url: target.url,
        installationId: target.installationId,
        os: this.osByServer[serverId],
        local: false,
        readiness: this.readinessFor(serverId).readiness,
        routes: target.routes ?? [routeForUrl(target.url)],
      })
    }
    return rows
  }

  /**
   * The hosts work can start on: every row that serves the execution plane
   * (docs/plans/cloud-service-model.md). The organization's workspace service is
   * a host with no checkout and no agent process, so the Run-on picker, the
   * project dialog, and every dispatch target read this list, never `servers`.
   */
  get executionServers(): ServerItem[] {
    return this.servers.filter((server) => hosts.hasExecution(server.id))
  }

  /** Remotes ready now, not merely saved: the run-on picker only offers machines a session could start on. */
  get connectedRemotes(): ServerItem[] {
    return this.executionServers.filter((server) => !server.local && server.readiness === 'ready')
  }

  /**
   * The organization this window works in (organization-scope §2): a filter on
   * what the window shows beside Local, kept per window
   * (`organization-selection.ts`). Null when the account holds no organization.
   */
  get activeOrganizationId(): string | null {
    return organizationSelection.activeOrganizationId
  }

  /** The workspace service of the organization this window works in —
   *  where that organization's projects and cloud tasks live — or null when
   *  the account holds none (docs/plans/project-model.md §2). */
  get activeCloudServerId(): string | null {
    const organizationId = this.activeOrganizationId
    return organizationId && this.workspaces.some((workspace) => workspace.organizationId === organizationId)
      ? solusApiId(organizationId)
      : null
  }

  /** The organizations the account belongs to, with each one's policy, the window's marked. */
  get organizations(): OrganizationChoice[] {
    return this.workspaces.map((workspace) => ({
      organizationId: workspace.organizationId,
      name: workspace.label,
      policy: workspace.policy,
      isActive: workspace.organizationId === this.activeOrganizationId,
    }))
  }

  /** The name of the organization this window works in; null with none. */
  get activeOrganizationName(): string | null {
    return this.workspaces.find((workspace) => workspace.organizationId === this.activeOrganizationId)?.label ?? null
  }

  /**
   * Selects the organization this window works in (organization-scope §2, §7).
   * A filter, not a move: no record, running session, or other window changes.
   * The previous organization's workspace service is released and the new one
   * dialed; stores that cache by that connection follow through
   * `onOrganizationChange`. Typing is the natural next step, so the input bar
   * takes focus back.
   */
  selectOrganization(organizationId: string): void {
    if (!this.workspaces.some((workspace) => workspace.organizationId === organizationId)) return
    const previousServiceId = this.activeCloudServerId
    if (!windowOrganizationSelection.set(organizationId)) return
    serverConnections.switchSolusApi(previousServiceId, solusApiId(organizationId))
    for (const listener of this.organizationListeners) listener(organizationId)
    requestInputFocus()
  }

  /** Called after the window's organization changed, with the new one. */
  onOrganizationChange(listener: OrganizationListener): () => void {
    this.organizationListeners.add(listener)
    return () => this.organizationListeners.delete(listener)
  }

  /** "Solus Cloud" for a record whose home is the workspace service; null for a machine's. */
  cloudHomeLabel(serverId: string | null | undefined): string | null {
    return isSolusApiId(serverId) ? SOLUS_CLOUD_LABEL : null
  }

  /** On web the primary connection plays the local role; see `servers`.
   *  `typeof` guard: unit tests read this store without a `window` at all. */
  private get isWebClient(): boolean {
    return localApi.getPlatform?.() === 'web'
  }

  /**
   * The host whose state is the whole window's: the one that serves a web
   * client, shown by the connection overlay. Null on desktop, whose own host
   * runs beside the window (docs/plans/host-readiness.md).
   */
  get windowHostId(): string | null {
    return this.isWebClient ? this.activeServerId : null
  }

  get activeServer(): ServerItem | null {
    return this.servers.find((server) => server.id === this.activeServerId) ?? this.servers[0] ?? null
  }

  get activeTarget(): SolusServerTarget | null {
    return serverConnections.connectionFor(this.activeServerId)?.target ?? null
  }

  get nearbyHosts(): NearbyHost[] {
    const registeredInstallationIds = new Set(
      this.servers.flatMap((server) => server.installationId ? [server.installationId] : []),
    )
    return [...this.nearby.values()]
      .filter((host) => !registeredInstallationIds.has(host.server.installationId))
      .sort(compareNearbyHosts)
  }

  /**
   * Follows every host's readiness, which `readinessFor` reads. Part of
   * `init()`; the guest shell (docs/plans/multiplayer-sharing.md §4.2) calls it
   * alone, because it has one host and no catalog, discovery, or directory.
   */
  trackConnections(onActiveChange?: () => void): void {
    if (this.connectionsTracked) return
    this.connectionsTracked = true

    // The window's active host is the new-work default: boot names it, and a Run on switch moves it.
    const followPrimary = () => {
      const primaryId = serverConnections.defaultServerId()
      if (primaryId) this.activeServerId = primaryId
      onActiveChange?.()
    }
    serverConnections.onPrimaryChange(followPrimary)
    followPrimary()

    serverConnections.onReadinessChange((serverId, readiness) => {
      this.readinessVersion += 1
      if (readiness === 'ready') void this.readOperatingSystem(serverId)
      if (serverId === this.activeServerId) onActiveChange?.()
    })
    serverConnections.onConnectionCreated(() => { this.readinessVersion += 1 })
    // A failed dial moves the attempts and the last error a host's diagnostics show.
    serverConnections.onDialOutcome(() => { this.readinessVersion += 1 })
  }

  /** A host this client has no saved entry for learns its OS from `/health` once it is ready. */
  private async readOperatingSystem(serverId: string): Promise<void> {
    if (serverId === LOCAL_SERVER_ID || this.osByServer[serverId] || this.remotes.some((server) => server.id === serverId)) return
    const health = await serverConnections.probeHealth(serverId).catch(() => null)
    if (health?.os) this.osByServer[serverId] = health.os
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
          if (health) this.localIdentity = { name: health.name, os: health.os }
        })
      })
    }

    this.trackConnections(updateAutoDiscovery)

    // Forgetting a host is total: its skew dismissals and queued sends leave
    // with it (the session snapshot cache purges itself the same way).
    onServerRemoving((server) => {
      forgetSkewDismissals(server.id)
      sendOutbox.forgetHost(server.id)
    })

    // The account's host directory is the fourth source of hosts (C1). It is
    // read on boot, on sign-in changes, on wake, when Connections opens, when the
    // window gets focus, and on a timer while the window is active; nothing
    // pushes it. The account store mirrors main's sign-in state
    // and has no other subscriber until a sign-in surface lands, so it starts here.
    accountStore.start()
    void this.refreshDirectory()
    onWakeSignal(() => void this.refreshDirectory())
    localApi.onAccountStateChange?.((state) => {
      // A host refused while the account held no sign-in waits for the next one.
      if (state.kind === 'signed-in') serverConnections.dialHostsBlockedOnSignIn()
      void this.refreshDirectory()
    })
    // A host added on the account site in a browser is found when the person
    // comes back to this window, which on desktop is a focus and not a wake.
    window.addEventListener('focus', () => {
      if (Date.now() - this.lastDirectoryReadAt >= DIRECTORY_FOCUS_GAP_MS) void this.refreshDirectory()
    })
  }

  /** The next timed read, sooner while a managed host settles. An inactive
   *  window skips its read and waits for the next tick or a focus. */
  private scheduleDirectoryRefresh(): void {
    if (!this.initialized) return
    if (this.directoryRefreshTimer) clearTimeout(this.directoryRefreshTimer)
    this.directoryRefreshTimer = setTimeout(() => {
      this.directoryRefreshTimer = null
      if (!document.hidden && document.hasFocus()) void this.refreshDirectory()
      else this.scheduleDirectoryRefresh()
    }, directoryRefreshDelayMs(this.remotes))
  }

  /**
   * Folds the signed-in account's directory into the saved hosts: a paired host that
   * is also listed gains its tunnel route, a host only listed is saved with the tunnel
   * alone, and a host the directory dropped loses the tunnel (and the row, if it was
   * never paired). Without an account source this is a no-op.
   */
  async refreshDirectory(): Promise<void> {
    const source = uplinkAccountSource()
    if (!source || this.directoryRefreshInFlight) return
    this.directoryRefreshInFlight = true
    try {
      const directory = await source.listDirectory()
      if (!directory) {
        this.directorySignedIn = false
        return
      }
      this.directorySignedIn = true
      const before = [
        ...loadServers().map((server) => server.id),
        ...loadWorkspaces().map((workspace) => solusApiId(workspace.organizationId)),
      ]
      const merged = mergeDirectoryIntoSaved(loadServers(), directory.hosts, directory.directoryUrl, Date.now())
      saveServers(merged)
      const workspaces = saveDirectoryWorkspaces(directory.workspaces, directory.directoryUrl)
      // A host or workspace the directory dropped is released only if nothing is
      // talking to it: a refresh must never cut a working session.
      const kept = new Set([
        ...merged.map((server) => server.id),
        ...workspaces.map((workspace) => solusApiId(workspace.organizationId)),
      ])
      const connected = new Set(serverConnections.connectedServerIds())
      for (const serverId of before) {
        if (!kept.has(serverId) && !connected.has(serverId)) serverConnections.release(serverId)
      }
      this.workspaces = workspaces
      // The window's choice stands while the directory still lists it; a
      // dropped organization falls back to the account's active one.
      const organizationChanged = organizationSelection.reconcile(workspaces)
      this.refreshServers()
      serverConnections.startCatalogSupervisors()
      markDirectoryAnswered()
      if (organizationChanged) {
        for (const listener of this.organizationListeners) listener(this.activeOrganizationId)
      }
    } finally {
      this.directoryRefreshInFlight = false
      this.lastDirectoryReadAt = Date.now()
      this.scheduleDirectoryRefresh()
    }
  }

  /**
   * Ask a managed host to run when it is stopped or failed, and wait until this
   * client is connected to it (docs/plans/project-model.md §6). The control plane
   * pushes nothing, so the directory is read again every few seconds until it says
   * `ready` and the host's catalog supervisor has dialed it. False when the account
   * cannot start it, it failed, or it did not come up in time.
   */
  async startManagedHost(serverId: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<boolean> {
    if (this.readinessFor(serverId).readiness === 'ready') return true
    const hostId = this.remotes.find((server) => server.id === serverId)?.uplink?.hostId
    const source = uplinkAccountSource()
    if (!hostId || !source) return false
    await this.refreshDirectory()
    if (managedHostNeedsStart(this.remotes.find((server) => server.id === serverId)?.uplink?.managedState)) {
      const lifecycle = await source.startManagedHost(hostId)
      if (!lifecycle || lifecycle === 'failed' || lifecycle === 'deleting') return false
    }
    const deadline = Date.now() + (opts.timeoutMs ?? 180_000)
    let dialedReady = false
    while (Date.now() < deadline) {
      await this.refreshDirectory()
      if (this.readinessFor(serverId).readiness === 'ready') return true
      const state = this.remotes.find((server) => server.id === serverId)?.uplink?.managedState
      if (state === 'failed' || state === 'deleting') return false
      // Dials made while the host was still starting left the ladder backed off for
      // up to 30s; the moment it is ready, dial it anew.
      if (state === 'ready' && !dialedReady) {
        dialedReady = true
        serverConnections.dialNow(serverId)
      }
      await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 3_000))
    }
    return this.readinessFor(serverId).readiness === 'ready'
  }

  /**
   * Dial a host now, resetting its retry ladder, and wait until this client is
   * connected to it or the time runs out. What "can agents run there" asks: the
   * directory knows a machine is listed, only a connection says it answers.
   */
  async connectNow(serverId: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<boolean> {
    if (this.readinessFor(serverId).readiness === 'ready') return true
    serverConnections.dialNow(serverId)
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000)
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 500))
      if (this.readinessFor(serverId).readiness === 'ready') return true
    }
    return false
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

  async scanForServers(opts: { onlyIfStale?: boolean } = {}): Promise<{ newServers: number } | { error: string } | null> {
    if (this.scanInFlight || (opts.onlyIfStale && Date.now() - this.lastDiscoveryScanAt < DISCOVERY_INTERVAL_MS)) return null
    this.scanInFlight = true
    this.discoveryBusy = true
    try {
      // Without a connected host the stub RPC never resolves, so a web client has nothing to scan with.
      if (this.isWebClient && !serverConnections.defaultServerId()) return { newServers: 0 }
      // Discovery runs where a network can be scanned: the local app on
      // desktop, and the connected default host's own network on web — so a
      // phone still sees the hosts sitting next to the machine it is paired with.
      const discoveryServerId = this.local ? LOCAL_SERVER_ID : serverConnections.defaultServerId()
      if (!discoveryServerId) return { newServers: 0 }
      const discovered = await serverConnections.apiFor(discoveryServerId).discoverServers()
      // A saved host found on this network is dialed here before its tunnel (docs/plans/host-routes.md D1).
      const withNearby = withDiscoveredRoutes(loadServers(), discovered, Date.now())
      if (withNearby) {
        saveServers(withNearby)
        this.refreshServers()
      }
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
      this.lastDiscoveryScanAt = Date.now()
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

  /**
   * Forgets a host. A host the account lists is listed on every device, so its
   * registration ends first; forgetting it here alone would not last. Removing a
   * host that is already gone, here or in the account, succeeds, so a second
   * click or a retry does no harm.
   */
  async remove(serverId: string, options: { discardUnsent?: boolean } = {}): Promise<void> {
    if (serverId === LOCAL_SERVER_ID) return
    // Edits to live works that only this device holds are not deleted without asking.
    if (!options.discardUnsent && askBeforeDiscardingUnsent(serverId, () => void this.remove(serverId, { discardUnsent: true }))) return
    const server = this.remotes.find((candidate) => candidate.id === serverId)
    // The active host is only the new-work default now: step aside to another
    // catalog host in place, then forget as usual. Only the last host has
    // nowhere to step to.
    const fallbackId = serverId !== this.activeServerId
      ? null
      : this.local ? LOCAL_SERVER_ID : this.remotes.find((candidate) => candidate.id !== serverId)?.id
    if (serverId === this.activeServerId && !fallbackId) {
      toasts.error(`Pair another host before forgetting ${server?.label ?? 'this host'}`)
      requestInputFocus()
      return
    }
    if (server?.uplink && !(await uplinkAccountSource()?.removeHost(server.uplink.hostId))) {
      toasts.error(`Could not remove ${server.label} from your account`)
      requestInputFocus()
      return
    }
    if (fallbackId && serverId === this.activeServerId) this.switchTo(fallbackId)
    removeServer(serverId)
    // No longer a catalog entry, so the eager supervisor leaves with it. A tab
    // on this host retains it, and a retained connection still lists the host
    // as a connected row: forgetting overrides that hold.
    serverConnections.unretain(serverId)
    serverConnections.release(serverId)
    this.refreshServers()
    requestInputFocus()
    // A forgotten host becomes discoverable again — rescan so it drops straight
    // back into Nearby instead of vanishing until the next sweep.
    void this.scanForServers()
  }

  /**
   * Dials one host again now: the ladder resets and its grace restarts. A
   * surface retries the host it shows, never the window's active one.
   */
  retry(serverId: string): void {
    serverConnections.dialNow(serverId)
    requestInputFocus()
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
    // A record whose home is the workspace service runs nowhere; its row
    // carries the "Solus Cloud" home label instead of a machine badge.
    if (isSolusApiId(serverId)) return null
    const host = this.hostFor(serverId)
    if (!host || host.local) return null
    return hostAffinityGlyph(host, this.readinessFor(host.id))
  }

  /** The address shown beside a machine's name when another machine has the same name; null when its name is its own. */
  sameNameAddress(serverId: string): string | null {
    return sameNameHostAddresses(this.servers).get(serverId) ?? null
  }

  /** A machine, or the workspace service by its id: a record's `serverId` may name either. */
  hostFor(serverId: string | null | undefined): ServerItem | UnknownRemoteHost | null {
    if (!serverId) return null
    const host = isSolusApiId(serverId)
      ? this.cloudConnections.find((connection) => connection.id === serverId)
      : this.servers.find((server) => server.id === serverId)
    if (host) return host
    if (serverId === LOCAL_SERVER_ID) return null
    // Not saved and not connected: the host was deleted, or never listed at this origin.
    return { id: serverId, label: 'Removed host', local: false, unknown: true }
  }

  /**
   * Whether this client can do work on the host now (docs/plans/host-readiness.md):
   * the one answer every surface reads. Never opens a connection.
   */
  readinessFor(serverId: string): HostReadinessState {
    // Presence follows the saved lists; the rest follows the connections.
    void this.readinessVersion
    void this.remotes
    void this.workspaces
    return serverConnections.readinessFor(serverId)
  }
  /** What a person needs to see why a host is not ready, or to send to support. */
  diagnosticsFor(serverId: string): HostDiagnostics {
    void this.readinessVersion
    void this.remotes
    return serverConnections.diagnosticsFor(serverId)
  }

  /** The host's readiness in one word, as a host list shows it: "Online", "Offline". */
  readinessLabelFor(serverId: string): string {
    return hostReadinessCopy(this.readinessFor(serverId), '').label
  }


  private updateAutoDiscovery(): void {
    if (!this.shouldAutoDiscover()) {
      if (this.discoveryTimer) clearInterval(this.discoveryTimer)
      this.discoveryTimer = null
      return
    }
    // Focus, visibility, and connection events can name the same active window.
    // They must not restart its timer or repeat a recent successful scan.
    if (this.discoveryTimer) return
    void this.scanForServers({ onlyIfStale: true })
    this.discoveryTimer = setInterval(() => {
      if (!this.shouldAutoDiscover()) {
        this.updateAutoDiscovery()
        return
      }
      void this.scanForServers({ onlyIfStale: true })
    }, DISCOVERY_INTERVAL_MS)
  }

  private shouldAutoDiscover(): boolean {
    return !document.hidden && document.hasFocus()
  }
}

/**
 * One store per page, even across hot updates. A re-evaluated module would
 * build a second `ServersStore` while the first keeps its discovery timer and
 * focus listeners, so both scan on focus.
 * `hot.data` survives re-evaluation; production takes the plain construction.
 */
export const serversStore: ServersStore = import.meta.hot
  ? (import.meta.hot.data.serversStore ??= new ServersStore())
  : new ServersStore()
