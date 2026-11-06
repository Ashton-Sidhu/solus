import { chooseRoute, dialableRoutes, earlierRouteBack, EARLIER_ROUTE_RECHECK_MS, ROUTE_HOLD_BACK_MS, type DialChoices, type HostRoute, type RouteCheck } from '@solus/contracts/host-routes'
import { newHealthNonce, routeNeedsProof } from '@solus/contracts/host-identity'
import type { HostApi } from './host-api'
import type { HostEventSubscriber } from './host-event-subscriber'
import { HostFacts, type HostPresence } from './host-facts'
import { HostSupervisor, type DialOutcome } from './host-supervisor'
import type { LinkReadiness, RefusedReason } from './host-readiness'
import type { DialError } from './host-diagnostics'
import { installationIdDecision, type SavedServerUplink } from './server-registry'
import type { WakeSignal } from './wake-signals'
import { readHostHealth, type HostHealth } from './host-http'

/**
 * One host's link (docs/plans/simplify-auth-and-sync.md §3 rule 7, §4.4): its
 * transport, the supervisor that owns when it dials, the route each dial goes to,
 * and the facts read over it. Web, desktop (`ServerConnections`), and mobile
 * (`HostConnections`) each hold one per host and share this one route policy:
 *
 * - every dial goes to the route `chooseRoute` picks, all routes checked at once;
 *   with one route, the dial goes out at once and the identity check runs beside it;
 * - a dial whose route was just picked does not check the host's identity again;
 * - the socket's own short connect timeout ends a dial on a route that stopped
 *   answering, and the supervisor's ladder dials again, through `chooseRoute`;
 * - while a host is reached on a route that is not its first, the earlier routes are
 *   checked again now and then, at each wake, and when the order changes, and the
 *   link moves back when one answers;
 * - a route that answered but did not connect is passed over for a while, so a proxy
 *   that passes `/health` and refuses the socket does not strand a working host;
 * - a fallback route (a guest's read-only mirror) is dialed only when no route of
 *   the host itself answers, and each later dial asks the host's routes first again.
 */

/** The part of `WsTransport` a link drives; tests pass a fake. */
export interface LinkTransport {
  readonly events: HostEventSubscriber
  readonly serverUrl: string
  start(options?: { hostConfirmed?: boolean }): void
  probe(): Promise<void>
  switchServerUrl(serverUrl: string): void
  attachDialOutcomeReporter(report: (outcome: DialOutcome) => void): void
  setUnreachable(unreachable: boolean): void
  /** How the last dial failed; absent on a transport that does not say. */
  readonly lastDialError?: DialError | null
  destroy(): void
}

export interface HostLinkOptions {
  hostId: string
  transport: LinkTransport
  api: HostApi
  /** The host's routes now; the directory can change them while the link lives. */
  routes(): readonly HostRoute[]
  /** Routes dialed only when none of `routes` answers: a guest's read-only mirror. */
  fallbackRoutes?(): readonly HostRoute[]
  /** The person's choices about these routes (docs/plans/host-routes.md §12). */
  dialChoices?(): DialChoices
  /** Whether a route answers `/health` as this host. Never rejects. */
  answersAsHost: RouteCheck
  /** The page's origin: an `https:` page cannot dial an `http:` route. Empty for a native client. */
  clientOrigin?: string
  /** This machine's installation id, when it hosts a Solus server: only it can dial a forward it holds. */
  localHostId?: string | null
  /** `gone`: this client does not know the host. The link never dials. */
  presence?: HostPresence
  onReadinessChange?: (readiness: LinkReadiness, attempt: number) => void
  /** Every dial outcome, after the supervisor has acted on it. */
  onOutcome?: (outcome: DialOutcome) => void
  /** The link moved to another route. */
  onRouteChange?: (url: string) => void
  /** The host said where it is reached and which key it signs with (docs/plans/host-routes.md D2). */
  onAdvertised?: (advertised: AdvertisedHost) => void
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

export class HostLink {
  readonly hostId: string
  readonly transport: LinkTransport
  readonly api: HostApi
  readonly events: HostEventSubscriber
  /** The one owner of this host's connection lifecycle and retry policy. */
  readonly supervisor: HostSupervisor
  /** Everything read about this host, shared by every reader (docs/plans/host-model.md). */
  readonly facts: HostFacts
  private earlierRecheck: ReturnType<typeof setTimeout> | null = null
  /** The route the last dial chose after it answered as this host; null until that dial ends. */
  private chosenUrl: string | null = null
  /** A route that answered but did not connect, and when it may be tried again. */
  private heldBack: { url: string; until: number } | null = null
  private isDestroyed = false

  constructor(private readonly options: HostLinkOptions) {
    this.hostId = options.hostId
    this.transport = options.transport
    this.api = options.api
    this.events = options.transport.events
    this.facts = new HostFacts(options.hostId, { api: options.api, events: this.events, presence: options.presence })
    this.supervisor = new HostSupervisor({
      transport: {
        start: () => this.dial(),
        probe: () => this.transport.probe(),
        setUnreachable: (unreachable) => this.transport.setUnreachable(unreachable),
      },
      onSessionChange: (change) => this.facts.sessionChanged(change),
      onReadinessChange: (readiness, attempt) => {
        this.scheduleEarlierRecheck()
        options.onReadinessChange?.(readiness, attempt)
      },
      setTimeoutFn: options.setTimeoutFn,
      clearTimeoutFn: options.clearTimeoutFn,
    })
    this.transport.attachDialOutcomeReporter((outcome) => {
      if (outcome.kind === 'dial-failed' && this.chosenUrl) this.heldBack = { url: this.chosenUrl, until: Date.now() + ROUTE_HOLD_BACK_MS }
      this.chosenUrl = null
      this.supervisor.report(outcome)
      options.onOutcome?.(outcome)
    })
    this.facts.subscribe((key) => {
      const info = key === 'serverInfo' ? this.facts.value('serverInfo') : null
      if (info?.routes && info.identityKey) options.onAdvertised?.({ routes: info.routes, identityKey: info.identityKey })
    })
  }

  get readiness(): LinkReadiness {
    return this.supervisor.readiness
  }

  get attempt(): number {
    return this.supervisor.attempt
  }

  get refusedReason(): RefusedReason | null {
    return this.supervisor.refusedReason
  }

  /** When the host was last ready; null if it never was. */
  get lastSeenAt(): number | null {
    return this.supervisor.lastSeenAt
  }

  /** Past its grace and not ready since. */
  get away(): boolean {
    return this.supervisor.away
  }

  /** Bumps on each accepted connection that did not recover the previous server session. */
  get sessionGeneration(): number {
    return this.supervisor.sessionGeneration
  }

  /** The first dial. Idempotent. */
  start(): void {
    if (this.options.presence === 'gone') return
    this.supervisor.start()
  }

  /** A user retry: the ladder resets and the host is dialed now. */
  dialNow(): void {
    if (this.options.presence === 'gone') return
    this.supervisor.dialNow()
  }

  /** A wake is often a network change: an earlier route may answer on this network now. */
  wake(signal: WakeSignal): void {
    if (this.options.presence === 'gone') return
    this.supervisor.handleWakeSignal(signal)
    if (this.readiness === 'ready') void this.returnToEarlierRoute()
  }

  /**
   * The host's routes or their order changed. A link on a route it may no longer dial
   * moves to the first one, and a connected link dials there now. Otherwise an earlier
   * route gets its check now, and the next check runs a full interval from here.
   */
  followRoutes(): void {
    const dialable = this.dialable()
    if (dialable.some((route) => route.url === this.transport.serverUrl)) {
      if (this.readiness === 'ready') void this.returnToEarlierRoute()
      this.scheduleEarlierRecheck()
      return
    }
    const [first] = dialable
    if (!first) return
    const wasReady = this.readiness === 'ready'
    this.aimAt(first.url)
    if (wasReady) this.supervisor.dialNow()
  }

  destroy(): void {
    if (this.isDestroyed) return
    this.isDestroyed = true
    this.clearEarlierRecheck()
    this.supervisor.destroy()
    this.transport.destroy()
    this.facts.dispose()
  }

  private dialable(): HostRoute[] {
    return dialableRoutes(this.options.routes(), this.options.clientOrigin ?? '', this.options.localHostId ?? null, this.options.dialChoices?.())
  }

  /** The routes a dial asks: all but a held-back one, unless it is the last. */
  private candidates(): HostRoute[] {
    const dialable = this.dialable()
    const { heldBack } = this
    if (!heldBack || heldBack.until <= Date.now()) return dialable
    const others = dialable.filter((route) => route.url !== heldBack.url)
    return others.length > 0 ? others : dialable
  }

  /** One dial, on the route that answers first as this host. */
  private dial(): void {
    this.chosenUrl = null
    const dialable = this.candidates()
    const fallback = dialableRoutes(this.options.fallbackRoutes?.() ?? [], this.options.clientOrigin ?? '', this.options.localHostId ?? null)
    // A route that needs a proof of the host is always asked first: its credential waits for the proof.
    const needsProof = dialable.some(routeNeedsProof)
    // Every known route is one this client may not dial: the transport stays on none of them.
    if (dialable.length === 0 && fallback.length === 0 && this.options.routes().length > 0) {
      this.reportDialFailed()
      return
    }
    if (dialable.length < 2 && fallback.length === 0 && !needsProof) {
      if (dialable[0]) this.aimAt(dialable[0].url)
      this.transport.start()
      return
    }
    void (async () => {
      let route = await chooseRoute(dialable, this.options.answersAsHost, this.timers())
      if (!route && fallback.length > 0) route = await chooseRoute(fallback, this.options.answersAsHost, this.timers())
      if (this.isDestroyed) return
      // No route proved the host: none is dialed, so no credential goes to whatever answers there.
      if (!route && needsProof && dialable.every(routeNeedsProof)) {
        this.reportDialFailed()
        return
      }
      if (route) this.aimAt(route.url)
      this.chosenUrl = route?.url ?? null
      this.transport.start({ hostConfirmed: route !== null })
    })()
  }

  private reportDialFailed(): void {
    const outcome: DialOutcome = { kind: 'dial-failed' }
    this.supervisor.report(outcome)
    this.options.onOutcome?.(outcome)
  }

  private async returnToEarlierRoute(): Promise<void> {
    const route = await earlierRouteBack(this.candidates(), this.transport.serverUrl, this.options.answersAsHost, this.timers())
    if (!route || this.isDestroyed || this.readiness !== 'ready') return
    this.aimAt(route.url)
    this.supervisor.dialNow()
  }

  /** While the host is connected on a route that is not its first, the earlier routes are checked again now and then. */
  private scheduleEarlierRecheck(): void {
    this.clearEarlierRecheck()
    if (this.isDestroyed || this.readiness !== 'ready') return
    if (this.dialable().findIndex((route) => route.url === this.transport.serverUrl) < 1) return
    this.earlierRecheck = (this.options.setTimeoutFn ?? setTimeout)(() => {
      this.earlierRecheck = null
      void this.returnToEarlierRoute().finally(() => this.scheduleEarlierRecheck())
    }, EARLIER_ROUTE_RECHECK_MS)
  }

  private clearEarlierRecheck(): void {
    if (this.earlierRecheck) (this.options.clearTimeoutFn ?? clearTimeout)(this.earlierRecheck)
    this.earlierRecheck = null
  }

  private aimAt(url: string): void {
    if (this.transport.serverUrl === url) return
    this.transport.switchServerUrl(url)
    this.options.onRouteChange?.(url)
  }

  private timers() {
    return { setTimeoutFn: this.options.setTimeoutFn, clearTimeoutFn: this.options.clearTimeoutFn }
  }
}

/** What a connected host says about where it is reached and how it proves itself. */
export type AdvertisedHost = { routes: HostRoute[]; identityKey: string }

/** Whether a host's health names the host this client saved. */
export function isSavedHost(saved: { installationId: string; uplink?: SavedServerUplink }, health: HostHealth): boolean {
  return installationIdDecision(saved.installationId, health.installationId, saved.uplink) === 'match'
}

/** What a client knows about a saved host to check that a route reaches it. */
export interface SavedHostIdentity {
  installationId: string
  uplink?: SavedServerUplink
  /** The host's identity key (docs/plans/host-routes.md D3); absent until a trusted source gave it. */
  identityKey?: string
}

/**
 * Whether `route` answers as the saved host. A route that needs a proof
 * (`routeNeedsProof`) must also sign a fresh nonce with the identity key this
 * client saved; without a saved key such a route is never used, because the
 * credential would go to whatever answers there.
 */
export async function answersAsSavedHost(
  fetchImpl: typeof fetch,
  route: Pick<HostRoute, 'url' | 'source'>,
  saved: SavedHostIdentity,
  signal: AbortSignal,
  nonce: () => string = newHealthNonce,
): Promise<boolean> {
  if (!routeNeedsProof(route)) {
    const health = await readHostHealth(fetchImpl, route.url, signal)
    return !!health && isSavedHost(saved, health)
  }
  if (!saved.identityKey) return false
  const sent = nonce()
  // The verifier loads beside the health read: only an `http:` route needs it.
  const proofCode = import('@solus/contracts/host-proof')
  const health = await readHostHealth(fetchImpl, route.url, signal, sent)
  if (!health?.proof || !isSavedHost(saved, health)) return false
  const { verifyHostProof } = await proofCode
  return verifyHostProof(saved.identityKey, sent, health.installationId, health.proof)
}
