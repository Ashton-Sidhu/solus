/// <reference types="vite/client" />
import type { ConnectionsServerInfo, NativeSolusAPI, SolusAPI } from '@solus/contracts/host-api'
import { mergeNativeOnlySolusApi } from './native-api-overlay'
import { createSolusConnection, savedServerTarget, type SolusServerTarget } from './server-connection'
import {
  applyAdvertised,
  awaitsManagedCompute,
  chooseRunOnHost,
  loadServers,
  LOCAL_SERVER_ID,
  managedHostNeedsStart,
  stampHostOperatingSystem,
} from './server-registry'
import { activeWorkspace, ambiguousOrganizationIds, loadWorkspaces, savedWorkspaceFor, workspaceTarget } from './workspace-registry'
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
import { HostIntroducer, type IntroducerHost } from './host-introducer'
import { answersAsSavedHost, HostLink, isSavedHost, readHostHealth, type HostHealth } from './host-link'

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
}

type ConnectionListener = (connection: ManagedConnection) => void
type ReadinessListener = (serverId: string, readiness: LinkReadiness, attempt: number) => void

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

/**
 * A managed host is dialed only once the directory calls it ready. Before that its
 * tunnel name may not resolve yet, and a resolver keeps a "no such name" answer for
 * as long as the zone allows (30 minutes for solus.sh): a dial during provisioning
 * left a ready host unreachable from that network. The directory refresh that
 * reports `ready` dials it (`startCatalogSupervisors`); a user retry dials at once.
 */
function awaitsManagedHost(serverId: string): boolean {
  return awaitsManagedCompute(loadServers().find((server) => server.id === serverId)?.uplink)
}

export class ServerConnections {
  private readonly connections = new Map<string, ManagedConnection>()
  private readonly targets = new Map<string, SolusServerTarget>()
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

  constructor() {
    // One classified wake stream fans out to every supervisor: N hosts must
    // not mean N window listeners each re-deciding what a wake meant.
    onWakeSignal((signal) => {
      for (const connection of this.connections.values()) {
        if (this.undialedServerIds.has(connection.serverId)) continue
        connection.link.wake(signal)
      }
    })
  }

  /** A host this client knows besides its saved ones: the desktop's own machine, a guest's shared resource. The desktop gives its native bridge, whose native-only methods join the host's API. */
  registerTarget(target: SolusServerTarget, local?: { refreshSessionToken: () => Promise<string>; nativeApi: NativeSolusAPI }): void {
    this.targets.set(target.id, target)
    if (local) this.localBridges.set(target.id, local)
  }

  /**
   * Installs a connection whose transport the caller made: the in-page demo, whose
   * backend answers every dial at once. Every app dials through `setPrimary`.
   */
  registerPrimary(serverId: string, api: SolusAPI, transport: WsTransport, target: SolusServerTarget): ManagedConnection {
    this.targets.set(serverId, target)
    const existing = this.connections.get(serverId)
    if (existing && existing.transport !== transport) this.destroyConnection(existing)
    const connection = this.managedConnection(serverId, target, transport, api, 'present')
    this.connections.set(serverId, connection)
    this.primaryServerId = serverId
    this.emitPrimaryChange()
    this.emitConnectionCreated(connection)
    return connection
  }

  /** Eagerly desire every catalog entry: the registered local/platform target
   *  plus each saved host (dispatch-client step 3). Idempotent — hosts with a
   *  live supervisor are left exactly as they are. */
  startCatalogSupervisors(): void {
    for (const serverId of this.catalogServerIds()) {
      const connection = this.ensure(serverId)
      this.followSavedRoutes(connection)
      if (this.undialedServerIds.has(serverId) && !awaitsManagedHost(serverId)) {
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
      const managedState = loadServers().find((server) => server.id === resolvedId)?.uplink?.managedState
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
    const saved = loadServers().find((server) => server.id === resolvedId)
    return {
      hostId: resolvedId,
      label: target?.label ?? resolvedId,
      installationId: saved?.installationId ?? target?.installationId ?? null,
      state: this.readinessFor(resolvedId),
      dialedUrl: connection?.transport.serverUrl ?? target?.url ?? null,
      routes: target?.routes ?? [],
      attempt: connection?.link.attempt ?? 0,
      lastDialError: connection?.transport.lastDialError ?? null,
      hostVersion: connection?.facts.value('capabilities')?.version ?? this.lastHostVersions.get(resolvedId) ?? null,
      clientVersion: CLIENT_VERSION,
    }
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

  /** The hosts this client holds: the registered local target, the primary, every saved host, and the active organization's Solus API. */
  catalogServerIds(): string[] {
    const ids = new Set<string>()
    let localInstallationId: string | undefined
    for (const [id, target] of this.targets) {
      if (!target.local) continue
      ids.add(id)
      localInstallationId = target.installationId
    }
    if (this.primaryServerId) ids.add(this.primaryServerId)
    for (const server of loadServers()) {
      if (server.installationId !== localInstallationId) ids.add(server.id)
    }
    // The window's organization's workspace service is held too: it is where
    // that organization's records live, though it is not a host. Another
    // organization's service is dialed only when the window selects it (§7).
    const workspaces = loadWorkspaces()
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
   * A connection copies its host's routes when it is made; the directory can change
   * them later (a managed host is reached at its machine's name once it links). Take
   * the saved routes again, and re-aim a socket whose route is no longer listed.
   */
  private followSavedRoutes(connection: ManagedConnection): void {
    const { target } = connection
    if (target.local) return
    const saved = loadServers().find((server) => server.id === connection.serverId)
    if (!saved) return
    target.routes = saved.routes
    if (saved.uplink) target.uplink = saved.uplink
    connection.link.followRoutes()
  }

  /** Identity since the web `local` alias died (dispatch-client step 5):
   *  `LOCAL_SERVER_ID` names only the desktop's registered local target, and
   *  a web client asks for hosts by their real ids. The one other id space is
   *  a host's installation id, which a record in an organization uses to name
   *  the machine that runs a session (cloud-sharing.md §3a): every client of
   *  that machine knows it, so it resolves to this client's id for it. An id
   *  this client has no host for comes back unchanged. */
  resolveId(serverId: string): string {
    if (this.targets.has(serverId) || this.connections.has(serverId)) return serverId
    for (const target of this.targets.values()) {
      if (target.installationId === serverId) return target.id
    }
    return loadServers().find((server) => server.installationId === serverId)?.id ?? serverId
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
      verifyConnectedHost: () => this.verifySavedServerIdentity(target),
      refreshLocalSessionToken: bridge?.refreshSessionToken,
    })
    return this.managedConnection(serverId, target, transport, bridge ? mergeNativeOnlySolusApi(api, bridge.nativeApi) : api, 'present')
  }

  private goneConnection(serverId: string): ManagedConnection {
    const target: SolusServerTarget = { id: serverId, label: serverId, url: '', sessionToken: '', local: false }
    const { api, transport } = createSolusConnection(target)
    transport.destroy('disconnected', new HostGoneError(serverId))
    return this.managedConnection(serverId, target, transport, api, 'gone')
  }

  private managedConnection(serverId: string, target: SolusServerTarget, transport: WsTransport, api: SolusAPI, presence: HostPresence): ManagedConnection {
    let wasReady = false
    const link = new HostLink({
      hostId: serverId,
      transport,
      api: asHostApi(api),
      presence,
      routes: () => target.routes ?? [],
      fallbackRoutes: () => target.fallbackRoutes ?? [],
      clientOrigin: globalThis.location?.origin ?? '',
      localHostId: this.targets.get(LOCAL_SERVER_ID)?.installationId ?? null,
      answersAsHost: (url, signal) => this.answersAsHost(target, url, signal),
      onRouteChange: (url) => {
        target.url = url
        this.healthCache.delete(serverId)
      },
      onAdvertised: (advertised) => {
        if (target.local) return
        const saved = applyAdvertised(serverId, advertised)
        if (!saved) return
        target.routes = saved.routes
        target.identityKey = saved.identityKey
      },
      onOutcome: () => {
        for (const listener of this.dialListeners) listener(serverId)
      },
      onReadinessChange: (readiness, attempt) => {
        if (wasReady && readiness !== 'ready') this.clearConnectionReads(serverId)
        wasReady = readiness === 'ready'
        for (const listener of this.readinessListeners) listener(serverId, readiness, attempt)
        if (readiness === 'ready') this.introducer.run()
      },
    })
    link.facts.subscribe((key) => {
      const version = key === 'capabilities' ? link.facts.value('capabilities')?.version : undefined
      if (version) this.lastHostVersions.set(serverId, version)
    })
    return { serverId, presence, target, link, transport, api, events: link.events, supervisor: link.supervisor, facts: link.facts }
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
      if (awaitsManagedHost(serverId)) this.undialedServerIds.add(serverId)
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
      saved: loadServers(),
      activeOrganizationId: activeWorkspace(loadWorkspaces())?.organizationId ?? null,
      isConnected: (serverId) => this.connections.get(serverId)?.supervisor.readiness === 'ready',
    })
  }

  /** The client machine's own registered host: the desktop's local target.
   *  Null on web — a browser is not a machine that can host. */
  localServerId(): string | null {
    for (const [id, target] of this.targets) {
      if (target.local) return id
    }
    return null
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

  /** The connected hosts where this client is the local owner: only they take part in introductions. */
  private async ownedHosts(): Promise<IntroducerHost[]> {
    const connected = [...this.connections.values()].filter((connection) => connection.presence === 'present' && connection.link.readiness === 'ready')
    const hosts = await Promise.all(connected.map(async (connection): Promise<IntroducerHost | null> => {
      const info = await connection.facts.when('serverInfo').catch(() => null)
      if (info?.principal !== 'local-owner') return null
      const health = await this.probeHealth(connection.serverId)
      return health ? { installationId: health.installationId, label: health.name, api: asHostApi(connection.api) } : null
    }))
    return hosts.filter((host): host is IntroducerHost => host !== null)
  }

  /**
   * Every host there is a live connection to, primary first.
   *
   * "Connected" here means a connection object exists — not that its socket is
   * up. A caller that fans a read out across hosts wants the same set the app is
   * already talking to, and must not conjure sockets to saved-but-unused hosts.
   * A gone host is not one: its connection has no socket.
   */
  connectedServerIds(): string[] {
    const ids = [...this.connections.values()].filter((connection) => connection.presence === 'present').map((connection) => connection.serverId)
    if (!this.primaryServerId) return ids
    return [
      this.primaryServerId,
      ...ids.filter((id) => id !== this.primaryServerId),
    ].filter((id) => this.connections.has(id))
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
    this.connections.delete(serverId)
    this.clearConnectionReads(serverId)
    this.undialedServerIds.delete(serverId)
    this.destroyConnection(connection)
    // A host released because it is gone: its readers rebind to a gone connection.
    if (!this.resolveTarget(serverId)) this.addConnection(this.goneConnection(serverId))
  }

  private destroyConnection(connection: ManagedConnection): void {
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
    if (value?.os) stampHostOperatingSystem(serverId, value.os)
    this.healthCache.set(serverId, { value, expiresAt: Date.now() + CACHE_TTL_MS })
    return value
  }

  async verifySavedServerIdentity(target: SolusServerTarget): Promise<boolean> {
    if (target.local || target.id === LOCAL_SERVER_ID) return true
    const saved = loadServers().find((server) => server.id === target.id)
    // The primary web bootstrap is not necessarily a saved host. There is no
    // durable identity to compare until the user pairs and saves it. A workspace
    // service is never a saved host: its identity is the grant, which the service
    // only admits when it was minted for its audience.
    if (!saved) return true

    const health = await this.probeHealth(target.id, true)
    // Only a successful health response can establish or reject identity. A
    // transient HTTP failure must not turn a working socket into a false match.
    if (!health) return true
    return isSavedHost(saved, health)
  }

  /** Whether `url` answers `/health` as the host this target names, with its proof when the route needs one. No credential is sent. */
  private async answersAsHost(target: SolusServerTarget, url: string, signal: AbortSignal): Promise<boolean> {
    const route = target.routes?.find((candidate) => candidate.url === url) ?? { url }
    const saved = loadServers().find((server) => server.id === target.id)
    // A guest has no saved host: its link's secret opens one resource, and the page names the host.
    if (!saved) return !!(await readHostHealth(fetch, url, signal))
    return answersAsSavedHost(fetch, route, saved, signal)
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
   * (docs/plans/workspace-and-machines.md §6): a registered target, a saved host
   * or workspace service, or a live connection. A host the directory dropped stays
   * present while its connection lives. Anything else is `gone`.
   */
  presenceOf(serverId: string): HostPresence {
    const resolvedId = this.resolveId(serverId)
    if (this.connections.get(resolvedId)?.presence === 'present') return 'present'
    return this.resolveTarget(resolvedId) ? 'present' : 'gone'
  }

  private resolveTarget(serverId: string): SolusServerTarget | null {
    const registered = this.targets.get(serverId)
    if (registered) return registered
    const saved = loadServers().find((server) => server.id === serverId)
    if (saved) return savedServerTarget(saved)
    const workspace = this.savedWorkspaceTarget(serverId)
    if (workspace) return workspace
    // On web the primary target answers for the local id (see `ensure`).
    if (serverId === LOCAL_SERVER_ID && this.primaryServerId) return this.targets.get(this.primaryServerId) ?? null
    return null
  }

  private savedWorkspaceTarget(serverId: string): SolusServerTarget | null {
    const workspace = savedWorkspaceFor(serverId)
    return workspace ? workspaceTarget(workspace) : null
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
