import { z } from 'zod'
import type { HostRoute } from '@solus/contracts/uplink'
import type { HostOperatingSystem } from '@solus/contracts/types'
import type { HostApi } from './host-api'
import type { HostEventSubscriber } from './host-event-subscriber'
import { HostFacts, type HostPresence } from './host-facts'
import { HostSupervisor, type BlockedReason, type DialOutcome, type HostPhase } from './host-supervisor'
import { chooseRoute, directRouteBack, DIRECT_ROUTE_RECHECK_MS, type RouteCheck } from './route-choice'
import { dialableRoutes, installationIdDecision, type SavedServerUplink } from './server-registry'
import type { WakeSignal } from './wake-signals'

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
 * - while a host is reached through its tunnel, its direct routes are checked again
 *   now and then, and at each wake, and the link moves back when one answers;
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
  /** Whether a route answers `/health` as this host. Never rejects. */
  answersAsHost: RouteCheck
  /** The page's origin: an `https:` page cannot dial an `http:` route. Empty for a native client. */
  clientOrigin?: string
  /** `gone`: this client does not know the host. The link never dials. */
  presence?: HostPresence
  onPhaseChange?: (phase: HostPhase, attempt: number) => void
  /** Every dial outcome, after the supervisor has acted on it. */
  onOutcome?: (outcome: DialOutcome) => void
  /** The link moved to another route. */
  onRouteChange?: (url: string) => void
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
  private directRecheck: ReturnType<typeof setTimeout> | null = null
  private isDestroyed = false

  constructor(private readonly options: HostLinkOptions) {
    this.hostId = options.hostId
    this.transport = options.transport
    this.api = options.api
    this.events = options.transport.events
    this.facts = new HostFacts(options.hostId, { api: options.api, events: this.events, presence: options.presence })
    this.supervisor = new HostSupervisor({
      transport: { start: () => this.dial(), probe: () => this.transport.probe() },
      onSessionChange: (change) => this.facts.sessionChanged(change),
      onPhaseChange: (phase, attempt) => {
        this.scheduleDirectRecheck()
        options.onPhaseChange?.(phase, attempt)
      },
      setTimeoutFn: options.setTimeoutFn,
      clearTimeoutFn: options.clearTimeoutFn,
    })
    this.transport.attachDialOutcomeReporter((outcome) => {
      this.supervisor.report(outcome)
      options.onOutcome?.(outcome)
    })
  }

  get phase(): HostPhase {
    return this.supervisor.phase
  }

  get attempt(): number {
    return this.supervisor.attempt
  }

  get blockedReason(): BlockedReason | null {
    return this.supervisor.blockedReason
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

  /** A wake is often a network change: a host reached through its tunnel may be on this network now. */
  wake(signal: WakeSignal): void {
    if (this.options.presence === 'gone') return
    this.supervisor.handleWakeSignal(signal)
    if (this.phase === 'connected') void this.returnToDirectRoute()
  }

  /** The host's routes changed: a link aimed at a route no longer listed moves to the first one. */
  followRoutes(): void {
    const routes = this.options.routes()
    if (routes.some((route) => route.url === this.transport.serverUrl)) return
    const [first] = this.dialable()
    if (first) this.aimAt(first.url)
  }

  destroy(): void {
    if (this.isDestroyed) return
    this.isDestroyed = true
    this.clearDirectRecheck()
    this.supervisor.destroy()
    this.transport.destroy()
    this.facts.dispose()
  }

  private dialable(): HostRoute[] {
    return dialableRoutes([...this.options.routes()], this.options.clientOrigin ?? '')
  }

  /** One dial, on the route that answers first as this host. */
  private dial(): void {
    const dialable = this.dialable()
    const fallback = dialableRoutes([...this.options.fallbackRoutes?.() ?? []], this.options.clientOrigin ?? '')
    if (dialable.length < 2 && fallback.length === 0) {
      if (dialable[0]) this.aimAt(dialable[0].url)
      this.transport.start()
      return
    }
    void (async () => {
      let route = await chooseRoute(dialable, this.options.answersAsHost, this.timers())
      if (!route && fallback.length > 0) route = await chooseRoute(fallback, this.options.answersAsHost, this.timers())
      if (this.isDestroyed) return
      if (route) this.aimAt(route.url)
      this.transport.start({ hostConfirmed: route !== null })
    })()
  }

  private async returnToDirectRoute(): Promise<void> {
    const route = await directRouteBack(this.dialable(), this.transport.serverUrl, this.options.answersAsHost, this.timers())
    if (!route || this.isDestroyed || this.phase !== 'connected') return
    this.aimAt(route.url)
    this.supervisor.dialNow()
  }

  /** While the host is connected through its tunnel, its direct routes are checked again now and then. */
  private scheduleDirectRecheck(): void {
    this.clearDirectRecheck()
    const current = this.options.routes().find((route) => route.url === this.transport.serverUrl)
    if (this.isDestroyed || this.phase !== 'connected' || current?.kind !== 'tunnel') return
    this.directRecheck = (this.options.setTimeoutFn ?? setTimeout)(() => {
      this.directRecheck = null
      void this.returnToDirectRoute().finally(() => this.scheduleDirectRecheck())
    }, DIRECT_ROUTE_RECHECK_MS)
  }

  private clearDirectRecheck(): void {
    if (this.directRecheck) (this.options.clearTimeoutFn ?? clearTimeout)(this.directRecheck)
    this.directRecheck = null
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

/** What a host's `/health` says about it. */
export interface HostHealth {
  ok: boolean
  installationId: string
  name: string
  os?: HostOperatingSystem
}

// `ok`, `installationId`, and `name` are the identity contract and stay
// required; everything else degrades alone so a newer host's additions never
// null the whole health record and silently stop identity verification.
const hostHealthSchema = z.object({
  ok: z.literal(true),
  installationId: z.string().min(1),
  name: z.string().min(1),
  os: z.enum(['macos', 'windows', 'linux']).optional().catch(undefined),
})

/** One `/health` read, with no credential; null when the route did not answer as a Solus host. */
export async function readHostHealth(fetchImpl: typeof fetch, url: string, signal: AbortSignal): Promise<HostHealth | null> {
  try {
    const response = await fetchImpl(`${url}/health`, { signal })
    if (!response.ok) return null
    const health = hostHealthSchema.safeParse(await response.json())
    return health.success ? health.data : null
  } catch {
    return null
  }
}

/** Whether a host's health names the host this client saved. */
export function isSavedHost(saved: { installationId: string; uplink?: SavedServerUplink }, health: HostHealth): boolean {
  return installationIdDecision(saved.installationId, health.installationId, saved.uplink) === 'match'
}
