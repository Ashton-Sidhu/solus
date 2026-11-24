/// <reference types="vite/client" />
import { HostPairingFollower } from './host-pairing-follower'
import { connectThroughMachine, pairedHostRoute } from './host-linking'
import { defaultDeviceLabel } from './device-label'
import { forgetHostConnections, type HostConnectionOwner } from './forget-host'
import type { ConnectionsServerInfo, NativeSolusAPI, SolusAPI } from '@solus/contracts/host-api'
import { mergeNativeOnlySolusApi } from './native-api-overlay'
import { catalogHostTarget, createSolusConnection, type SolusServerTarget } from './server-connection'
import { awaitsManagedCompute, chooseRunOnHost, getActiveServerId, LOCAL_SERVER_ID, managedHostNeedsStart, type KnownHost } from './known-host'
import { hostCatalog, type HostCatalog } from './host-catalog'
import { activeWorkspace, ambiguousOrganizationIds, workspaceTarget } from './workspace-registry'
import { solusApiId } from '@solus/contracts/uplink'
import type { WsTransport } from './ws-transport'
import type { HostEventSubscriber } from './host-event-subscriber'
import type { BrowserFrameSubscriber } from './browser-frame-subscriber'
import type { HostSupervisor } from './host-supervisor'
import { CHECKING_HOST, GONE_HOST, type HostReadinessState, type LinkReadiness } from './host-readiness'
import type { HostDiagnostics } from './host-diagnostics'
import { CLIENT_VERSION } from './version-skew'
import { onWakeSignal } from './wake-signals'
import { asHostApi, type HostApi } from './host-api'
import type { HostCapabilities } from '@solus/contracts/types'
import type { HostFacts, HostPresence } from './host-facts'
import { HostGoneError } from './rpc-error'
import { HostIntroducer } from './host-introducer'
import { answersAsSavedHost, HostLink, isSavedHost } from './host-link'
import { readHostHealth, type HostHealth } from './host-http'
import { dialChoicesOf, isEncryptedRouteUrl, routesForMachine, type HostRoute } from '@solus/contracts/host-routes'

const CACHE_TTL_MS = 60_000
const HEALTH_TIMEOUT_MS = 3_000

export type ServerHealth = HostHealth

export interface ManagedConnection {
  serverId: string
  /** `gone`: this client does not know the host. The connection opens no socket,
   *  and every call rejects with `HostGoneError`. */
  presence: HostPresence
  target: SolusServerTarget
  /** The host's link: transport, supervisor, route choice, and facts. */
  link: HostLink
  transport: WsTransport
  api: SolusAPI
  events: HostEventSubscriber
  /** The one owner of this host's connection lifecycle and retry policy. */
  supervisor: HostSupervisor
  /** Everything read about this host, shared by every reader (docs/plans/host-model.md). */
  facts: HostFacts
  pairings?: HostPairingFollower
}

type ConnectionListener = (connection: ManagedConnection) => void
type ReadinessListener = (serverId: string, readiness: LinkReadiness, attempt: number) => void

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

export class ServerConnections {
  private readonly connections = new Map<string, ManagedConnection>()
  private readonly localBridges = new Map<string, { refreshSessionToken: () => Promise<string>; nativeApi: NativeSolusAPI }>()
  private readonly connectionListeners = new Set<ConnectionListener>()
  private readonly readinessListeners = new Set<ReadinessListener>()
  /** Every dial outcome: a host's diagnostics (attempts, last error) moved. */
  private readonly dialListeners = new Set<(serverId: string) => void>()
  /** Each host's Solus version when it was last read. A drop clears the host's
   *  capabilities, but its diagnostics still need the version it ran. */
  private readonly lastHostVersions = new Map<string, string>()
  /** Introduces the hosts this client owns to each other (docs/plans/host-reach.md §4). */
  private readonly introducer = new HostIntroducer(() => this.ownedHosts())
  private readonly primaryListeners = new Set<() => void>()
  private readonly healthCache = new Map<string, CacheEntry<ServerHealth | null>>()
  private readonly identityCache = new Map<string, CacheEntry<Awaited<ReturnType<SolusAPI['listProjectIdentities']>>>>()
  private readonly identityReads = new Map<string, Promise<Awaited<ReturnType<SolusAPI['listProjectIdentities']>>>>()
  private readonly retainedServerIds = new Set<string>()
  /** Connections made but not dialed: a managed host the directory does not call ready yet. */
  private readonly undialedServerIds = new Set<string>()
  private primaryServerId: string | null = null
  /** The desktop's local host is turned off (docs/plans/desktop-remote-only.md). */
  private localHostOff = false
  /** The host that served this web page, when it is one (plans/031 D7). */
  private servingHostId: string | null = null
  /** Boot asked for the catalog's hosts: each change of the catalog dials the hosts it adds. */
  private followsCatalog = false

  /**
   * `catalog` is the one owner of the hosts this client knows (plans/033), and the
   * only answer to which hosts exist; the page's own unless a test gives one. The
   * connections follow it: one for each host it names, closed when it stops naming one.
   */
  constructor(private readonly catalog: HostCatalog = hostCatalog) {
    // Boot dials the device host, then the list is read, then the listed hosts are
    // dialed: the catalog shows no listed host before its read answers.
    catalog.onChange(() => {
      if (this.followsCatalog) this.startCatalogSupervisors()
      this.closeUnknownHosts()
    })
    // One classified wake stream fans out to every supervisor: N hosts must
    // not mean N window listeners each re-deciding what a wake meant.
    onWakeSignal((signal) => {
      for (const connection of this.connections.values()) {
        if (this.undialedServerIds.has(connection.serverId)) continue
        connection.link.wake(signal)
        if (connection.link.readiness === 'ready') void connection.pairings?.refresh()
      }
    })
  }

  /** The desktop's own machine gives its native bridge: its native-only methods join the host's API, and its token renews over IPC. */
  attachNativeBridge(serverId: string, bridge: { refreshSessionToken: () => Promise<string>; nativeApi: NativeSolusAPI }): void {
    this.localBridges.set(serverId, bridge)
  }

  /**
   * Installs a connection whose transport the caller made: the in-page demo, whose
   * backend answers every dial at once. Its host joins the catalog for this page.
   * Every app dials through `setPrimary`.
   */
  registerPrimary(serverId: string, api: SolusAPI, transport: WsTransport, host: KnownHost): ManagedConnection {
    this.catalog.addPageHost(host)
    const existing = this.connections.get(serverId)
    if (existing && existing.transport !== transport) this.destroyConnection(existing)
    const connection = this.managedConnection(serverId, catalogHostTarget(this.catalog, host), transport, api, 'present')
    this.connections.set(serverId, connection)
    this.primaryServerId = serverId
    this.emitPrimaryChange()
    this.emitConnectionCreated(connection)
    return connection
  }

  /** Eagerly desire every catalog entry: the registered local/platform target
   *  plus each known host (dispatch-client step 3). Idempotent — hosts with a
   *  live supervisor are left exactly as they are. From the first call on, each
   *  change of the catalog does this again. */
  startCatalogSupervisors(): void {
    this.followsCatalog = true
    this.adoptFirstHost()
    for (const serverId of this.catalogServerIds()) {
      const connection = this.ensure(serverId)
      this.followKnownRoutes(connection)
      if (this.undialedServerIds.has(serverId) && !this.awaitsManagedHost(serverId)) {
        this.undialedServerIds.delete(serverId)
        connection.link.start()
      }
    }
  }

  /**
   * Whether this client can do work on the host now: the one answer every
   * surface reads (docs/plans/host-readiness.md). Never opens a connection.
   */
  readinessFor(serverId: string): HostReadinessState {
    const resolvedId = this.resolveId(serverId)
    if (this.presenceOf(resolvedId) === 'gone') return GONE_HOST
    const link = this.connections.get(resolvedId)?.link
    if (!link) return CHECKING_HOST
    if (this.undialedServerIds.has(resolvedId)) {
      const managedState = this.catalog.find(resolvedId)?.uplink?.managedState
      return managedHostNeedsStart(managedState)
        ? { readiness: 'unreachable', away: true, unreachableReason: 'not-running', refusedReason: null, lastSeenAt: link.lastSeenAt }
        : CHECKING_HOST
    }
    return {
      readiness: link.readiness,
      away: link.away,
      unreachableReason: link.readiness === 'unreachable' ? 'no-answer' : null,
      refusedReason: link.readiness === 'refused' ? link.refusedReason : null,
      lastSeenAt: link.lastSeenAt,
    }
  }

  /** What a person needs to see why a host is not ready, or to send to support. Never opens a connection. */
  diagnosticsFor(serverId: string): HostDiagnostics {
    const resolvedId = this.resolveId(serverId)
    const connection = this.connections.get(resolvedId)
    const target = connection?.target ?? this.resolveTarget(resolvedId)
    const known = this.catalog.find(resolvedId)
    return {
      hostId: resolvedId,
      label: target?.label ?? resolvedId,
      installationId: known?.installationId ?? target?.installationId ?? null,
      state: this.readinessFor(resolvedId),
      dialedUrl: connection?.transport.serverUrl ?? target?.url ?? null,
      routes: target?.routes ?? [],
      attempt: connection?.link.attempt ?? 0,
      lastDialError: connection?.transport.lastDialError ?? null,
      hostVersion: connection?.facts.value('capabilities')?.version ?? this.lastHostVersions.get(resolvedId) ?? null,
      clientVersion: CLIENT_VERSION,
      connectionCheck: connection?.link.connectionCheck ?? null,
      isCheckingConnection: connection?.link.isCheckingConnection ?? false,
    }
  }

  /** Reads the way to a host once, so its diagnosis can name a stage. The host's dial listeners hear the result. */
  checkConnection(serverId: string): Promise<void> {
    return this.connections.get(this.resolveId(serverId))?.link.checkConnection() ?? Promise.resolve()
  }

  onDialOutcome(listener: (serverId: string) => void): () => void {
    this.dialListeners.add(listener)
    return () => this.dialListeners.delete(listener)
  }

  onReadinessChange(listener: ReadinessListener): () => void {
    this.readinessListeners.add(listener)
    return () => this.readinessListeners.delete(listener)
  }

  /** User retry: reset the host's ladder and dial now. */
  dialNow(serverId: string): void {
    const resolved = this.resolveId(serverId)
    this.undialedServerIds.delete(resolved)
    this.connections.get(resolved)?.link.dialNow()
  }

  /**
   * The person chose Pair again for a host that refuses this device. A host this
   * client is connected to as its owner, and that paired it, gives this device a
   * new token without a code. False when none can: the caller asks for a code.
   */
  async pairAgain(serverId: string): Promise<boolean> {
    const installationId = this.catalog.find(this.resolveId(serverId))?.installationId ?? serverId
    return connectThroughMachine(installationId, [...this.connections.values()].flatMap((connection) =>
      connection.link.readiness === 'ready' ? connection.pairings ?? [] : [],
    ))
  }

  pairedUrlFor(installationId: string): string | undefined {
    installationId = this.catalog.find(this.resolveId(installationId))?.installationId ?? installationId
    for (const connection of this.connections.values()) {
      if (connection.link.readiness !== 'ready') continue
      const pairing = connection.pairings?.snapshot()?.hosts.find(({ listing }) => listing.installationId === installationId)
      if (pairing) return pairedHostRoute(pairing)?.url
    }
  }

  pairedSourceFor(installationId: string, preferredId?: string): string | undefined {
    installationId = this.catalog.find(this.resolveId(installationId))?.installationId ?? installationId
    const sources = [...this.connections.values()]
    const isSource = (connection: ManagedConnection) => connection.link.readiness === 'ready' &&
      connection.pairings?.snapshot()?.hosts.some(({ listing }) => listing.installationId === installationId)
    const preferred = preferredId ? this.connectionFor(preferredId) : undefined
    return preferred && isSource(preferred) ? preferred.serverId : sources.find(isSource)?.serverId
  }

  private refreshPairings(): void {
    for (const connection of this.connections.values()) {
      if (connection.link.readiness === 'ready') void connection.pairings?.refresh()
    }
  }

  /** The account holds a sign-in again: every host blocked on sign-in dials now. */
  dialHostsBlockedOnSignIn(): void {
    for (const connection of this.connections.values()) {
      if (connection.link.refusedReason === 'auth') connection.link.dialNow()
    }
  }

  /** Move the new-work default to another catalog host, in place. Hosts are
   *  symmetric and stay connected (dispatch-client step 5): the displaced
   *  host keeps its supervised socket and every live session on it. Boot names
   *  its first host here too, and the connection it gets is that host's. */
  setPrimary(serverId: string): ManagedConnection {
    const resolved = this.resolveId(serverId)
    const connection = this.ensure(resolved)
    this.primaryServerId = resolved
    this.emitPrimaryChange()
    return connection
  }

  /**
   * Boots a desktop window whose local host is off: no local target registers, so
   * the window has no device host, as on web. The primary is the active known host,
   * else the first in the catalog. With none, it is a `gone` connection: its calls
   * fail, a draft asks for a host, and the first host this client learns of takes
   * over (`adoptFirstHost`).
   */
  openWithoutLocalHost(): ManagedConnection {
    this.localHostOff = true
    const catalog = this.catalogServerIds()
    const activeId = getActiveServerId()
    return this.setPrimary(catalog.find((serverId) => serverId === activeId) ?? catalog[0] ?? LOCAL_SERVER_ID)
  }

  /** Whether this window's local host is off, and `serverId` names it. A host that is off is `gone` to its callers but is not removed. */
  isLocalHostOff(serverId: string = LOCAL_SERVER_ID): boolean {
    return this.localHostOff && serverId === LOCAL_SERVER_ID
  }

  private adoptFirstHost(): void {
    const primaryId = this.primaryServerId
    if (!this.localHostOff || !primaryId || this.presenceOf(primaryId) === 'present') return
    const firstId = this.catalogServerIds().find((serverId) => serverId !== primaryId)
    if (firstId) this.setPrimary(firstId)
  }

  /** The hosts this client holds: the primary, every host the catalog names, and the active organization's Solus API. */
  catalogServerIds(): string[] {
    const ids = new Set<string>()
    if (this.primaryServerId) ids.add(this.primaryServerId)
    for (const host of this.catalog.hosts()) ids.add(host.id)
    // The window's organization's workspace service is held too: it is where
    // that organization's records live, though it is not a host. Another
    // organization's service is dialed only when the window selects it (§7).
    const workspaces = this.catalog.workspaces()
    const active = activeWorkspace(workspaces)
    if (active && !ambiguousOrganizationIds(workspaces).has(active.organizationId)) ids.add(solusApiId(active.organizationId))
    return [...ids]
  }

  /**
   * The window selected another organization (organization-scope §7): the
   * previous organization's workspace service is released, unless a surface
   * still holds it, and the new one is dialed. When the released service was
   * the new-work default — the web client at the account origin boots on it —
   * the default moves to the new service first, so no default names a
   * connection that is gone.
   */
  switchSolusApi(previousServiceId: string | null, nextServiceId: string | null): void {
    if (previousServiceId === nextServiceId) return
    if (previousServiceId && previousServiceId === this.primaryServerId && nextServiceId) this.setPrimary(nextServiceId)
    if (previousServiceId) this.release(previousServiceId)
    this.startCatalogSupervisors()
  }

  /**
   * The catalog changed this host: the directory may list new routes (a managed host
   * is reached at its machine's name once it links), or this device may hold a new
   * token. A socket whose route is no longer listed is re-aimed, and a host that
   * refused this device dials again once the device holds a token it has not refused.
   */
  private followKnownRoutes(connection: ManagedConnection): void {
    if (connection.target.local || !this.catalog.find(connection.serverId)) return
    if (connection.transport.hasUntriedSessionToken()) connection.link.dialNow()
    else connection.link.followRoutes()
  }

  /** A person changed this host's routes: the live link follows the catalog's now. */
  followRoutes(serverId: string): void {
    const connection = this.connections.get(this.resolveId(serverId))
    if (connection) this.followKnownRoutes(connection)
  }

  /** The address the host's link is aimed at; null when it has no link yet. */
  dialedUrl(serverId: string): string | null {
    return this.connections.get(this.resolveId(serverId))?.transport.serverUrl ?? null
  }

  /** Identity since the web `local` alias died (dispatch-client step 5):
   *  `LOCAL_SERVER_ID` names only the desktop's registered local target, and
   *  a web client asks for hosts by their real ids. The one other id space is
   *  a host's installation id, which a record in an organization uses to name
   *  the machine that runs a session (cloud-sharing.md §3a): every client of
   *  that machine knows it, so it resolves to this client's id for it. An id
   *  this client has no host for comes back unchanged. */
  resolveId(serverId: string): string {
    if (this.catalog.find(serverId) || this.connections.has(serverId)) return serverId
    return this.catalog.hosts().find((host) => host.installationId === serverId)?.id ?? serverId
  }

  /**
   * The connection for any host id. It never throws: an id this client does not
   * know (a deleted host, or one never listed here) gets a `gone` connection that
   * opens no socket and rejects every call with `HostGoneError`. When the id is
   * known again, the next `ensure` replaces that connection with a real one.
   */
  ensure(serverId: string): ManagedConnection {
    serverId = this.resolveId(serverId)
    const existing = this.connections.get(serverId)
    if (existing?.presence === 'present') return existing
    const target = this.resolveTarget(serverId)
    if (existing && !target) return existing
    if (existing) {
      this.connections.delete(serverId)
      this.destroyConnection(existing)
    }
    return this.addConnection(target ? this.connect(serverId, target) : this.goneConnection(serverId))
  }

  private connect(serverId: string, target: SolusServerTarget): ManagedConnection {
    const bridge = this.localBridges.get(serverId)
    const { api, transport } = createSolusConnection(target, {
      verifyConnectedHost: () => this.verifyKnownHostIdentity(target),
      refreshLocalSessionToken: bridge?.refreshSessionToken,
      catalog: this.catalog,
    })
    return this.managedConnection(serverId, target, transport, bridge ? mergeNativeOnlySolusApi(api, bridge.nativeApi) : api, 'present')
  }

  private goneConnection(serverId: string): ManagedConnection {
    const target: SolusServerTarget = { id: serverId, label: serverId, url: '', local: false }
    const { api, transport } = createSolusConnection(target)
    transport.destroy('disconnected', new HostGoneError(serverId))
    return this.managedConnection(serverId, target, transport, api, 'gone')
  }

  private managedConnection(serverId: string, target: SolusServerTarget, transport: WsTransport, api: SolusAPI, presence: HostPresence): ManagedConnection {
    let wasReady = false
    let pairings: HostPairingFollower | undefined
    const link = new HostLink({
      hostId: serverId,
      transport,
      api: asHostApi(api),
      presence,
      routes: () => routesForMachine(target.routes ?? [], target.uplink?.kind),
      fallbackRoutes: () => target.fallbackRoutes ?? [],
      dialChoices: () => dialChoicesOf(target),
      clientOrigin: globalThis.location?.origin ?? '',
      localHostId: this.catalog.find(LOCAL_SERVER_ID)?.installationId ?? null,
      answersAsHost: (url, signal) => this.answersAsHost(target, url, signal),
      cloudUrl: () => target.uplink?.directoryUrl ?? null,
      onConnectionCheck: () => {
        for (const listener of this.dialListeners) listener(serverId)
      },
      onRouteChange: (url) => {
        target.url = url
        this.healthCache.delete(serverId)
      },
      onAdvertised: (advertised) => {
        if (!target.local) this.catalog.applyAdvertised(serverId, advertised)
      },
      onOutcome: () => {
        for (const listener of this.dialListeners) listener(serverId)
        // A refused host may have a newer owner pairing to follow; the follower pairs at most once for each.
        if (link.refusedReason === 'auth') this.refreshPairings()
      },
      onReadinessChange: (readiness, attempt) => {
        if (wasReady && readiness !== 'ready') {
          this.clearConnectionReads(serverId)
          pairings?.clear()
        }
        wasReady = readiness === 'ready'
        for (const listener of this.readinessListeners) listener(serverId, readiness, attempt)
        if (readiness === 'ready') {
          this.introducer.run()
          void pairings?.refresh()
        }
      },
    })
    link.facts.subscribe((key) => {
      const version = key === 'capabilities' ? link.facts.value('capabilities')?.version : undefined
      if (version) this.lastHostVersions.set(serverId, version)
    })
    pairings = new HostPairingFollower({
      api, serverInfo: () => link.facts.when('serverInfo'), events: link.events, hosts: () => this.catalog.hosts(),
      save: (host) => this.catalog.pair(host),
      forget: (hostId) => this.catalog.forget(hostId), deviceLabel: defaultDeviceLabel,
      isRefused: (hostId) => this.readinessFor(hostId).refusedReason === 'auth',
    })
    return { serverId, presence, target, link, transport, api, events: link.events, supervisor: link.supervisor, facts: link.facts, pairings }
  }

  private addConnection(connection: ManagedConnection): ManagedConnection {
    const { serverId } = connection
    this.connections.set(serverId, connection)
    // `ensure()` is reached from derived renderer state — a component asking
    // which API surface its tab talks to — so its side effects must not run
    // inside that computation. Both the created-listeners and the transport's
    // first status change write Svelte state, which is forbidden mid-derivation.
    // The connection is usable immediately either way: requests queue until the
    // socket is up. A connection released before the microtask runs is skipped,
    // so a borrowed host never opens a socket nobody owns.
    queueMicrotask(() => {
      if (this.connections.get(serverId) !== connection) return
      this.emitConnectionCreated(connection)
      if (connection.presence === 'gone') return
      if (this.awaitsManagedHost(serverId)) this.undialedServerIds.add(serverId)
      else connection.link.start()
    })
    return connection
  }

  apiFor(serverId: string): HostApi {
    return asHostApi(this.ensure(serverId).api)
  }

  /**
   * The host new work targets when nothing narrower names one — the visible,
   * explicit remnant of "primary" (dispatch-client step 5): set at boot,
   * moved in place by host switching, never an ambient fallback for
   * session-scoped reads.
   */
  defaultServerId(): string | null {
    return this.primaryServerId
  }

  /** The Run on host: where new work runs when nothing narrower names a
   *  machine; null when the window has none (`chooseRunOnHost`). Unlike
   *  `defaultServerId`, never the workspace service. Only the Run on picker and
   *  the readers it serves ask this (docs/plans/host-model.md §3.3). */
  runOnHostId(): string | null {
    return chooseRunOnHost({
      primaryId: this.primaryServerId,
      localId: this.localServerId(),
      known: this.catalog.hosts(),
      activeOrganizationId: activeWorkspace(this.catalog.workspaces())?.organizationId ?? null,
      isConnected: (serverId) => this.connections.get(serverId)?.supervisor.readiness === 'ready',
    })
  }

  /** The client machine's own host: the desktop's own machine in the catalog.
   *  Null on web — a browser is not a machine that can host. */
  localServerId(): string | null {
    return this.catalog.hosts().find((host) => host.local)?.id ?? null
  }

  /** A web page served by a host names it here: it is the host the page runs beside, and the catalog's device host. */
  setServingHostId(serverId: string): void {
    this.servingHostId = serverId
    this.catalog.setDeviceHost(serverId)
  }

  /**
   * The host this client runs beside (plans/031 D7): the desktop's own host, or the
   * host that served the web page. Null on a phone and at the account origin. It
   * keeps the person's host list while they are signed out.
   */
  deviceHostId(): string | null {
    return this.localServerId() ?? this.servingHostId
  }

  localHostApi(): HostApi | null {
    const serverId = this.localServerId()
    return serverId ? this.apiFor(serverId) : null
  }

  eventsFor(serverId: string): HostEventSubscriber {
    return this.ensure(serverId).events
  }

  /** This host's streamed browser frames, routed by page id. A streamed surface
   *  subscribes here for the pixels and calls `browserSubscribeFrames` on the
   *  API to make the host start producing them. */
  framesFor(serverId: string): BrowserFrameSubscriber {
    return this.ensure(serverId).transport.frames
  }

  eventsForApi(api: SolusAPI): HostEventSubscriber {
    for (const connection of this.connections.values()) {
      if (connection.api === api) return connection.events
    }
    throw new Error('Solus API is not owned by a registered server connection')
  }

  /** Recover a host's name from its API object. A last resort: an id is a
   *  stable name, whereas an API object is a key only while it is this
   *  registry's current connection for that host. Prefer naming the host —
   *  `WorkspaceContext.serverIdFor`/`serverIdForContext` — wherever the caller
   *  can. */
  serverIdForApi(api: SolusAPI): string {
    for (const connection of this.connections.values()) {
      if (connection.api === api) return connection.serverId
    }
    throw new Error('Solus API is not owned by a registered server connection')
  }

  /**
   * Borrow a connection for one request without leaving an incidental socket
   * alive afterwards. Existing connections remain under their current owner.
   */
  async withTemporaryConnection<T>(
    serverId: string,
    fn: (api: SolusAPI) => Promise<T> | T,
  ): Promise<T> {
    serverId = this.resolveId(serverId)
    const hadConnection = this.connections.has(serverId)
    const connection = this.ensure(serverId)
    try {
      return await fn(connection.api)
    } finally {
      if (!hadConnection) this.release(serverId)
    }
  }

  /** Stop host-owned connections before removing this client's pairing. */
  async forgetHost(installationId: string, routes: readonly HostRoute[]): Promise<void> {
    await forgetHostConnections(installationId, routes, await this.ownedHosts())
  }

  /** The connected hosts where this client is the local owner: only they take part in introductions. */
  private async ownedHosts(): Promise<HostConnectionOwner[]> {
    const connected = [...this.connections.values()].filter((connection) => connection.presence === 'present' && connection.link.readiness === 'ready')
    const hosts = await Promise.all(connected.map(async (connection): Promise<HostConnectionOwner | null> => {
      const info = await connection.facts.when('serverInfo').catch(() => null)
      if (info?.principal !== 'local-owner') return null
      const health = await this.probeHealth(connection.serverId)
      return health ? { installationId: health.installationId, label: health.name, api: asHostApi(connection.api) } : null
    }))
    return hosts.filter((host): host is HostConnectionOwner => host !== null)
  }

  /**
   * The hosts work can go to, primary first: every host the catalog names, the
   * active organization's Solus API, and a service a tab holds. The catalog is the one
   * answer; an open socket adds nothing, and a gone host is not one. Whether a host
   * answers now is its readiness (`readinessFor`), not membership here.
   */
  serverIds(): string[] {
    const ids = new Set([...this.catalogServerIds(), ...this.retainedServerIds])
    return [...ids].filter((id) => this.presenceOf(id) === 'present')
  }

  connectionFor(serverId: string): ManagedConnection | undefined {
    return this.connections.get(this.resolveId(serverId))
  }

  /** HTTP origin paired with a host's WebSocket transport. Signed asset URLs
   *  are relative capabilities and must be opened against this same host. */
  httpOriginFor(serverId: string): string {
    const target = this.ensure(this.resolveId(serverId)).target
    // A gone host, or one the directory lists with no route yet, has no origin.
    return target.url ? new URL(target.url).origin : ''
  }

  /** Whether a password can go to this host now: the connection in use is encrypted, or stays on this machine. */
  hasEncryptedConnection(serverId: string): boolean {
    const resolvedId = this.resolveId(serverId)
    const url = this.ensure(resolvedId).transport.serverUrl
    return isEncryptedRouteUrl(url, this.catalog.find(resolvedId)?.routes.find((route) => route.url === url)?.kind)
  }

  /** The primary moved (boot or a Run on switch), so `runOnHostId()` may answer differently. */
  onPrimaryChange(listener: () => void): () => void {
    this.primaryListeners.add(listener)
    return () => this.primaryListeners.delete(listener)
  }

  onConnectionCreated(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener)
    return () => this.connectionListeners.delete(listener)
  }

  retain(serverId: string): void {
    this.retainedServerIds.add(serverId)
  }

  unretain(serverId: string): void {
    this.retainedServerIds.delete(serverId)
  }

  release(serverId: string): void {
    if (serverId === this.primaryServerId || this.retainedServerIds.has(serverId)) return
    // Catalog entries are eagerly desired: their supervisors are never torn
    // down by a borrower's release. Only genuinely borrowed, non-catalog
    // targets still close behind themselves.
    if (this.catalogServerIds().includes(serverId)) return
    const connection = this.connections.get(serverId)
    // A gone connection holds no socket; it stays so its readers keep one answer.
    if (!connection || connection.presence === 'gone') return
    this.close(serverId, connection)
  }

  private close(serverId: string, connection: ManagedConnection): void {
    this.connections.delete(serverId)
    this.clearConnectionReads(serverId)
    this.undialedServerIds.delete(serverId)
    this.destroyConnection(connection)
    // A host released because it is gone: its readers rebind to a gone connection.
    if (!this.resolveTarget(serverId)) this.addConnection(this.goneConnection(serverId))
  }

  /**
   * Once the list and the directory are both read, a connection whose host the
   * catalog no longer names closes, even while a tab holds it: its readers rebind
   * to a gone connection. While a read is in progress (a sign-in moving the list to
   * another source), nothing closes.
   */
  private closeUnknownHosts(): void {
    if (this.catalog.listState() === 'loading' || this.catalog.directoryState() === 'loading') return
    const unknown = [...this.connections].filter(([serverId, connection]) =>
      connection.presence === 'present' && serverId !== this.primaryServerId && !this.resolveTarget(serverId))
    for (const [serverId, connection] of unknown) this.close(serverId, connection)
  }

  private destroyConnection(connection: ManagedConnection): void {
    connection.pairings?.dispose()
    connection.link.destroy()
  }

  /** This host's facts, read once and shared (docs/plans/host-model.md). */
  factsFor(serverId: string): HostFacts {
    return this.ensure(serverId).facts
  }

  /** One identity/role read per server session. Settings may explicitly refresh it
   * after a host configuration change; concurrent consumers share that read. */
  async serverInfoFor(serverId: string, refresh = false): Promise<ConnectionsServerInfo> {
    const facts = this.factsFor(serverId)
    if (refresh) await facts.refresh('serverInfo')
    return facts.when('serverInfo')
  }

  private clearConnectionReads(serverId: string): void {
    this.identityReads.delete(serverId)
    this.identityCache.delete(serverId)
  }

  /** One host's capability record for its current server session: loaded once
   * per accepted session, cleared on disconnect. Older hosts reject the method;
   * that is an empty record, never a feature error. */
  capabilitiesFor(serverId: string): Promise<HostCapabilities> {
    return this.factsFor(serverId).when('capabilities')
  }

  cachedCapabilitiesFor(serverId: string): HostCapabilities | undefined {
    return this.connections.get(this.resolveId(serverId))?.facts.value('capabilities')
  }

  async probeHealth(serverId: string, force = false): Promise<ServerHealth | null> {
    serverId = this.resolveId(serverId)
    const cached = this.healthCache.get(serverId)
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value

    const target = this.connections.get(serverId)?.target ?? this.resolveTarget(serverId)
    let value: ServerHealth | null
    // A host the directory lists with no route yet has nothing to ask; `/health` alone is this page's origin.
    if (!target?.url) return null
    value = await readHostHealth(fetch, target.url, AbortSignal.timeout(HEALTH_TIMEOUT_MS))
    if (value?.os) this.catalog.stampOperatingSystem(serverId, value.os)
    this.healthCache.set(serverId, { value, expiresAt: Date.now() + CACHE_TTL_MS })
    return value
  }

  async verifyKnownHostIdentity(target: SolusServerTarget): Promise<boolean> {
    if (target.local || target.id === LOCAL_SERVER_ID) return true
    const known = this.catalog.find(target.id)
    // A workspace service is never a known host: its identity is the grant, which
    // the service only admits when it was minted for its audience. A guest's host
    // has no saved identity: the link's secret opens one resource.
    if (!known || known.guest) return true

    const health = await this.probeHealth(target.id, true)
    // Only a successful health response can establish or reject identity. A
    // transient HTTP failure must not turn a working socket into a false match.
    if (!health) return true
    return isSavedHost(known, health)
  }

  /** Whether `url` answers `/health` as the host this target names, with its proof when the route needs one. No credential is sent. */
  private async answersAsHost(target: SolusServerTarget, url: string, signal: AbortSignal): Promise<boolean> {
    const route = target.routes?.find((candidate) => candidate.url === url) ?? { url }
    const known = this.catalog.find(target.id)
    // A guest's host has no saved identity: its link's secret opens one resource, and the page names the host.
    if (!known || known.guest) return !!(await readHostHealth(fetch, url, signal))
    return answersAsSavedHost(fetch, route, known, signal)
  }

  async projectIdentities(serverId: string, force = false): Promise<Awaited<ReturnType<SolusAPI['listProjectIdentities']>>> {
    serverId = this.resolveId(serverId)
    const cached = this.identityCache.get(serverId)
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value
    const pending = this.identityReads.get(serverId)
    if (pending) return pending
    const read = Promise.resolve().then(() => this.apiFor(serverId).listProjectIdentities()).then((value) => {
      if (this.identityReads.get(serverId) === read) {
        this.identityCache.set(serverId, { value, expiresAt: Date.now() + CACHE_TTL_MS })
      }
      return value
    }).finally(() => {
      if (this.identityReads.get(serverId) === read) this.identityReads.delete(serverId)
    })
    this.identityReads.set(serverId, read)
    return read
  }

  /**
   * Whether this client knows the host an id names
   * (docs/plans/workspace-and-machines.md §6): a host or workspace service the
   * catalog names. Anything else is `gone`, whether or not a socket is still open.
   */
  presenceOf(serverId: string): HostPresence {
    return this.resolveTarget(this.resolveId(serverId)) ? 'present' : 'gone'
  }

  private resolveTarget(serverId: string): SolusServerTarget | null {
    const known = this.catalog.find(serverId)
    if (known) return catalogHostTarget(this.catalog, known)
    const workspace = this.catalog.workspaceFor(serverId)
    if (workspace) return workspaceTarget(workspace)
    // On web the primary host answers for the local id (see `ensure`).
    const primary = serverId === LOCAL_SERVER_ID && this.primaryServerId ? this.catalog.find(this.primaryServerId) : undefined
    return primary ? catalogHostTarget(this.catalog, primary) : null
  }

  /**
   * A managed host is dialed only once the directory calls it ready. Before that its
   * tunnel name may not resolve yet, and a resolver keeps a "no such name" answer for
   * as long as the zone allows (30 minutes for solus.sh): a dial during provisioning
   * left a ready host unreachable from that network. The directory refresh that
   * reports `ready` dials it (`startCatalogSupervisors`); a user retry dials at once.
   */
  private awaitsManagedHost(serverId: string): boolean {
    return awaitsManagedCompute(this.catalog.find(serverId)?.uplink)
  }

  private emitPrimaryChange(): void {
    for (const listener of this.primaryListeners) listener()
  }

  private emitConnectionCreated(connection: ManagedConnection): void {
    for (const listener of this.connectionListeners) listener(connection)
  }
}

/**
 * One registry per page. A module singleton is only single as long as its
 * module is, and in dev it is not: when Vite invalidates this file, every
 * importer that re-evaluates binds a fresh, empty `ServerConnections`, while
 * objects built before the update — the mounted `WorkspaceContext` above all —
 * keep the first one. The two registries then disagree about which hosts exist,
 * and `serverIdForApi`/`eventsForApi` reject a connection the other instance
 * owns ("not owned by a registered server connection") for hosts that are
 * plainly connected. `hot.data` survives re-evaluation, so every copy of this
 * module shares the registry the page actually connected with. Production
 * evaluates once and takes the plain construction.
 */
export const serverConnections: ServerConnections = import.meta.hot
  ? (import.meta.hot.data.serverConnections ??= new ServerConnections())
  : new ServerConnections()
