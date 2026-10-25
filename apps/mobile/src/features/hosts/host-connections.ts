import type { HostSupervisor } from '@solus/client-core/host-supervisor'
import type { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { asHostApi, type HostApi } from '@solus/client-core/host-api'
import type { HostFact, HostFacts } from '@solus/client-core/host-facts'
import type { HostDiagnostics } from '@solus/client-core/host-diagnostics'
import { HostIntroducer, type IntroducerHost } from '@solus/client-core/host-introducer'
import { HostLink, isSavedHost, readHostHealth, type LinkTransport } from '@solus/client-core/host-link'
import { CHECKING_HOST, GONE_HOST, type HostReadinessState } from '@solus/client-core/host-readiness'
import { awaitsManagedCompute, dialableRoutes, managedHostNeedsStart } from '@solus/client-core/server-registry'
import { classifyVisibilityReturn, type WakeSignal } from '@solus/client-core/wake-signals'
import type { ConnectionStatus, WsTransport, WsTransportOptions } from '@solus/client-core/ws-transport'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import { permissionsAllow, type Permission } from '@solus/contracts/permissions'
import { Listeners } from '../../lib/listeners'
import type { HostRegistry, NativeHost } from './host-registry'

/** How long a `/health` read for a host's identity may take. */
const HEALTH_TIMEOUT_MS = 5_000

/** The part of `WsTransport` this layer drives; tests pass a fake. */
export interface HostTransport extends LinkTransport, Pick<WsTransport, 'onServerRequest'> {
  buildSolusApi(): object
  onReset(callback: () => void): () => void
  destroy(finalStatus?: ConnectionStatus): void
}

/** A host's readiness (docs/plans/host-readiness.md) and the link counters screens key caches to. */
export interface HostConnectionState extends HostReadinessState {
  attempt: number
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
  /** This build's version, as About shows it; diagnostics name it. */
  clientVersion: string
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

/** One host's link (transport, supervisor, route choice, facts) and its event subscription owner. */
export class HostConnection {
  state: HostConnectionState = { ...CHECKING_HOST, attempt: 0, sessionGeneration: 0 }
  readonly api: HostApi
  readonly events: HostEventSubscriber
  readonly transport: HostTransport
  readonly supervisor: HostSupervisor
  /** Everything read about this host, shared by every screen (docs/plans/host-model.md). */
  readonly facts: HostFacts
  /** The host's Solus version when it was last read. Capabilities are cleared
   *  when the host drops; diagnostics still name the version it had. */
  hostVersion: string | null = null
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
    const readiness = this.link.readiness
    this.state = {
      readiness,
      away: this.link.away,
      unreachableReason: readiness === 'unreachable' ? 'no-answer' : null,
      refusedReason: readiness === 'refused' ? this.link.refusedReason : null,
      lastSeenAt: this.link.lastSeenAt,
      attempt: this.link.attempt,
      sessionGeneration: this.link.sessionGeneration,
    }
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
  /** The last diagnostics read per host, so a screen that reads them on each change sees the same object. */
  private readonly lastDiagnostics = new Map<string, HostDiagnostics>()
  readonly changes = new Listeners()
  private hiddenAt: number | null = null
  /** Introduces the hosts this phone owns to each other (docs/plans/host-reach.md §4). */
  private readonly introducer = new HostIntroducer(() => this.ownedHosts())

  constructor(private readonly deps: HostConnectionsDeps) {
    deps.registry.onHostRemoved((hostId) => this.dispose(hostId))
  }

  /** The host's connection, dialed on first use. Null while a managed host's
   *  compute is not ready or the host has no route yet: its readiness then says why. */
  connection(hostId: string): HostConnection | null {
    const existing = this.connections.get(hostId)
    if (existing) return existing
    const host = this.deps.registry.host(hostId)
    if (!host) return null
    const [route] = dialableRoutes(host.routes, '')
    if (awaitsManagedCompute(host.uplink) || !route) return this.idle(hostId, undialedReadiness(host))
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
      onReadinessChange: () => {
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
    created.facts.subscribe((key) => {
      if (key === 'serverInfo') this.changes.notify()
      if (key === 'capabilities') created.hostVersion = created.facts.value('capabilities')?.version ?? created.hostVersion
    })
    this.connections.set(host.id, created)
    link.start()
    return created
  }

  /** The connected hosts where this phone is the local owner. */
  private async ownedHosts(): Promise<IntroducerHost[]> {
    const connected = [...this.connections.values()].filter((connection) => connection.state.readiness === 'ready')
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
    if (connection?.state.readiness !== 'ready') return false
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

  /** The host's link state; null before it is first dialed. */
  state(hostId: string): HostConnectionState | null {
    return this.connections.get(hostId)?.state ?? this.idleStates.get(hostId) ?? null
  }

  /** Whether this phone can do work on the host now (docs/plans/host-readiness.md).
   *  A host the registry no longer holds is `gone`; one with no link yet reads
   *  its managed state and routes. */
  readiness(hostId: string): HostReadinessState {
    const host = this.deps.registry.host(hostId)
    if (!host) return GONE_HOST
    return this.connections.get(hostId)?.state ?? undialedReadiness(host)
  }

  /**
   * Why the host is not ready, for the screen and for a support message
   * (docs/plans/host-readiness.md). It reads the link and never dials. The same
   * object comes back until one of its values changes.
   */
  diagnostics(hostId: string): HostDiagnostics {
    const host = this.deps.registry.host(hostId)
    const connection = this.connections.get(hostId)
    const next: HostDiagnostics = {
      hostId: host?.uplink?.hostId ?? hostId,
      label: host?.label ?? 'This host',
      // A directory host has its own id; a paired host's id is its installation id.
      installationId: host?.uplink ? host.id : null,
      state: this.readiness(hostId),
      dialedUrl: connection?.transport.serverUrl ?? null,
      routes: host?.routes ?? NO_ROUTES,
      attempt: connection?.link.attempt ?? 0,
      lastDialError: connection?.transport.lastDialError ?? null,
      hostVersion: connection?.hostVersion ?? null,
      clientVersion: this.deps.clientVersion,
    }
    const previous = this.lastDiagnostics.get(hostId)
    if (previous && (Object.keys(next) as (keyof HostDiagnostics)[]).every((key) => previous[key] === next[key])) return previous
    this.lastDiagnostics.set(hostId, next)
    return next
  }

  /** A user retry: the ladder resets and the host is dialed now. */
  retry(hostId: string): void {
    const connection = this.connections.get(hostId)
    if (connection?.state.refusedReason === 'auth') {
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
    this.lastDiagnostics.delete(hostId)
    if (!connection) return
    this.connections.delete(hostId)
    connection.dispose()
    this.changes.notify()
  }

  disposeAll(): void {
    for (const hostId of Array.from(this.connections.keys())) this.dispose(hostId)
  }

  private idle(hostId: string, readiness: HostReadinessState): null {
    const previous = this.idleStates.get(hostId)
    if (previous?.readiness !== readiness.readiness || previous.unreachableReason !== readiness.unreachableReason) {
      this.idleStates.set(hostId, { ...readiness, attempt: 0, sessionGeneration: 0 })
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

const NO_ROUTES: readonly HostDiagnostics['routes'][number][] = []

// Shared objects, so a screen that reads readiness on each change sees the same value.
const NOT_RUNNING: HostReadinessState = { readiness: 'unreachable', away: true, unreachableReason: 'not-running', refusedReason: null, lastSeenAt: null }
const NO_ADDRESS: HostReadinessState = { readiness: 'unreachable', away: true, unreachableReason: 'no-address', refusedReason: null, lastSeenAt: null }

/**
 * A host with no link: a managed host Solus Cloud has not made ready is
 * `checking` while it is set up or started, `unreachable` while it must be
 * started, and `gone` while it is deleted. A host with no route has no address.
 * Any other host is about to be dialed.
 */
function undialedReadiness(host: NativeHost): HostReadinessState {
  if (awaitsManagedCompute(host.uplink)) {
    const lifecycle = host.uplink?.managedState
    if (managedHostNeedsStart(lifecycle)) return NOT_RUNNING
    return lifecycle === 'deleting' ? GONE_HOST : CHECKING_HOST
  }
  return dialableRoutes(host.routes, '').length ? CHECKING_HOST : NO_ADDRESS
}

/** Whether a host's server info grants a permission; the owner's standing until it answers. */
export function serverInfoAllows(fact: HostFact<Pick<ConnectionsServerInfo, 'permissions' | 'principal'>>, permission: Permission): boolean {
  if (fact.state !== 'ready') return true
  if (Array.isArray(fact.value.permissions)) return permissionsAllow(fact.value.permissions, permission)
  // A host that sends no permissions gives a local owner's standing to its local owner only.
  return fact.value.principal === 'local-owner'
}
