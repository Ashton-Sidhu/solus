/**
 * The host supervisor: the one owner of a host's readiness and
 * retry policy (dispatch-client step 3). One per catalog entry, eagerly
 * desired; the transport below it never retries — it dials when told, and
 * reports how the dial went.
 *
 * The transport keeps its single socket.io Socket for the supervisor's whole
 * life, so connection-state recovery, the pending-request queue, and the
 * host-event subscriber all survive drops exactly as before. Only the backoff
 * schedule, the attempt counter, and the window wake listeners moved here.
 */

import type { HostSessionChange } from './host-facts'
import { UNREACHABLE_AFTER_MS, type LinkReadiness, type RefusedReason } from './host-readiness'

/** How one dial ended — the only inputs the readiness machine accepts. */
export type DialOutcome =
  | { kind: 'accepted'; recovered: boolean }
  | { kind: 'dropped' }
  | { kind: 'dial-failed' }
  | { kind: 'auth-blocked' }
  | { kind: 'identity-mismatch' }

/** What the supervisor drives. `start()` is one dial on the standing socket. */
export interface SupervisedTransport {
  start(): void
  /** Asks the connected socket to prove it is alive; rejects when it cannot. */
  probe(): Promise<void>
  /** While unreachable, a call fails at once instead of waiting for a dial that may never come. */
  setUnreachable(unreachable: boolean): void
}

// The same curve socket.io used, so retry behavior is bit-compatible with the
// pre-supervisor transport: 1s base, ×2 per attempt, 30s cap, ±50% jitter.
const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 30_000
const JITTER_FACTOR = 0.5

export function ladderDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1))
  const jitter = (random() * 2 - 1) * JITTER_FACTOR * base
  return Math.max(0, Math.min(MAX_DELAY_MS, Math.round(base + jitter)))
}

export interface HostSupervisorOptions {
  transport: SupervisedTransport
  onReadinessChange?: (readiness: LinkReadiness, attempt: number) => void
  /** A server session began, continued, or ended. The host's facts reload
   *  and clear on these edges (`HostFacts.sessionChanged`). */
  onSessionChange?: (change: HostSessionChange) => void
  /** Injectable for tests. */
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  random?: () => number
  now?: () => number
}

/**
 * The readiness rule (docs/plans/host-readiness.md): a host that is down is
 * `checking` (never ready yet) or `reconnecting` for the grace, then
 * `unreachable`. The ladder keeps dialing while unreachable: it is a reading,
 * not a stop. A user retry restarts the grace.
 */
export class HostSupervisor {
  readiness: LinkReadiness = 'checking'
  attempt = 0
  refusedReason: RefusedReason | null = null
  /** When the host was last ready; null if it never was. */
  lastSeenAt: number | null = null
  /** Past its grace and not ready since; a retry does not clear it (`HostReadinessState.away`). */
  away = false
  /** Bumps on every accepted, non-recovered connect: the server-session edge
   *  domain caches key their refetches to. A recovered socket is the same
   *  session continuing. */
  sessionGeneration = 0

  private hasConnected = false
  private dialInFlight = false
  private started = false
  /** When the current grace began; null while ready. */
  private downSince: number | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  constructor(private readonly options: HostSupervisorOptions) {}

  /** The first dial of an eagerly desired host. Idempotent. */
  start(): void {
    if (this.destroyed || this.dialInFlight || this.readiness === 'ready') return
    if (!this.started) {
      this.started = true
      this.beginGrace()
    }
    this.dial()
  }

  /** User retry or meaningful resume: the ladder resets, the grace restarts,
   *  and the host is dialed now. A host refused on identity stays refused — a
   *  dial cannot change who answers. */
  dialNow(): void {
    if (this.destroyed) return
    if (this.refusedReason === 'identity-mismatch') return
    this.refusedReason = null
    this.attempt = 0
    this.started = true
    this.clearRetryTimer()
    this.beginGrace()
    this.setReadiness(this.waitingReadiness())
    this.dial()
  }

  /** The transport's report of how the last dial (or the standing socket) ended. */
  report(outcome: DialOutcome): void {
    if (this.destroyed) return
    switch (outcome.kind) {
      case 'accepted': {
        this.dialInFlight = false
        this.clearRetryTimer()
        this.clearGraceTimer()
        this.downSince = null
        if (this.hasConnected && !outcome.recovered) this.sessionGeneration += 1
        // A recovered socket continues the same server session, so what was
        // read stands; a fresh session reads again.
        const change = this.hasConnected && outcome.recovered ? 'recovered' : 'fresh'
        this.hasConnected = true
        this.attempt = 0
        this.refusedReason = null
        this.options.onSessionChange?.(change)
        this.setReadiness('ready')
        return
      }
      case 'dropped':
      case 'dial-failed': {
        this.dialInFlight = false
        if (this.readiness === 'ready') {
          this.lastSeenAt = this.now()
          this.beginGrace()
        }
        this.options.onSessionChange?.('lost')
        this.scheduleNextDial()
        return
      }
      case 'auth-blocked':
      case 'identity-mismatch': {
        this.dialInFlight = false
        if (this.readiness === 'ready') this.lastSeenAt = this.now()
        this.refusedReason = outcome.kind === 'auth-blocked' ? 'auth' : 'identity-mismatch'
        this.options.onSessionChange?.('lost')
        this.clearRetryTimer()
        this.clearGraceTimer()
        this.setReadiness('refused')
        return
      }
    }
  }

  /** The wake taxonomy (step-3 rider): a healthy host is probed, never
   *  reconnected; only a meaningful suspension (`resume`) resets the retry
   *  ladder; a plain `activation` is ignored during an in-flight dial and
   *  otherwise only pulls the already-scheduled dial forward. */
  handleWakeSignal(signal: 'resume' | 'activation'): void {
    if (this.destroyed || this.refusedReason) return
    if (this.readiness === 'ready') {
      void this.options.transport.probe().catch(() => {
        // A failed probe is fresh evidence the network changed: dial anew.
        if (!this.destroyed && !this.refusedReason) this.dialNow()
      })
      return
    }
    if (signal === 'resume') {
      this.dialNow()
      return
    }
    if (this.dialInFlight) return
    if (this.retryTimer) {
      this.clearRetryTimer()
      this.dial()
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.clearRetryTimer()
    this.clearGraceTimer()
  }

  private dial(): void {
    this.dialInFlight = true
    // An unreachable host must not flicker to "reconnecting" on every
    // capped-ladder dial; only outcomes, the grace, or a user retry move it.
    if (this.readiness !== 'unreachable') this.setReadiness(this.waitingReadiness())
    this.options.transport.start()
  }

  private scheduleNextDial(): void {
    if (this.retryTimer) return
    this.attempt += 1
    this.setReadiness(this.isPastGrace() ? 'unreachable' : this.waitingReadiness())
    const setTimeoutFn = this.options.setTimeoutFn ?? setTimeout
    this.retryTimer = setTimeoutFn(() => {
      this.retryTimer = null
      if (this.destroyed || this.refusedReason) return
      this.dial()
    }, ladderDelayMs(this.attempt, this.options.random))
  }

  private waitingReadiness(): LinkReadiness {
    return this.hasConnected ? 'reconnecting' : 'checking'
  }

  private beginGrace(): void {
    this.downSince = this.now()
    this.clearGraceTimer()
    const setTimeoutFn = this.options.setTimeoutFn ?? setTimeout
    this.graceTimer = setTimeoutFn(() => {
      this.graceTimer = null
      if (this.destroyed) return
      if (this.readiness === 'checking' || this.readiness === 'reconnecting') this.setReadiness('unreachable')
    }, UNREACHABLE_AFTER_MS)
  }

  private isPastGrace(): boolean {
    return this.downSince !== null && this.now() - this.downSince >= UNREACHABLE_AFTER_MS
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private clearRetryTimer(): void {
    if (!this.retryTimer) return
    const clearTimeoutFn = this.options.clearTimeoutFn ?? clearTimeout
    clearTimeoutFn(this.retryTimer)
    this.retryTimer = null
  }

  private clearGraceTimer(): void {
    if (!this.graceTimer) return
    const clearTimeoutFn = this.options.clearTimeoutFn ?? clearTimeout
    clearTimeoutFn(this.graceTimer)
    this.graceTimer = null
  }

  private setReadiness(readiness: LinkReadiness): void {
    const changed = this.readiness !== readiness
    if (!changed && readiness !== 'reconnecting' && readiness !== 'checking') return
    if (changed && (readiness === 'unreachable' || this.readiness === 'unreachable')) {
      this.options.transport.setUnreachable(readiness === 'unreachable')
    }
    this.readiness = readiness
    if (readiness === 'ready') this.away = false
    else if (readiness === 'unreachable' || readiness === 'refused') this.away = true
    this.options.onReadinessChange?.(readiness, this.attempt)
  }
}
