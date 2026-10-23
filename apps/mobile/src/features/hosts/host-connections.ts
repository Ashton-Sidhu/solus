import type { BlockedReason, HostPhase, HostSupervisor } from '@solus/client-core/host-supervisor'
import type { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { asHostApi, type HostApi } from '@solus/client-core/host-api'
import type { HostFact, HostFacts } from '@solus/client-core/host-facts'
import { HostIntroducer, type IntroducerHost } from '@solus/client-core/host-introducer'
import { HostLink, isSavedHost, readHostHealth, type LinkTransport } from '@solus/client-core/host-link'
import { awaitsManagedCompute, dialableRoutes } from '@solus/client-core/server-registry'
import { classifyVisibilityReturn, type WakeSignal } from '@solus/client-core/wake-signals'
import type { ConnectionStatus, WsTransportOptions } from '@solus/client-core/ws-transport'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import { permissionsAllow, type Permission } from '@solus/contracts/permissions'
import { Listeners } from '../../lib/listeners'
import type { HostRegistry, NativeHost } from './host-registry'

/** How long a `/health` read for a host's identity may take. */
const HEALTH_TIMEOUT_MS = 5_000

/** The part of `WsTransport` this layer drives; tests pass a fake. */
export interface HostTransport extends LinkTransport {
  buildSolusApi(): object
  onReset(callback: () => void): () => void
  destroy(finalStatus?: ConnectionStatus): void
}

export type HostConnectionPhase = HostPhase | 'waiting-for-compute' | 'no-route'

export interface HostConnectionState {
  phase: HostConnectionPhase
  attempt: number
  blockedReason: BlockedReason | null
  /** Bumps on each accepted connection that did not recover the previous
   *  server session. A cache keyed to it is stale when it changes. */
  sessionGeneration: number
}

export interface HostConnectionsDeps {
  registry: HostRegistry
  createTransport(options: WsTransportOptions): HostTransport
  /** An access token for this host, kept until a minute before its end; `refused` names a kept one the host refused. */
  hostAccessToken(host: NativeHost, options?: { refused?: string }): Promise<string | null>
  /** True when the phone holds no sign-in: a directory host is then blocked until the next one. */
  isSignedOut(): boolean
  /** The organization a dial to this host names in its handshake (ADR 0001 §6.4). */
  dialOrganizationId(host: NativeHost): string | null
  /** The organization this device works in; it scopes record reads. */
  organizationId(): string | null
  fetch: typeof fetch
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

/** One host's link (transport, supervisor, route choice, facts) and its event subscription owner. */
export class HostConnection {
  state: HostConnectionState = { phase: 'connecting', attempt: 0, blockedReason: null, sessionGeneration: 0 }
  readonly api: HostApi
  readonly events: HostEventSubscriber
  readonly transport: HostTransport
  readonly supervisor: HostSupervisor
  /** Everything read about this host, shared by every screen (docs/plans/host-model.md). */
  readonly facts: HostFacts
  private readonly resetListeners = new Set<() => void>()
  private readonly acceptedListeners = new Set<() => void>()
  private readonly stopReset: () => void

  constructor(
    readonly hostId: string,
    readonly link: HostLink,
    transport: HostTransport,
  ) {
    this.transport = transport
    this.api = link.api
    this.events = link.events
    this.supervisor = link.supervisor
    this.facts = link.facts
    this.stopReset = transport.onReset(() => {
      for (const listener of Array.from(this.resetListeners)) listener()
    })
  }

  /** A fresh server session after a reconnect that did not recover the old one.
   *  Watches and runtime state must be rebuilt (`recovery: 'reset'` topics). */
  onReset(listener: () => void): () => void {
    this.resetListeners.add(listener)
    return () => { this.resetListeners.delete(listener) }
  }

  /** Every accepted connection: the moment queued sends may drain. */
  onAccepted(listener: () => void): () => void {
    this.acceptedListeners.add(listener)
    return () => { this.acceptedListeners.delete(listener) }
  }

  notifyAccepted(): void {
    for (const listener of Array.from(this.acceptedListeners)) listener()
  }

  /** The link's state as screens read it. */
  syncState(): void {
    this.state = { phase: this.link.phase, attempt: this.link.attempt, blockedReason: this.link.blockedReason, sessionGeneration: this.link.sessionGeneration }
  }

  dispose(): void {
    this.stopReset()
    this.resetListeners.clear()
    this.acceptedListeners.clear()
    this.link.destroy()
  }
}

export class HostConnections {
  private readonly connections = new Map<string, HostConnection>()
  private readonly idleStates = new Map<string, HostConnectionState>()
  readonly changes = new Listeners()
  private hiddenAt: number | null = null
  /** Introduces the hosts this phone owns to each other (docs/plans/host-reach.md §4). */
  private readonly introducer = new HostIntroducer(() => this.ownedHosts())

  constructor(private readonly deps: HostConnectionsDeps) {
    deps.registry.onHostRemoved((hostId) => this.dispose(hostId))
  }

  /** The host's connection, dialed on first use. Null while a managed host's
   *  compute is not ready or the host has no route yet. */
  connection(hostId: string): HostConnection | null {
    const existing = this.connections.get(hostId)
    if (existing) return existing
    const host = this.deps.registry.host(hostId)
    if (!host) return null
    if (awaitsManagedCompute(host.uplink)) return this.idle(hostId, 'waiting-for-compute')
    const [route] = dialableRoutes(host.routes, '')
    if (!route) return this.idle(hostId, 'no-route')
    this.idleStates.delete(hostId)

    // Set once the link exists; the callbacks below run later.
    let connection: HostConnection | null = null
    const transport = this.deps.createTransport({
      serverUrl: route.url,
      serverId: host.id,
      sessionToken: this.deps.registry.credential(host.id),
      grants: host.paired ? undefined : { acquire: (options) => this.deps.hostAccessToken(this.deps.registry.host(host.id) ?? host, options), isSignedOut: () => this.deps.isSignedOut() },
      dialOrganizationId: host.paired ? undefined : () => this.deps.dialOrganizationId(this.deps.registry.host(host.id) ?? host),
      // A paired host the account also lists is shown the signed-in person's token, so it keeps their delegation (ADR 0001 §6 item 5).
      accountToken: host.paired ? () => this.deps.hostAccessToken(this.deps.registry.host(host.id) ?? host) : undefined,
      onSessionTokenRefreshed: (sessionToken) => { void this.deps.registry.updateCredential(host.id, sessionToken) },
      verifyConnectedHost: () => this.verifyIdentity(host.id, connection?.transport.serverUrl ?? route.url),
      organizationId: this.deps.organizationId,
    })
    const link = new HostLink({
      hostId: host.id,
      transport,
      api: asHostApi(transport.buildSolusApi()),
      routes: () => this.deps.registry.host(host.id)?.routes ?? [],
      answersAsHost: (url, signal) => this.answersAsHost(host.id, url, signal),
      onPhaseChange: () => {
        if (!connection) return
        connection.syncState()
        this.changes.notify()
      },
      onOutcome: (outcome) => {
        if (!connection) return
        connection.syncState()
        if (outcome.kind === 'accepted') {
          connection.notifyAccepted()
          this.introducer.run()
        }
        this.changes.notify()
      },
      setTimeoutFn: this.deps.setTimeoutFn,
      clearTimeoutFn: this.deps.clearTimeoutFn,
    })
    const created = new HostConnection(host.id, link, transport)
    connection = created
    // Whether the host is still setting this person up is in its server info (docs/plans/member-isolation.md §8.1).
    created.facts.subscribe((key) => { if (key === 'serverInfo') this.changes.notify() })
    this.connections.set(host.id, created)
    link.start()
    return created
  }

  /** The connected hosts where this phone is the local owner. */
  private async ownedHosts(): Promise<IntroducerHost[]> {
    const connected = [...this.connections.values()].filter((connection) => connection.state.phase === 'connected')
    const hosts = await Promise.all(connected.map(async (connection): Promise<IntroducerHost | null> => {
      const info = await connection.facts.when('serverInfo').catch(() => null)
      const host = this.deps.registry.host(connection.hostId)
      return info?.principal === 'local-owner' && host ? { installationId: host.id, label: host.label, api: connection.api } : null
    }))
    return hosts.filter((host): host is IntroducerHost => host !== null)
  }

  /** The connected host is still making this person's Linux user and folders (docs/plans/member-isolation.md §8.1). */
  isPreparing(hostId: string): boolean {
    const connection = this.connections.get(hostId)
    if (connection?.state.phase !== 'connected') return false
    connection.facts.ensure('serverInfo')
    const fact = connection.facts.get('serverInfo')
    return fact.state === 'ready' && fact.value.memberWorkspace === 'preparing'
  }

  /**
   * Whether this phone holds a permission on the host, as desktop's
   * `HostStanding` answers: the owner's standing until the host answers, so
   * an owner's controls do not flicker on (docs/plans/permissions.md §4).
   */
  may(hostId: string, permission: Permission): boolean {
    const connection = this.connections.get(hostId)
    if (!connection) return true
    connection.facts.ensure('serverInfo')
    return serverInfoAllows(connection.facts.get('serverInfo'), permission)
  }

  state(hostId: string): HostConnectionState | null {
    return this.connections.get(hostId)?.state ?? this.idleStates.get(hostId) ?? null
  }

  /** A user retry: the ladder resets and the host is dialed now. */
  retry(hostId: string): void {
    const connection = this.connections.get(hostId)
    if (connection?.state.blockedReason === 'auth') {
      // An auth block needs a new transport: the old one refuses every call.
      this.dispose(hostId)
      this.connection(hostId)
      return
    }
    if (connection) connection.link.dialNow()
    else this.connection(hostId)
  }

  /** The app left the foreground. */
  suspend(now: number): void {
    this.hiddenAt = now
  }

  /** The app returned. A long suspension is a resume: the socket did not
   *  survive it, so every host is probed or dialed now. */
  resume(now: number): void {
    const suspendedMs = this.hiddenAt === null ? 0 : now - this.hiddenAt
    this.hiddenAt = null
    this.wake(classifyVisibilityReturn(suspendedMs))
  }

  wake(signal: WakeSignal): void {
    for (const connection of this.connections.values()) connection.link.wake(signal)
  }

  dispose(hostId: string): void {
    const connection = this.connections.get(hostId)
    this.idleStates.delete(hostId)
    if (!connection) return
    this.connections.delete(hostId)
    connection.dispose()
    this.changes.notify()
  }

  disposeAll(): void {
    for (const hostId of Array.from(this.connections.keys())) this.dispose(hostId)
  }

  private idle(hostId: string, phase: 'waiting-for-compute' | 'no-route'): null {
    const previous = this.idleStates.get(hostId)
    if (previous?.phase !== phase) {
      this.idleStates.set(hostId, { phase, attempt: 0, blockedReason: null, sessionGeneration: 0 })
      this.changes.notify()
    }
    return null
  }

  /** Whether `url` answers `/health` as this saved host. No credential is sent. */
  private async answersAsHost(hostId: string, url: string, signal: AbortSignal): Promise<boolean> {
    const host = this.deps.registry.host(hostId)
    const health = host ? await readHostHealth(this.deps.fetch, url, signal) : null
    return !!host && !!health && isSavedHost({ installationId: host.id, uplink: host.uplink }, health)
  }

  /** A socket that answers must be the host we saved. Only a successful health
   *  read can reject it; a transient failure does not. */
  private async verifyIdentity(hostId: string, url: string): Promise<boolean> {
    const host = this.deps.registry.host(hostId)
    const health = host ? await readHostHealth(this.deps.fetch, url, AbortSignal.timeout(HEALTH_TIMEOUT_MS)) : null
    if (!host || !health) return true
    if (!isSavedHost({ installationId: host.id, uplink: host.uplink }, health)) return false
    this.deps.registry.touch(host.id, { os: health.os, reportedName: health.name })
    return true
  }
}

/** Whether a host's server info grants a permission; the owner's standing until it answers. */
export function serverInfoAllows(fact: HostFact<Pick<ConnectionsServerInfo, 'permissions' | 'principal'>>, permission: Permission): boolean {
  if (fact.state !== 'ready') return true
  if (Array.isArray(fact.value.permissions)) return permissionsAllow(fact.value.permissions, permission)
  // A host that sends no permissions gives a local owner's standing to its local owner only.
  return fact.value.principal === 'local-owner'
}
