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
import { askHostsToDiscover, mergeDiscovered } from '@solus/client-core/discovery-through-hosts'
import { localApi } from '@solus/client-core/local-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { preferredRouteUrl, type LocalConnectionInfoLike, type SolusServerTarget } from '@solus/client-core/server-connection'
import { onWakeSignal } from '@solus/client-core/wake-signals'
import { hostListSourceFor } from '@solus/client-core/host-list-source'
import { uplinkAccountSource } from '@solus/client-core/uplink-account'
import { workspaceTarget, type KnownWorkspace } from '@solus/client-core/workspace-registry'
import { hostCatalog, type AnswerState } from '@solus/client-core/host-catalog'
import { windowOrganizationSelection } from '@solus/client-core/organization-selection'
import { organizationSelection } from './organization-selection.store.svelte'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import {
  getActiveServerId,
  LOCAL_SERVER_ID,
  managedHostNeedsStart,
  setActiveServerId,
  type KnownHost,
  type KnownHostUplink,
} from '@solus/client-core/known-host'
import type { HostOperatingSystem, ProjectIdentity } from '@solus/contracts/types'
import { isSolusApiId, solusApiId, type HostRules } from '@solus/contracts/uplink'
import { routeForUrl, type HostRoute } from '@solus/contracts/host-routes'
import { untrack } from 'svelte'
import { requestInputFocus } from '../../lib/inputFocus'
import { toasts } from '../../lib/toasts'
import { accountStore } from '../account/account.store.svelte'
import { accountDocuments } from '../account/account-sync.store.svelte'
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
import { prDeviceCache } from '../prs/pr-device-cache'

const DISCOVERY_INTERVAL_MS = 30_000

/** What the add-host dialog shows: a pairing link, an address and code, SSH, or the add of a WSL distro chosen in the nearby list. */
export type AddHostMode = 'link' | 'manual' | 'ssh' | 'wsl'

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
  uplink?: KnownHostUplink
}

/** A read of the hosts that has not answered yet: the person's host list, or the account directory (plans/033 §3 Q2). */
export interface UnreadHosts {
  answer: 'list' | 'directory'
  state: Exclude<AnswerState, 'ready'>
  /** What a host list or picker says in place of the hosts it cannot show yet. */
  text: string
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
  hostRules: HostRules
  /** The organization this window works in. */
  isActive: boolean
}

type OrganizationListener = (organizationId: string | null) => void

class ServersStore {
  /** Hide a host during its Undo window without dropping access or connections. */
  private readonly pendingRemovals = new SvelteSet<string>()
  local = $state<LocalConnectionInfoLike | null>(null)
  /** What the local server calls itself — its hostname, from /health. Null
   *  until the probe answers; the row falls back to a generic label. The row
   *  deliberately carries no `os`: OS logos mark machines you are not sitting
   *  at, and the local row keeps the plain device glyph everywhere. */
  private localIdentity = $state<{ name: string; os?: HostOperatingSystem } | null>(null)
  /** The hosts this client knows, as the host catalog joins them (plans/033 §4.2). */
  remotes = $state<KnownHost[]>([...hostCatalog.hosts()])
  /** The organizations' workspace services, as the account directory last listed them. */
  workspaces = $state<KnownWorkspace[]>([...hostCatalog.workspaces()])
  /** Whether the person's host list answered: until it does, the list shows a loading or failed state (§3 Q2). */
  listState = $state<AnswerState>(hostCatalog.listState())
  /** Whether the account directory answered: Solus Cloud shows loading, or failed with Retry, until it does (§3 Q2). */
  directoryState = $state<AnswerState>(hostCatalog.directoryState())
  private readonly organizationListeners = new Set<OrganizationListener>()
  activeServerId = $state(serverConnections.defaultServerId() ?? getActiveServerId())
  addServerOpen = $state(false)
  addServerUrl = $state('')
  addServerMode = $state<AddHostMode>('link')
  /** Which Run-on picker opened the add-server dialog, so a host paired from
   *  there is handed back to that picker and not to another one. A correlation
   *  breadcrumb between two UI moments — any stable id will do, and a session
   *  draft has one before it has a tab. */
  pendingRunOnRequesterId = $state<string | null>(null)
  justPairedServerId = $state<string | null>(null)
  discoveryBusy = $state(false)
  /** What the account's host directory last said about being signed in: null until asked. */
  directorySignedIn = $state<boolean | null>(hostCatalog.directorySignedIn())
  /** The ids the catalog named when both its answers last settled: a host that leaves them is released. */
  private settledIds = new Set<string>()
  /** Whether the person was signed in when the host list source was last chosen; null before. */
  private listSignedIn: boolean | null = null
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

  constructor() {
    hostCatalog.onChange(() => this.followCatalog())
  }

  /** The hosts provisioned for an organization; follows `remotes`. */
  get managedHostIds(): ReadonlySet<string> {
    void this.remotes
    return hostCatalog.managedHostIds()
  }

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
   * The reads whose hosts a list cannot show yet. Nothing is kept from an earlier
   * start, so a list says it is reading, or that a read failed, with Retry.
   */
  get unreadHosts(): UnreadHosts[] {
    const unread: UnreadHosts[] = []
    if (this.listState !== 'ready') {
      unread.push({ answer: 'list', state: this.listState, text: this.listState === 'loading' ? 'Reading your host list…' : 'Your host list could not be read' })
    }
    if (this.directoryState !== 'ready') {
      unread.push({ answer: 'directory', state: this.directoryState, text: this.directoryState === 'loading' ? `Reading ${SOLUS_CLOUD_LABEL}…` : `${SOLUS_CLOUD_LABEL} could not be read` })
    }
    return unread
  }

  /** Reads hosts again after a read failed: the person's host list, or the account directory. */
  retryHosts(answer: UnreadHosts['answer']): void {
    void (answer === 'list' ? hostCatalog.refreshList() : this.refreshDirectory())
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
    return rows.filter((server) => !this.pendingRemovals.has(server.id))
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

  /** The organizations the account belongs to, with each one's host rules, the window's marked. */
  get organizations(): OrganizationChoice[] {
    return this.workspaces.map((workspace) => ({
      organizationId: workspace.organizationId,
      name: workspace.label,
      hostRules: workspace.hostRules,
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
        if (!local) return
        // The row should carry the machine's real name, not a placeholder —
        // /health is the one source that knows it.
        void serverConnections.probeHealth(LOCAL_SERVER_ID).then((health) => {
          if (health) this.localIdentity = { name: health.name, os: health.os }
        })
      })
    }

    this.trackConnections(updateAutoDiscovery)

    // Forgetting a host is total: its skew dismissals, queued sends and kept
    // pull requests leave with it (the session snapshot cache purges itself
    // the same way). A host forgotten on another device leaves here too (§3 Q1).
    hostCatalog.onForgotten((server) => {
      forgetSkewDismissals(server.id)
      sendOutbox.forgetHost(server.id)
      void prDeviceCache.forgetHost(server.id)
    })

    // The account's host directory and the person's host list are read on boot,
    // on sign-in changes, on wake, when Connections opens, when the window gets
    // focus, and the directory on a timer while the window is active; nothing
    // pushes the directory. The account store mirrors main's sign-in state
    // and has no other subscriber until a sign-in surface lands, so it starts here.
    accountStore.start()
    void this.refreshDirectory()
    this.followAccountForHostList()
    onWakeSignal(() => {
      void this.refreshDirectory()
      void hostCatalog.refreshList()
    })
    localApi.onAccountStateChange?.((state) => {
      // A host refused while the account held no sign-in waits for the next one.
      if (state.kind === 'signed-in') serverConnections.dialHostsBlockedOnSignIn()
      void this.refreshDirectory()
    })
    // A host added on the account site in a browser is found when the person
    // comes back to this window, which on desktop is a focus and not a wake.
    window.addEventListener('focus', () => {
      if (Date.now() - this.lastDirectoryReadAt >= DIRECTORY_FOCUS_GAP_MS) {
        void this.refreshDirectory()
        void hostCatalog.refreshList()
      }
    })
  }

  /**
   * Reads the person's host list from where it is now (plans/031 D7, plans/033
   * §4.5): the account's document while signed in; signed out, the device host's
   * list, or this device's own where it runs beside no host (the account origin).
   * Chosen once the account has answered, and again at each sign-in or sign-out.
   */
  private followAccountForHostList(): void {
    $effect.root(() => {
      $effect(() => {
        if (!accountStore.hasAnswered) return
        const signedIn = accountStore.isSignedIn
        untrack(() => this.chooseHostList(signedIn))
      })
    })
  }

  private chooseHostList(signedIn: boolean): void {
    if (this.listSignedIn === signedIn) return
    this.listSignedIn = signedIn
    const deviceHostId = serverConnections.deviceHostId()
    const source = hostListSourceFor({
      accountDocuments: signedIn ? accountDocuments() : null,
      deviceHost: deviceHostId
        ? { id: deviceHostId, api: serverConnections.apiFor(deviceHostId), events: serverConnections.eventsFor(deviceHostId) }
        : null,
      deviceStorage: globalThis.localStorage ?? null,
    })
    // Boot may have chosen the same list already (the web client reads it before it mounts).
    if (source && source.key === hostCatalog.listSourceKey()) return
    void hostCatalog.useListSource(source)
  }

  /**
   * Copies the catalog's answers into reactive state. A host or workspace that
   * left them is released only if nothing is talking to it: a read must never cut
   * a working session. Ids are compared only while both answers are settled, so a
   * list that is read again from a new source does not drop every host meanwhile.
   */
  private followCatalog(): void {
    this.remotes = [...hostCatalog.hosts()]
    this.workspaces = [...hostCatalog.workspaces()]
    this.listState = hostCatalog.listState()
    this.directoryState = hostCatalog.directoryState()
    this.directorySignedIn = hostCatalog.directorySignedIn()
    if (this.listState !== 'loading' && this.directoryState !== 'loading') {
      const kept = new Set([
        ...this.remotes.map((server) => server.id),
        ...this.workspaces.map((workspace) => solusApiId(workspace.organizationId)),
      ])
      const connected = new Set(serverConnections.connectedServerIds())
      for (const serverId of this.settledIds) {
        if (!kept.has(serverId) && !connected.has(serverId)) serverConnections.release(serverId)
      }
      this.settledIds = kept
    }
    // The window's choice stands while the directory still lists it; a
    // dropped organization falls back to the account's active one.
    if (organizationSelection.reconcile(this.workspaces)) {
      for (const listener of this.organizationListeners) listener(this.activeOrganizationId)
    }
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
   * Reads the signed-in account's directory again (`hostCatalog.refreshDirectory`):
   * its hosts and the organizations' workspace services. A read in flight is shared.
   */
  async refreshDirectory(): Promise<void> {
    try {
      await hostCatalog.refreshDirectory()
    } finally {
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

  /**
   * Keeps a host this client just paired (`hostCatalog.pair`): its credential, then
   * its listing on the person's host list. A listing the list refused stays shown
   * here and is sent again at the next read.
   */
  async savePairedServer(server: KnownHost): Promise<void> {
    if (server.installationId) this.nearby.delete(server.installationId)
    this.justPairedServerId = server.id
    const { host, listError } = await hostCatalog.pair(server)
    if (listError) toasts.error(`${host.label} is paired here but not yet on your host list`)
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

  openAddServer(prefillUrl = '', mode: AddHostMode = 'link'): void {
    this.addServerUrl = prefillUrl
    this.addServerMode = mode
    this.addServerOpen = true
  }

  closeAddServer(): void {
    this.addServerOpen = false
    this.addServerUrl = ''
    this.addServerMode = 'link'
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
      // Web also asks every other connected host for the tailnet hosts it sees
      // (docs/plans/tailscale-support.md D4); desktop's local host reads this
      // machine's tailnet itself. A managed host advertises no tailnet routes.
      const otherHostIds = this.local ? [] : serverConnections.connectedServerIds()
        .filter((serverId) => serverId !== discoveryServerId && !this.managedHostIds.has(serverId))
      const [own, fromHosts] = await Promise.all([
        serverConnections.apiFor(discoveryServerId).discoverServers(),
        askHostsToDiscover(otherHostIds.map((serverId) => () => serverConnections.apiFor(serverId).discoverServers())),
      ])
      const discovered = mergeDiscovered(own, fromHosts)
      // A saved host found on this network is dialed here before its tunnel (docs/plans/host-routes.md D1).
      hostCatalog.applyDiscovered(discovered)
      const filtered = filterUnsavedDiscoveredServers({
        discovered,
        knownHosts: this.remotes,
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
    if (serverId !== LOCAL_SERVER_ID) hostCatalog.touchLastConnected(serverId)
    requestInputFocus()
  }

  private async forgetHostConnections(serverId: string): Promise<boolean> {
    const server = this.remotes.find((candidate) => candidate.id === serverId)
    try {
      await serverConnections.forgetHost(server?.installationId ?? serverId, server?.routes ?? [])
      return true
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : String(error))
      requestInputFocus()
      return false
    }
  }

  removeWithUndo(serverId: string): void {
    const server = this.servers.find((candidate) => candidate.id === serverId)
    if (!server || server.local || this.pendingRemovals.has(serverId)) return
    this.pendingRemovals.add(serverId)
    toasts.undo(`${server.label} removed`, () => this.pendingRemovals.delete(serverId), {
      onDismiss: () => {
        void this.remove(serverId)
          .catch((error) => toasts.error(error instanceof Error ? error.message : String(error)))
          .finally(() => this.pendingRemovals.delete(serverId))
      },
    })
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
    if (!await this.forgetHostConnections(serverId)) return
    if (server?.uplink && !(await uplinkAccountSource()?.removeHost(server.uplink.hostId))) {
      toasts.error(`Could not remove ${server.label} from your account`)
      requestInputFocus()
      return
    }
    if (fallbackId && serverId === this.activeServerId) this.switchTo(fallbackId)
    await hostCatalog.forget(serverId)
    // The directory may have named the host until now: read it again, so the host leaves every list here.
    await this.refreshDirectory()
    // No longer a catalog entry, so the eager supervisor leaves with it. A tab
    // on this host retains it, and a retained connection still lists the host
    // as a connected row: forgetting overrides that hold.
    serverConnections.unretain(serverId)
    serverConnections.release(serverId)
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

  /** Reads the way to a host once, so its diagnosis can name a stage. */
  checkConnection(serverId: string): void {
    void serverConnections.checkConnection(serverId)
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
