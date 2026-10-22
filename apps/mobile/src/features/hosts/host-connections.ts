import { HostSupervisor, type BlockedReason, type DialOutcome, type HostPhase, type SupervisedTransport } from '@solus/client-core/host-supervisor'
import type { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { asHostApi, type HostApi } from '@solus/client-core/host-api'
import { HostFacts } from '@solus/client-core/host-facts'
import { HostIntroducer, type IntroducerHost } from '@solus/client-core/host-introducer'
import { awaitsManagedCompute, dialableRoutes, installationIdDecision, nextRouteUrl } from '@solus/client-core/server-registry'
import { chooseRoute, directRouteBack, DIRECT_ROUTE_RECHECK_MS } from '@solus/client-core/route-choice'
import { classifyVisibilityReturn, type WakeSignal } from '@solus/client-core/wake-signals'
import type { ConnectionStatus, WsTransportOptions } from '@solus/client-core/ws-transport'
import { Listeners } from '../../lib/listeners'
import { previewHost } from './lib/pair-input'
import type { HostRegistry, NativeHost } from './host-registry'

/** The part of `WsTransport` this layer drives; tests pass a fake. */
export interface HostTransport extends SupervisedTransport {
  readonly events: HostEventSubscriber
  readonly serverUrl: string
  buildSolusApi(): object
  onReset(callback: () => void): () => void
  attachDialOutcomeReporter(report: (outcome: DialOutcome) => void): void
  switchServerUrl(serverUrl: string): void
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
  /** A five-minute access token for this host, kept until a minute before its end; a host refusal asks for a fresh one. */
  hostAccessToken(host: NativeHost, options?: { fresh?: boolean }): Promise<string | null>
  /** The organization a dial to this host names at its ticket (ADR 0001 §6.4). */
  dialOrganizationId(host: NativeHost): string | null
  /** The organization this device works in; it scopes record reads. */
  organizationId(): string | null
  fetch: typeof fetch
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

/** One host's single transport, supervisor, and event subscription owner. */
export class HostConnection {
  state: HostConnectionState = { phase: 'connecting', attempt: 0, blockedReason: null, sessionGeneration: 0 }
  readonly api: HostApi
  readonly events: HostEventSubscriber
  /** Everything read about this host, shared by every screen (docs/plans/host-model.md). */
  readonly facts: HostFacts
  private readonly resetListeners = new Set<() => void>()
  private readonly acceptedListeners = new Set<() => void>()
  private readonly stopReset: () => void
  /** While the host is reached through its tunnel: the timer that next checks its direct routes. */
  directRecheck: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly hostId: string,
    readonly transport: HostTransport,
    readonly supervisor: HostSupervisor,
  ) {
    this.api = asHostApi(transport.buildSolusApi())
    this.events = transport.events
    this.facts = new HostFacts(hostId, { api: this.api, events: this.events })
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

  dispose(): void {
    this.stopReset()
    this.resetListeners.clear()
    this.acceptedListeners.clear()
    this.supervisor.destroy()
    this.transport.destroy()
    this.facts.dispose()
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

    // Set once the transport and supervisor exist; the callbacks below run later.
    let connection: HostConnection | null = null
    const transport = this.deps.createTransport({
      serverUrl: route.url,
      serverId: host.id,
      sessionToken: this.deps.registry.credential(host.id),
      acquireGrant: host.paired ? undefined : (options) => this.deps.hostAccessToken(host, options),
      dialOrganizationId: host.paired ? undefined : () => this.deps.dialOrganizationId(this.deps.registry.host(host.id) ?? host),
      // A paired host the account also lists is shown the signed-in person's token, so it keeps their delegation (ADR 0001 §6 item 5).
      accountToken: host.paired ? () => this.deps.hostAccessToken(this.deps.registry.host(host.id) ?? host) : undefined,
      onSessionTokenRefreshed: (sessionToken) => { void this.deps.registry.updateCredential(host.id, sessionToken) },
      verifyConnectedHost: () => this.verifyIdentity(host, connection?.transport.serverUrl ?? route.url),
      organizationId: this.deps.organizationId,
    })
    const supervisor = new HostSupervisor({
      transport: { start: () => this.dialBestRoute(host.id, transport), probe: () => transport.probe() },
      // Host facts reload on a fresh server session and clear on a lost one.
      onSessionChange: (change) => connection?.facts.sessionChanged(change),
      onPhaseChange: (phase, attempt) => {
        if (!connection) return
        connection.state = {
          phase,
          attempt,
          blockedReason: supervisor.blockedReason,
          sessionGeneration: supervisor.sessionGeneration,
        }
        this.scheduleDirectRecheck(connection)
        this.changes.notify()
      },
      setTimeoutFn: this.deps.setTimeoutFn,
      clearTimeoutFn: this.deps.clearTimeoutFn,
    })
    const created = new HostConnection(host.id, transport, supervisor)
    connection = created
    // Whether the host is still setting this person up is in its server info (docs/plans/member-isolation.md §8.1).
    created.facts.subscribe((key) => { if (key === 'serverInfo') this.changes.notify() })
    transport.attachDialOutcomeReporter((outcome) => {
      supervisor.report(outcome)
      created.state = { ...created.state, sessionGeneration: supervisor.sessionGeneration, blockedReason: supervisor.blockedReason }
      if (outcome.kind === 'accepted') {
        created.notifyAccepted()
        this.introducer.run()
      }
      // Direct routes come first; a phone away from the host's network reaches it
      // through the tunnel. The supervisor still owns when the next dial happens.
      if (outcome.kind === 'dial-failed') {
        const next = nextRouteUrl(this.deps.registry.host(host.id)?.routes ?? host.routes, transport.serverUrl, '')
        if (next) transport.switchServerUrl(next)
      }
      this.changes.notify()
    })
    this.connections.set(host.id, created)
    supervisor.start()
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
    if (connection) connection.supervisor.dialNow()
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
    for (const connection of this.connections.values()) {
      connection.supervisor.handleWakeSignal(signal)
      // A wake is often a network change: a host reached through its tunnel may be on this network now.
      if (connection.state.phase === 'connected') void this.returnToDirectRoute(connection)
    }
  }

  dispose(hostId: string): void {
    const connection = this.connections.get(hostId)
    this.idleStates.delete(hostId)
    if (!connection) return
    this.clearDirectRecheck(connection)
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

  /** Each dial goes to the route that answers first as this host (`chooseRoute`):
   *  a phone away from the host's network reaches the tunnel without waiting on a dead address. */
  private dialBestRoute(hostId: string, transport: HostTransport): void {
    const dialable = dialableRoutes(this.deps.registry.host(hostId)?.routes ?? [], '')
    if (dialable.length < 2) {
      transport.start()
      return
    }
    void chooseRoute(dialable, (url, signal) => this.answersAsHost(hostId, url, signal), this.timers()).then((route) => {
      if (this.connections.get(hostId)?.transport !== transport) return
      if (route) transport.switchServerUrl(route.url)
      transport.start()
    })
  }

  /** Moves a host reached through its tunnel back to a direct route that answers, and dials it there. */
  private async returnToDirectRoute(connection: HostConnection): Promise<void> {
    const routes = dialableRoutes(this.deps.registry.host(connection.hostId)?.routes ?? [], '')
    const route = await directRouteBack(routes, connection.transport.serverUrl, (url, signal) => this.answersAsHost(connection.hostId, url, signal), this.timers())
    if (!route || this.connections.get(connection.hostId) !== connection || connection.state.phase !== 'connected') return
    connection.transport.switchServerUrl(route.url)
    connection.supervisor.dialNow()
  }

  /** While a host is connected through its tunnel, its direct routes are checked again now and then. */
  private scheduleDirectRecheck(connection: HostConnection): void {
    this.clearDirectRecheck(connection)
    const routes = this.deps.registry.host(connection.hostId)?.routes ?? []
    const current = routes.find((route) => route.url === connection.transport.serverUrl)
    if (connection.state.phase !== 'connected' || current?.kind !== 'tunnel') return
    connection.directRecheck = (this.deps.setTimeoutFn ?? setTimeout)(() => {
      connection.directRecheck = null
      void this.returnToDirectRoute(connection).finally(() => {
        if (this.connections.get(connection.hostId) === connection) this.scheduleDirectRecheck(connection)
      })
    }, DIRECT_ROUTE_RECHECK_MS)
  }

  private clearDirectRecheck(connection: HostConnection): void {
    if (connection.directRecheck) (this.deps.clearTimeoutFn ?? clearTimeout)(connection.directRecheck)
    connection.directRecheck = null
  }

  private timers() {
    return { setTimeoutFn: this.deps.setTimeoutFn, clearTimeoutFn: this.deps.clearTimeoutFn }
  }

  /** Whether `url` answers `/health` as this saved host. No credential is sent. */
  private async answersAsHost(hostId: string, url: string, signal: AbortSignal): Promise<boolean> {
    const host = this.deps.registry.host(hostId)
    if (!host) return false
    const result = await previewHost((input, init) => this.deps.fetch(input, { ...init, signal }), url)
    return result.kind === 'found' && installationIdDecision(host.id, result.preview.installationId, host.uplink) === 'match'
  }

  /** A socket that answers must be the host we saved. Only a successful health
   *  read can reject it; a transient failure does not. */
  private async verifyIdentity(host: NativeHost, url: string): Promise<boolean> {
    const result = await previewHost(this.deps.fetch, url)
    if (result.kind !== 'found') return true
    if (installationIdDecision(host.id, result.preview.installationId, host.uplink) === 'mismatch') return false
    this.deps.registry.touch(host.id, { os: result.preview.os, reportedName: result.preview.name })
    return true
  }
}
