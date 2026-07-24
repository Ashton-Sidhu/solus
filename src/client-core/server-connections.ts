import type { SolusAPI } from '../preload'
import { createSolusConnection, savedServerTarget, type SolusServerTarget } from './server-connection'
import { loadServers, LOCAL_SERVER_ID } from './server-registry'
import type { WsTransport, ConnectionStatus } from './ws-transport'

const CACHE_TTL_MS = 60_000
const HEALTH_TIMEOUT_MS = 3_000

export interface ServerHealth {
  ok: boolean
  installationId: string
  name: string
  claimable?: boolean
}

export interface ManagedConnection {
  serverId: string
  target: SolusServerTarget
  transport: WsTransport
  api: SolusAPI
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
    const resolvedTarget = target ?? this.resolveTarget(serverId)
    this.targets.set(serverId, resolvedTarget)
    const existing = this.connections.get(serverId)
    const previousPrimaryId = this.primaryServerId
    if (previousPrimaryId && previousPrimaryId !== serverId) {
      this.connections.get(previousPrimaryId)?.transport.destroy()
      this.connections.delete(previousPrimaryId)
    }
    const connection: ManagedConnection = {
      serverId,
      target: resolvedTarget,
      transport,
      api,
      status: existing?.status ?? 'disconnected',
      attempt: existing?.attempt ?? 0,
    }
    this.primaryServerId = serverId
    this.connections.set(serverId, connection)
    this.emitConnectionCreated(connection)
    return connection
  }

  ensure(serverId: string): ManagedConnection {
    const existing = this.connections.get(serverId)
    if (existing) return existing

    const target = this.resolveTarget(serverId)
    const { api, transport } = createSolusConnection(target, {
      onStatusChange: (status, attempt) => this.updateStatus(serverId, status, attempt),
      refreshLocalSessionToken: this.localTokenRefreshers.get(serverId),
    })
    const connection: ManagedConnection = {
      serverId,
      target,
      transport,
      api,
      status: 'disconnected',
      attempt: 0,
    }
    this.connections.set(serverId, connection)
    this.emitConnectionCreated(connection)
    transport.start()
    return connection
  }

  apiFor(serverId?: string): SolusAPI {
    const resolvedId = serverId ?? this.primaryServerId
    if (!resolvedId) throw new Error('Primary Solus connection has not been registered')
    return this.ensure(resolvedId).api
  }

  connectionFor(serverId?: string): ManagedConnection | undefined {
    const resolvedId = serverId ?? this.primaryServerId
    return resolvedId ? this.connections.get(resolvedId) : undefined
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
    const connection = this.connections.get(serverId)
    if (!connection) return
    this.connections.delete(serverId)
    connection.transport.destroy()
  }

  statusFor(serverId: string): ConnectionStatus {
    return this.connections.get(serverId)?.status ?? 'disconnected'
  }

  async probeHealth(serverId: string, force = false): Promise<ServerHealth | null> {
    const cached = this.healthCache.get(serverId)
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value

    const target = this.connections.get(serverId)?.target ?? this.resolveTarget(serverId)
    let value: ServerHealth | null = null
    try {
      const response = await fetch(`${target.url}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
      if (response.ok) {
        const body = await response.json() as Partial<ServerHealth>
        if (body.ok && body.installationId && body.name) value = body as ServerHealth
      }
    } catch {}
    this.healthCache.set(serverId, { value, expiresAt: Date.now() + CACHE_TTL_MS })
    return value
  }

  async projectIdentities(serverId: string, force = false): Promise<Awaited<ReturnType<SolusAPI['listProjectIdentities']>>> {
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
      throw new Error('The local Solus target must be registered before it can be used')
    }
    throw new Error(`Unknown Solus server: ${serverId}`)
  }

  private emitConnectionCreated(connection: ManagedConnection): void {
    for (const listener of this.connectionListeners) listener(connection)
  }
}

export const serverConnections = new ServerConnections()
