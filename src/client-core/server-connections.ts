import type { SolusAPI } from '../preload'
import { createSolusConnection, savedServerTarget, type SolusServerTarget } from './server-connection'
import {
  installationIdDecision,
  loadServers,
  LOCAL_SERVER_ID,
  stampHostOperatingSystem,
} from './server-registry'
import type { WsTransport, ConnectionStatus } from './ws-transport'
import type { HostEventSubscriber } from './host-event-subscriber'
import { HostSupervisor, type HostPhase } from './host-supervisor'
import { onWakeSignal } from './wake-signals'
import { asHostApi, type HostApi } from './host-api'
import type { HostCapabilities, HostOperatingSystem } from '../shared/types'
import { z } from 'zod'
import {
  normalizeHostCapabilities,
  type HostBooleanCapability,
} from './host-capabilities'

const CACHE_TTL_MS = 60_000
const HEALTH_TIMEOUT_MS = 3_000

export interface ServerHealth {
  ok: boolean
  installationId: string
  name: string
  claimable?: boolean
  os?: HostOperatingSystem
}

// `ok`, `installationId`, and `name` are the identity contract and stay
// required; everything else degrades alone so a newer host's additions never
// null the whole health record and silently stop identity verification.
const serverHealthSchema = z.object({
  ok: z.literal(true),
  installationId: z.string().min(1),
  name: z.string().min(1),
  claimable: z.boolean().optional().catch(undefined),
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
}

type StatusListener = (serverId: string, status: ConnectionStatus, attempt: number) => void
type ConnectionListener = (connection: ManagedConnection) => void
type PhaseListener = (serverId: string, phase: HostPhase, attempt: number) => void

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

export class ServerConnections {
  private readonly connections = new Map<string, ManagedConnection>()
  private readonly targets = new Map<string, SolusServerTarget>()
  private readonly localTokenRefreshers = new Map<string, () => Promise<string>>()
  private readonly statusListeners = new Set<StatusListener>()
  private readonly connectionListeners = new Set<ConnectionListener>()
  private readonly phaseListeners = new Set<PhaseListener>()
  private readonly healthCache = new Map<string, CacheEntry<ServerHealth | null>>()
  private readonly identityCache = new Map<string, CacheEntry<Awaited<ReturnType<SolusAPI['listProjectIdentities']>>>>()
  private readonly retainedServerIds = new Set<string>()
  private primaryServerId: string | null = null

  constructor() {
    // One classified wake stream fans out to every supervisor: N hosts must
    // not mean N window listeners each re-deciding what a wake meant.
    onWakeSignal((signal) => {
      for (const connection of this.connections.values()) {
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
      displaced?.supervisor.destroy()
      displaced?.transport.destroy()
      this.connections.delete(previousPrimaryId)
    }
    // Re-selecting the same saved host creates a fresh transport. Destroy the
    // displaced socket before replacing the map entry or it dials forever
    // with no remaining owner.
    if (existing && existing.transport !== transport) {
      existing.supervisor.destroy()
      existing.transport.destroy()
    }
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
      supervisor: this.superviseTransport(serverId, transport, api),
    }
    this.primaryServerId = serverId
    this.connections.set(serverId, connection)
    this.emitConnectionCreated(connection)
    return connection
  }

  /** Eagerly desire every catalog entry: the registered local/platform target
   *  plus each saved host (dispatch-client step 3). Idempotent — hosts with a
   *  live supervisor are left exactly as they are. */
  startCatalogSupervisors(): void {
    for (const serverId of this.catalogServerIds()) {
      this.ensure(serverId)
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
    this.connections.get(this.resolveId(serverId))?.supervisor.dialNow()
  }

  /** Move the new-work default to another catalog host, in place. Hosts are
   *  symmetric and stay connected (dispatch-client step 5): the displaced
   *  host keeps its supervised socket and every live session on it. */
  setPrimary(serverId: string): void {
    const resolved = this.resolveId(serverId)
    this.ensure(resolved)
    this.primaryServerId = resolved
  }

  private catalogServerIds(): string[] {
    const ids = new Set<string>()
    for (const [id, target] of this.targets) {
      if (target.local) ids.add(id)
    }
    if (this.primaryServerId) ids.add(this.primaryServerId)
    for (const server of loadServers()) ids.add(server.id)
    return [...ids]
  }

  private superviseTransport(serverId: string, transport: WsTransport, api: SolusAPI): HostSupervisor {
    const supervisor = new HostSupervisor({
      transport,
      loadCapabilities: () => api.serverGetCapabilities(),
      onPhaseChange: (phase, attempt) => {
        for (const listener of this.phaseListeners) listener(serverId, phase, attempt)
      },
      // Decorate the legacy status stream with the supervisor's attempt count,
      // which the transport no longer knows.
      onRetryScheduled: (attempt) => {
        const connection = this.connections.get(serverId)
        if (!connection || connection.status === 'connected') return
        this.updateStatus(serverId, connection.status, attempt)
      },
    })
    transport.attachDialOutcomeReporter((outcome) => supervisor.report(outcome))
    return supervisor
  }

  /** Identity since the web `local` alias died (dispatch-client step 5):
   *  `LOCAL_SERVER_ID` names only the desktop's registered local target, and
   *  a web client asks for hosts by their real ids. Kept as the one seam
   *  where an id-space translation could ever live again. */
  resolveId(serverId: string): string {
    return serverId
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
    const connection: ManagedConnection = {
      serverId,
      target,
      transport,
      api,
      events,
      status: 'disconnected',
      attempt: 0,
      supervisor: this.superviseTransport(serverId, transport, api),
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
      connection.supervisor.start()
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

  eventsForApi(api: SolusAPI): HostEventSubscriber {
    for (const connection of this.connections.values()) {
      if (connection.api === api) return connection.events
    }
    throw new Error('Solus API is not owned by a registered server connection')
  }

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
      connection.status = status
      connection.attempt = attempt
    }
    for (const listener of this.statusListeners) listener(serverId, status, attempt)
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
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
    connection.supervisor.destroy()
    connection.transport.destroy()
  }

  statusFor(serverId: string): ConnectionStatus {
    return this.connections.get(this.resolveId(serverId))?.status ?? 'disconnected'
  }

  /** One host's authenticated feature advertisement for its current server
   * session (dispatch-client step 3): loaded once per accepted session,
   * cleared on disconnect. Older hosts reject the method; that is an empty
   * record, never a feature error. */
  capabilitiesFor(serverId: string): Promise<HostCapabilities> {
    return this.ensure(serverId).supervisor.whenCapabilities()
      .then((record) => normalizeHostCapabilities(record))
  }

  /** Synchronous renderer gate. Undefined means no session record yet; a
   * loaded record with an absent key returns false — hide, never probe. */
  capability(serverId: string, key: HostBooleanCapability): boolean | undefined {
    const record = this.cachedCapabilitiesFor(serverId)
    return record ? record[key] === true : undefined
  }

  cachedCapabilitiesFor(serverId: string): HostCapabilities | undefined {
    const record = this.connections.get(this.resolveId(serverId))?.supervisor.capabilities
    return record ? normalizeHostCapabilities(record) : undefined
  }

  async probeHealth(serverId: string, force = false): Promise<ServerHealth | null> {
    serverId = this.resolveId(serverId)
    const cached = this.healthCache.get(serverId)
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value

    const target = this.connections.get(serverId)?.target ?? this.resolveTarget(serverId)
    let value: ServerHealth | null = null
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
    // durable identity to compare until the user pairs and saves it.
    if (!saved) return true

    const health = await this.probeHealth(target.id, true)
    // Only a successful health response can establish or reject identity. A
    // transient HTTP failure must not turn a working socket into a false match.
    if (!health) return true
    return installationIdDecision(saved.installationId, health.installationId) === 'match'
  }

  async projectIdentities(serverId: string, force = false): Promise<Awaited<ReturnType<SolusAPI['listProjectIdentities']>>> {
    serverId = this.resolveId(serverId)
    const cached = this.identityCache.get(serverId)
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value

    const value = await this.apiFor(serverId).listProjectIdentities()
    this.identityCache.set(serverId, { value, expiresAt: Date.now() + CACHE_TTL_MS })
    return value
  }

  private resolveTarget(serverId: string): SolusServerTarget {
    const registered = this.targets.get(serverId)
    if (registered) return registered
    const saved = loadServers().find((server) => server.id === serverId)
    if (saved) return savedServerTarget(saved)
    if (serverId === LOCAL_SERVER_ID) {
      // On web the primary target answers for the local id (see `ensure`).
      const primary = this.primaryServerId ? this.targets.get(this.primaryServerId) : undefined
      if (primary) return primary
      throw new Error('The local Solus target must be registered before it can be used')
    }
    throw new Error(`Unknown Solus server: ${serverId}`)
  }

  private emitConnectionCreated(connection: ManagedConnection): void {
    for (const listener of this.connectionListeners) listener(connection)
  }
}

export const serverConnections = new ServerConnections()
