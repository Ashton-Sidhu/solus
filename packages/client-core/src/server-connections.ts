/// <reference types="vite/client" />
import type { ConnectionsServerInfo, SolusAPI } from '@solus/contracts/host-api'
import { createSolusConnection, savedServerTarget, type SolusServerTarget } from './server-connection'
import {
  awaitsManagedCompute,
  chooseRunOnHost,
  dialableRoutes,
  installationIdDecision,
  loadServers,
  LOCAL_SERVER_ID,
  nextRouteUrl,
  savedServerRoutes,
  stampHostOperatingSystem,
} from './server-registry'
import { activeWorkspace, ambiguousOrganizationIds, loadWorkspaces, savedWorkspaceFor, workspaceTarget } from './workspace-registry'
import { solusApiId } from '@solus/contracts/uplink'
import type { WsTransport, ConnectionStatus } from './ws-transport'
import type { HostEventSubscriber } from './host-event-subscriber'
import type { BrowserFrameSubscriber } from './browser-frame-subscriber'
import { HostSupervisor, type HostPhase } from './host-supervisor'
import { onWakeSignal } from './wake-signals'
import { asHostApi, type HostApi } from './host-api'
import type { HostCapabilities, HostOperatingSystem } from '@solus/contracts/types'
import { z } from 'zod'
import { HostFacts } from './host-facts'

const CACHE_TTL_MS = 60_000
const HEALTH_TIMEOUT_MS = 3_000

export interface ServerHealth {
  ok: boolean
  installationId: string
  name: string
  os?: HostOperatingSystem
}

// `ok`, `installationId`, and `name` are the identity contract and stay
// required; everything else degrades alone so a newer host's additions never
// null the whole health record and silently stop identity verification.
const serverHealthSchema = z.object({
  ok: z.literal(true),
  installationId: z.string().min(1),
  name: z.string().min(1),
  os: z.enum(['macos', 'windows', 'linux']).optional().catch(undefined),
})

export interface ManagedConnection {
  serverId: string
  target: SolusServerTarget
  transport: WsTransport
  api: SolusAPI
  events: HostEventSubscriber
  status: ConnectionStatus
  attempt: number
  /** The one owner of this host's connection lifecycle and retry policy. */
  supervisor: HostSupervisor
  /** Everything read about this host, shared by every reader (docs/plans/host-model.md). */
  facts: HostFacts
}

type StatusListener = (serverId: string, status: ConnectionStatus, attempt: number) => void
type ConnectionListener = (connection: ManagedConnection) => void
type PhaseListener = (serverId: string, phase: HostPhase, attempt: number) => void

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
  private readonly localTokenRefreshers = new Map<string, () => Promise<string>>()
  private readonly statusListeners = new Set<StatusListener>()
  private readonly connectionListeners = new Set<ConnectionListener>()
  private readonly phaseListeners = new Set<PhaseListener>()
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
        connection.supervisor.handleWakeSignal(signal)
      }
    })
  }

  registerTarget(target: SolusServerTarget, refreshLocalSessionToken?: () => Promise<string>): void {
    this.targets.set(target.id, target)
    if (refreshLocalSessionToken) this.localTokenRefreshers.set(target.id, refreshLocalSessionToken)
  }

  registerPrimary(
    serverId: string,
    api: SolusAPI,
    transport: WsTransport,
    target?: SolusServerTarget,
  ): ManagedConnection {
    const resolvedTarget = target ?? this.resolveTarget(serverId)
    this.targets.set(serverId, resolvedTarget)
    const existing = this.connections.get(serverId)
    const previousPrimaryId = this.primaryServerId
    if (previousPrimaryId && previousPrimaryId !== serverId) {
      const displaced = this.connections.get(previousPrimaryId)
      if (displaced) this.destroyConnection(displaced)
      this.connections.delete(previousPrimaryId)
      this.clearConnectionReads(previousPrimaryId)
    }
    // Re-selecting the same saved host creates a fresh transport. Destroy the
    // displaced socket before replacing the map entry or it dials forever
    // with no remaining owner.
    if (existing && existing.transport !== transport) {
      this.clearConnectionReads(serverId)
      this.destroyConnection(existing)
    }
    const facts = new HostFacts(serverId, { api: asHostApi(api), events: transport.events })
    const connection: ManagedConnection = {
      serverId,
      target: resolvedTarget,
      transport,
      api,
      events: transport.events,
      status: existing?.status ?? 'disconnected',
      attempt: existing?.attempt ?? 0,
      // The boot-created primary is supervised like everything else; boot's
      // own transport.start() is simply the first dial.
      supervisor: this.superviseTransport(serverId, transport, facts),
      facts,
    }
    this.primaryServerId = serverId
    this.emitPrimaryChange()
    this.connections.set(serverId, connection)
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
        connection.supervisor.start()
      }
    }
  }

  phaseFor(serverId: string): HostPhase | undefined {
    return this.connections.get(this.resolveId(serverId))?.supervisor.phase
  }

  onPhaseChange(listener: PhaseListener): () => void {
    this.phaseListeners.add(listener)
    return () => this.phaseListeners.delete(listener)
  }

  /** User retry: reset the host's ladder and dial now. */
  dialNow(serverId: string): void {
    const resolved = this.resolveId(serverId)
    this.undialedServerIds.delete(resolved)
    this.connections.get(resolved)?.supervisor.dialNow()
  }

  /** Move the new-work default to another catalog host, in place. Hosts are
   *  symmetric and stay connected (dispatch-client step 5): the displaced
   *  host keeps its supervised socket and every live session on it. */
  setPrimary(serverId: string): void {
    const resolved = this.resolveId(serverId)
    this.ensure(resolved)
    this.primaryServerId = resolved
    this.emitPrimaryChange()
  }

  private catalogServerIds(): string[] {
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

  private superviseTransport(serverId: string, transport: WsTransport, facts: HostFacts): HostSupervisor {
    const supervisor = new HostSupervisor({
      transport,
      onSessionChange: (change) => facts.sessionChanged(change),
      onPhaseChange: (phase, attempt) => {
        for (const listener of this.phaseListeners) listener(serverId, phase, attempt)
      },
      // Decorate the legacy status stream with the supervisor's attempt count,
      // which the transport no longer knows.
      onDialFailed: (attempt) => {
        const connection = this.connections.get(serverId)
        if (!connection || connection.status === 'connected') return false
        this.updateStatus(serverId, connection.status, attempt)
        // A failed dial on one route is the cue to try the host's next one (C3).
        return this.advanceRoute(serverId, attempt)
      },
    })
    transport.attachDialOutcomeReporter((outcome) => supervisor.report(outcome))
    return supervisor
  }

  /**
   * Direct-first dialing (docs/plans/personal-uplink.md, C3): a host is dialed on its
   * direct route first and the tunnel is the fallback. The dial is the probe: after a
   * failed one the standing socket is re-aimed at the next route, round-robin, so the
   * supervisor's next dial goes out there — and a host that comes back on the local
   * network is found again on the next miss. Returns true while the run of failed
   * dials has not yet tried every route, so the new one is dialed without waiting:
   * a host away from its LAN reaches its tunnel at once.
   */
  private advanceRoute(serverId: string, attempt: number): boolean {
    const connection = this.connections.get(serverId)
    const routes = connection?.target.routes
    if (!connection || !routes) return false
    const clientOrigin = globalThis.location?.origin ?? ''
    const next = nextRouteUrl(routes, connection.target.url, clientOrigin)
    if (!next) return false
    connection.target.url = next
    connection.transport.switchServerUrl(next)
    this.healthCache.delete(serverId)
    return attempt < dialableRoutes(routes, clientOrigin).length
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
    const routes = savedServerRoutes(saved)
    target.routes = routes
    if (saved.uplink) target.uplink = saved.uplink
    if (routes.some((route) => route.url === target.url)) return
    const [first] = dialableRoutes(routes, globalThis.location?.origin ?? '')
    if (!first) return
    target.url = first.url
    connection.transport.switchServerUrl(first.url)
    this.healthCache.delete(connection.serverId)
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

  ensure(serverId: string): ManagedConnection {
    serverId = this.resolveId(serverId)
    const existing = this.connections.get(serverId)
    if (existing) return existing

    const target = this.resolveTarget(serverId)
    const { api, transport, events } = createSolusConnection(target, {
      onStatusChange: (status, attempt) => this.updateStatus(serverId, status, attempt),
      verifyConnectedHost: () => this.verifySavedServerIdentity(target),
      refreshLocalSessionToken: this.localTokenRefreshers.get(serverId),
    })
    const facts = new HostFacts(serverId, { api: asHostApi(api), events })
    const connection: ManagedConnection = {
      serverId,
      target,
      transport,
      api,
      events,
      status: 'disconnected',
      attempt: 0,
      supervisor: this.superviseTransport(serverId, transport, facts),
      facts,
    }
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
      if (awaitsManagedHost(serverId)) this.undialedServerIds.add(serverId)
      else connection.supervisor.start()
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
      isConnected: (serverId) => this.connections.get(serverId)?.supervisor.phase === 'connected',
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

  /**
   * Every host there is a live connection to, primary first.
   *
   * "Connected" here means a connection object exists — not that its socket is
   * up. A caller that fans a read out across hosts wants the same set the app is
   * already talking to, and must not conjure sockets to saved-but-unused hosts.
   */
  connectedServerIds(): string[] {
    const ids = [...this.connections.keys()]
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
    return new URL(target.url).origin
  }

  updateStatus(serverId: string, status: ConnectionStatus, attempt = 0): void {
    const connection = this.connections.get(serverId)
    if (connection) {
      if (connection.status === 'connected' && status !== 'connected') this.clearConnectionReads(serverId)
      connection.status = status
      connection.attempt = attempt
    }
    for (const listener of this.statusListeners) listener(serverId, status, attempt)
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
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
    if (!connection) return
    this.connections.delete(serverId)
    this.clearConnectionReads(serverId)
    this.undialedServerIds.delete(serverId)
    this.destroyConnection(connection)
  }

  private destroyConnection(connection: ManagedConnection): void {
    connection.supervisor.destroy()
    connection.transport.destroy()
    connection.facts.dispose()
  }

  statusFor(serverId: string): ConnectionStatus {
    return this.connections.get(this.resolveId(serverId))?.status ?? 'disconnected'
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
    let value: ServerHealth | null = null
    // A host the directory lists with no route yet has nothing to ask; `/health` alone is this page's origin.
    if (!target.url) return null
    try {
      const response = await fetch(`${target.url}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
      if (response.ok) {
        const body = serverHealthSchema.safeParse(await response.json())
        if (body.success) {
          value = body.data
          if (body.data.os) stampHostOperatingSystem(serverId, body.data.os)
        }
      }
    } catch {}
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
    return installationIdDecision(saved.installationId, health.installationId, saved.uplink) === 'match'
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
   * Whether `serverId` names a host this client can reach: the ids
   * `resolveTarget` answers for, without the throw. A stored id that fails is a
   * host that was deleted or never listed here (docs/plans/workspace-and-machines.md §6);
   * a caller reads nothing from it rather than asking `apiFor`.
   */
  isKnownServer(serverId: string): boolean {
    if (this.connections.has(serverId) || this.targets.has(serverId)) return true
    if (loadServers().some((server) => server.id === serverId)) return true
    if (this.savedWorkspaceTarget(serverId)) return true
    return serverId === LOCAL_SERVER_ID && !!this.primaryServerId && this.targets.has(this.primaryServerId)
  }

  private resolveTarget(serverId: string): SolusServerTarget {
    const registered = this.targets.get(serverId)
    if (registered) return registered
    const saved = loadServers().find((server) => server.id === serverId)
    if (saved) return savedServerTarget(saved)
    const workspace = this.savedWorkspaceTarget(serverId)
    if (workspace) return workspace
    if (serverId === LOCAL_SERVER_ID) {
      // On web the primary target answers for the local id (see `ensure`).
      const primary = this.primaryServerId ? this.targets.get(this.primaryServerId) : undefined
      if (primary) return primary
      throw new Error('The local Solus target must be registered before it can be used')
    }
    throw new Error(`Unknown Solus server: ${serverId}`)
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
