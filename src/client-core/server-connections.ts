import type { SolusAPI } from '../preload'
import { createSolusConnection, savedServerTarget, type SolusServerTarget } from './server-connection'
import {
  installationIdDecision,
  loadServers,
  LOCAL_SERVER_ID,
  stampInstallationId,
  stampHostOperatingSystem,
} from './server-registry'
import type { WsTransport, ConnectionStatus } from './ws-transport'
import type { HostEventSubscriber } from './host-event-subscriber'
import { asHostApi, type HostApi } from './host-api'
import type { HostCapabilities, HostOperatingSystem } from '../shared/types'
import { z } from 'zod'
import {
  normalizeHostCapabilities,
  type HostBooleanCapability,
} from './host-capabilities'

const CACHE_TTL_MS = 60_000
export const HOST_CAPABILITIES_CACHE_TTL_MS = CACHE_TTL_MS
export const HOST_CAPABILITIES_FAILURE_TTL_MS = 5_000
const HEALTH_TIMEOUT_MS = 3_000

export interface ServerHealth {
  ok: boolean
  installationId: string
  name: string
  claimable?: boolean
  os?: HostOperatingSystem
}

const serverHealthSchema = z.object({
  ok: z.literal(true),
  installationId: z.string().min(1),
  name: z.string().min(1),
  claimable: z.boolean().optional(),
  os: z.enum(['macos', 'windows', 'linux']).optional(),
})

export interface ManagedConnection {
  serverId: string
  target: SolusServerTarget
  transport: WsTransport
  api: SolusAPI
  events: HostEventSubscriber
  status: ConnectionStatus
  attempt: number
}

type StatusListener = (serverId: string, status: ConnectionStatus, attempt: number) => void
type ConnectionListener = (connection: ManagedConnection) => void

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
  private readonly healthCache = new Map<string, CacheEntry<ServerHealth | null>>()
  private readonly capabilitiesCache = new Map<string, CacheEntry<HostCapabilities>>()
  private readonly capabilitiesInFlight = new Map<string, Promise<HostCapabilities>>()
  private readonly capabilityGenerations = new Map<string, number>()
  private readonly identityCache = new Map<string, CacheEntry<Awaited<ReturnType<SolusAPI['listProjectIdentities']>>>>()
  private readonly retainedServerIds = new Set<string>()
  private primaryServerId: string | null = null

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
    this.bumpCapabilityGeneration(serverId)
    const resolvedTarget = target ?? this.resolveTarget(serverId)
    this.targets.set(serverId, resolvedTarget)
    const existing = this.connections.get(serverId)
    const previousPrimaryId = this.primaryServerId
    if (previousPrimaryId && previousPrimaryId !== serverId) {
      this.connections.get(previousPrimaryId)?.transport.destroy()
      this.connections.delete(previousPrimaryId)
    }
    // Re-selecting the same saved host creates a fresh transport. Destroy the
    // displaced socket before replacing the map entry or it reconnects forever
    // with no remaining owner.
    if (existing && existing.transport !== transport) existing.transport.destroy()
    const connection: ManagedConnection = {
      serverId,
      target: resolvedTarget,
      transport,
      api,
      events: transport.events,
      status: existing?.status ?? 'disconnected',
      attempt: existing?.attempt ?? 0,
    }
    this.primaryServerId = serverId
    this.connections.set(serverId, connection)
    this.emitConnectionCreated(connection)
    return connection
  }

  /**
   * On a web client no host is "local": the primary connection plays that
   * role, so `LOCAL_SERVER_ID` resolves to it whenever no local target was
   * ever registered. On desktop the local target is registered at boot, so
   * this is the identity function there.
   */
  resolveId(serverId: string): string {
    if (
      serverId === LOCAL_SERVER_ID
      && this.primaryServerId
      && !this.connections.has(serverId)
      && !this.targets.has(serverId)
    ) {
      return this.primaryServerId
    }
    return serverId
  }

  ensure(serverId: string): ManagedConnection {
    serverId = this.resolveId(serverId)
    const existing = this.connections.get(serverId)
    if (existing) return existing

    this.bumpCapabilityGeneration(serverId)
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
      transport.start()
    })
    return connection
  }

  apiFor(serverId: string): HostApi {
    return asHostApi(this.ensure(serverId).api)
  }

  primaryApi(): HostApi {
    const serverId = this.primaryServerId
    if (!serverId) throw new Error('Primary Solus connection has not been registered')
    return asHostApi(this.ensure(serverId).api)
  }

  eventsFor(serverId: string): HostEventSubscriber {
    return this.ensure(serverId).events
  }

  eventsForPrimary(): HostEventSubscriber {
    const serverId = this.primaryServerId
    if (!serverId) throw new Error('Primary Solus connection has not been registered')
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

  connectionFor(serverId?: string): ManagedConnection | undefined {
    const resolvedId = serverId ? this.resolveId(serverId) : this.primaryServerId
    return resolvedId ? this.connections.get(resolvedId) : undefined
  }

  /** HTTP origin paired with a host's WebSocket transport. Signed asset URLs
   *  are relative capabilities and must be opened against this same host. */
  httpOriginFor(serverId: string): string {
    const target = this.ensure(this.resolveId(serverId)).target
    return new URL(target.url).origin
  }

  updateStatus(serverId: string, status: ConnectionStatus, attempt = 0): void {
    const connection = this.connections.get(serverId)
    const previousStatus = connection?.status
    if (status === 'reconnecting' && previousStatus !== 'reconnecting') {
      this.bumpCapabilityGeneration(serverId)
    }
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
    const connection = this.connections.get(serverId)
    if (!connection) return
    this.connections.delete(serverId)
    connection.transport.destroy()
  }

  statusFor(serverId: string): ConnectionStatus {
    return this.connections.get(this.resolveId(serverId))?.status ?? 'disconnected'
  }

  /** Load and cache one host's authenticated feature advertisement. Older
   * hosts reject the method; that is an empty record, never a feature error. */
  capabilitiesFor(serverId: string): Promise<HostCapabilities> {
    serverId = this.resolveId(serverId)
    const cached = this.capabilitiesCache.get(serverId)
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value)
    const pending = this.capabilitiesInFlight.get(serverId)
    if (pending) return pending

    // `ensure` advances the generation for a newly created transport. Do it
    // before capturing the generation so the first probe is not mistaken for
    // an answer from a displaced socket.
    this.ensure(serverId)
    const generation = this.capabilityGenerations.get(serverId) ?? 0
    const promise = this.requestCapabilities(serverId, generation).finally(() => {
      if (this.capabilitiesInFlight.get(serverId) === promise) {
        this.capabilitiesInFlight.delete(serverId)
      }
    })
    this.capabilitiesInFlight.set(serverId, promise)
    return promise
  }

  /** Synchronous renderer gate. Undefined means the advertisement has not
   * loaded (or expired); a loaded record with an absent key returns false. */
  capability(serverId: string, key: HostBooleanCapability): boolean | undefined {
    const cached = this.cachedCapabilitiesFor(serverId)
    return cached ? cached[key] === true : undefined
  }

  cachedCapabilitiesFor(serverId: string): HostCapabilities | undefined {
    serverId = this.resolveId(serverId)
    const cached = this.capabilitiesCache.get(serverId)
    if (!cached || cached.expiresAt <= Date.now()) return undefined
    return cached.value
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
    const decision = installationIdDecision(saved.installationId, health.installationId)
    if (decision === 'mismatch') return false
    if (decision === 'absent') {
      stampInstallationId(saved.id, health.installationId)
      target.installationId = health.installationId
    }
    return true
  }

  async projectIdentities(serverId: string, force = false): Promise<Awaited<ReturnType<SolusAPI['listProjectIdentities']>>> {
    serverId = this.resolveId(serverId)
    const cached = this.identityCache.get(serverId)
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value

    const value = await this.apiFor(serverId).listProjectIdentities()
    this.identityCache.set(serverId, { value, expiresAt: Date.now() + CACHE_TTL_MS })
    return value
  }

  private async requestCapabilities(serverId: string, generation: number): Promise<HostCapabilities> {
    let value: HostCapabilities = {}
    let ttl = HOST_CAPABILITIES_FAILURE_TTL_MS
    try {
      value = normalizeHostCapabilities(await this.apiFor(serverId).serverGetCapabilities())
      ttl = HOST_CAPABILITIES_CACHE_TTL_MS
    } catch {}

    const currentGeneration = this.capabilityGenerations.get(serverId) ?? 0
    if (generation !== currentGeneration) {
      return this.requestCapabilities(serverId, currentGeneration)
    }
    this.capabilitiesCache.set(serverId, { value, expiresAt: Date.now() + ttl })
    return value
  }

  private bumpCapabilityGeneration(serverId: string): void {
    serverId = this.resolveId(serverId)
    this.capabilityGenerations.set(serverId, (this.capabilityGenerations.get(serverId) ?? 0) + 1)
    this.capabilitiesCache.delete(serverId)
    this.capabilitiesInFlight.delete(serverId)
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
