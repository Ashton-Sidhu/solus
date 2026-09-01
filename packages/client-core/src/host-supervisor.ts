/**
 * The host supervisor: the one owner of a host's connection lifecycle and
 * retry policy (dispatch-client step 3). One per catalog entry, eagerly
 * desired; the transport below it never retries — it dials when told, and
 * reports how the dial went.
 *
 * The transport keeps its single socket.io Socket for the supervisor's whole
 * life, so connection-state recovery, the pending-request queue, and the
 * host-event subscriber all survive drops exactly as before. Only the backoff
 * schedule, the attempt counter, and the window wake listeners moved here.
 */

import type { HostCapabilities } from '@solus/contracts/types'

export type HostPhase = 'connecting' | 'reconnecting' | 'connected' | 'blocked' | 'offline'
export type BlockedReason = 'auth' | 'identity-mismatch'

/** How one dial ended — the only inputs the phase machine accepts. */
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
}

// The same curve socket.io used, so retry behavior is bit-compatible with the
// pre-supervisor transport: 1s base, ×2 per attempt, 30s cap, ±50% jitter.
const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 30_000
const JITTER_FACTOR = 0.5
/** After this many straight failures the phase presents as offline; the
 *  ladder keeps running at its cap — offline is a reading, not a stop. */
export const OFFLINE_AFTER_ATTEMPTS = 3

export function ladderDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1))
  const jitter = (random() * 2 - 1) * JITTER_FACTOR * base
  return Math.max(0, Math.min(MAX_DELAY_MS, Math.round(base + jitter)))
}

export interface HostSupervisorOptions {
  transport: SupervisedTransport
  onPhaseChange?: (phase: HostPhase, attempt: number) => void
  /** Attempt decoration for the legacy status stream while a retry is due. */
  onRetryScheduled?: (attempt: number) => void
  /** One authenticated advertisement per server session. Failures resolve to
   *  an empty record: absent means unsupported, never a feature error. */
  loadCapabilities?: () => Promise<HostCapabilities>
  /** Injectable for tests. */
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  random?: () => number
}

export class HostSupervisor {
  phase: HostPhase = 'connecting'
  attempt = 0
  blockedReason: BlockedReason | null = null
  /** Bumps on every accepted, non-recovered connect: the server-session edge
   *  domain caches key their refetches to. A recovered socket is the same
   *  session continuing. */
  sessionGeneration = 0

  /** This server session's capability record. Session-scoped by the step-3
   *  rider: loaded once per accepted session, cleared on disconnect — an
   *  absent record hides actions, it never triggers a probe. */
  capabilities: HostCapabilities | undefined

  private hasConnected = false
  private dialInFlight = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false
  private capabilitiesLoad: Promise<HostCapabilities> | null = null

  constructor(private readonly options: HostSupervisorOptions) {}

  /** The session's record, now or when its one load settles. Before any
   *  session exists this starts a load that rides the transport's request
   *  queue, so a host that never answers resolves empty like it always did. */
  whenCapabilities(): Promise<HostCapabilities> {
    if (this.capabilities) return Promise.resolve(this.capabilities)
    if (!this.capabilitiesLoad) this.beginCapabilityLoad()
    return this.capabilitiesLoad ?? Promise.resolve({})
  }

  /** The first dial of an eagerly desired host. Idempotent. */
  start(): void {
    if (this.destroyed || this.dialInFlight || this.phase === 'connected') return
    this.dial()
  }

  /** User retry or meaningful resume: the ladder resets and dials now. A host
   *  blocked on identity stays blocked — a dial cannot change who answers. */
  dialNow(): void {
    if (this.destroyed) return
    if (this.blockedReason === 'identity-mismatch') return
    this.blockedReason = null
    this.attempt = 0
    this.clearRetryTimer()
    this.dial()
  }

  /** The transport's report of how the last dial (or the standing socket) ended. */
  report(outcome: DialOutcome): void {
    if (this.destroyed) return
    switch (outcome.kind) {
      case 'accepted': {
        this.dialInFlight = false
        this.clearRetryTimer()
        if (this.hasConnected && !outcome.recovered) this.sessionGeneration += 1
        this.hasConnected = true
        this.attempt = 0
        this.blockedReason = null
        // A recovered socket continues the same server session, so its
        // capability record stands; a fresh session loads a fresh one.
        if (!outcome.recovered || this.capabilities === undefined) this.beginCapabilityLoad()
        this.setPhase('connected')
        return
      }
      case 'dropped':
      case 'dial-failed': {
        this.dialInFlight = false
        this.capabilities = undefined
        this.scheduleNextDial()
        return
      }
      case 'auth-blocked': {
        this.dialInFlight = false
        this.blockedReason = 'auth'
        this.capabilities = undefined
        this.clearRetryTimer()
        this.setPhase('blocked')
        return
      }
      case 'identity-mismatch': {
        this.dialInFlight = false
        this.blockedReason = 'identity-mismatch'
        this.capabilities = undefined
        this.clearRetryTimer()
        this.setPhase('blocked')
        return
      }
    }
  }

  /** The wake taxonomy (step-3 rider): a healthy host is probed, never
   *  reconnected; only a meaningful suspension (`resume`) resets the retry
   *  ladder; a plain `activation` is ignored during an in-flight dial and
   *  otherwise only pulls the already-scheduled dial forward. */
  handleWakeSignal(signal: 'resume' | 'activation'): void {
    if (this.destroyed || this.blockedReason) return
    if (this.phase === 'connected') {
      void this.options.transport.probe().catch(() => {
        // A failed probe is fresh evidence the network changed: dial anew.
        if (!this.destroyed && !this.blockedReason) this.dialNow()
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
  }

  private dial(): void {
    this.dialInFlight = true
    // A host presented offline must not flicker to "connecting" on every
    // capped-ladder dial; only outcomes (or a user retry resetting the
    // attempt count) move the presentation.
    this.setPhase(this.attempt >= OFFLINE_AFTER_ATTEMPTS
      ? 'offline'
      : this.hasConnected ? 'reconnecting' : 'connecting')
    this.options.transport.start()
  }

  private scheduleNextDial(): void {
    if (this.retryTimer) return
    this.attempt += 1
    const presentation = this.attempt >= OFFLINE_AFTER_ATTEMPTS
      ? 'offline'
      : this.hasConnected ? 'reconnecting' : 'connecting'
    this.setPhase(presentation)
    this.options.onRetryScheduled?.(this.attempt)
    const setTimeoutFn = this.options.setTimeoutFn ?? setTimeout
    this.retryTimer = setTimeoutFn(() => {
      this.retryTimer = null
      if (this.destroyed || this.blockedReason) return
      this.dial()
    }, ladderDelayMs(this.attempt, this.options.random))
  }

  private beginCapabilityLoad(): void {
    const load = this.options.loadCapabilities
    if (!load) return
    const promise = load().catch(() => ({}))
    this.capabilitiesLoad = promise
    void promise.then((record) => {
      // A displaced load (a newer session began its own) must not answer.
      if (this.capabilitiesLoad === promise && !this.destroyed) this.capabilities = record
    })
  }

  private clearRetryTimer(): void {
    if (!this.retryTimer) return
    const clearTimeoutFn = this.options.clearTimeoutFn ?? clearTimeout
    clearTimeoutFn(this.retryTimer)
    this.retryTimer = null
  }

  private setPhase(phase: HostPhase): void {
    if (this.phase === phase && phase !== 'reconnecting' && phase !== 'connecting') return
    this.phase = phase
    this.options.onPhaseChange?.(phase, this.attempt)
  }

}
