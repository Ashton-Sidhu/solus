import { createLogger } from '../../logger'
import { RateLimitState } from '../rate-limits'
import type { AgentId, NormalizedEvent, IpcContext, RateLimitDecisionAction, SessionRunInput } from '@solus/contracts/types'
import { type Actor } from '../../admission/actor'
import type { SessionRuntime } from '../session-runtime'

const log = createLogger('SessionRuntime', 'rate-limit-park.ts')

const CODEX_RATE_LIMIT_SEND_BUFFER_SECONDS = 2 * 60

/**
 * Runs parked on a provider limit: the limit snapshot that gates a session's
 * next send, the release timer, and the user's decision to wait, send, or stop.
 */
export class RateLimitPark {
  rateLimitTimers = new Map<string, ReturnType<typeof setTimeout>>()
  rateLimits = new RateLimitState()

  constructor(private readonly rt: SessionRuntime) {}

  /** Apply Queue to prompts already held when a client whose person chose Queue
   * rejoins. Unattended runs keep the policy supplied by their owner. */
  queueHeldRateLimitedPrompts(behavior: SessionRunInput['rateLimitBehavior'], onlySessionId?: string): void {
    if (behavior !== 'queue') return
    for (const [sessionId, run] of this.rt.activeRunRequests) {
      if (onlySessionId && sessionId !== onlySessionId) continue
      if (run.exchangeIds?.length || run.options.promptSource === 'agent' || run.options.promptSource === 'automation' || run.options.promptSource === 'watch') continue
      if (!this.hasUndecidedHeldPrompt(sessionId)) continue
      const event = this.rateLimits.peek(sessionId)
      if (!event) continue
      run.input.rateLimitBehavior = 'queue'
      if (this.queueActiveRateLimitedRequest(sessionId)) {
        this.scheduleRateLimitRelease(sessionId, event.resetsAt)
      }
    }
  }

  resolveRateLimit(ctx: IpcContext, action: RateLimitDecisionAction, actor: Actor): boolean {
    const sessionId = this.rt.sessionIdForCtx(ctx)
    if (!sessionId) return false
    const decided = (): void => {
      if (actor.user) void this.rt.recordActivity({ kind: 'session', id: sessionId }, actor, { kind: 'rate_limit_decided', action })
    }

    if (action === 'wait') {
      const event = this.currentRateLimitEvent(sessionId)
      if (event?.type !== 'rate_limit') return false
      this.queueActiveRateLimitedRequest(sessionId)
      this.scheduleRateLimitRelease(sessionId, event.resetsAt)
      decided()
      return true
    }

    if (action === 'stop') {
      this.rt.sessionEmitter.resolveRateLimit(sessionId)
      this.clearRateLimitTimer(sessionId)
      this.rateLimits.clear(sessionId)
      this.rt.statuses.setStatus(sessionId, 'idle')
      this.rt.cancelRunExchanges(this.rt.activeRunRequests.get(sessionId))
      this.rejectRateLimitQueue(sessionId, new Error('Rate-limited prompts stopped'))
      this.broadcastRateLimitResolved(sessionId, action)
      decided()
      this.dropParkedSession(sessionId)
      return true
    }

    this.queueActiveRateLimitedRequest(sessionId)
    this.releaseRateLimitQueue(sessionId, action)
    decided()
    return true
  }

  currentRateLimitEvent(sessionId: string | null | undefined): Extract<NormalizedEvent, { type: 'rate_limit' }> | null {
    if (!sessionId) return null
    const parked = this.rateLimits.peek(sessionId)
    // The card is still asking what to do with the held prompt, so the limit
    // outlives its own window: retiring it here would take the question away
    // and the prompt with it. The user's answer releases it, whenever it comes.
    if (parked && this.hasUndecidedHeldPrompt(sessionId)) return parked
    const event = this.rateLimits.current(sessionId, Date.now() / 1000)
    if (!event && parked) {
      this.releaseRateLimitQueue(sessionId, 'wait')
      return null
    }

    return event
  }

  /** A prompt the limit stopped, whose three ways out the user has not chosen
   *  between: the session is still parked on the limit, the prompt is still its
   *  active run request, and nothing was queued for it. A later run taking the
   *  session over answers the question by making it moot. */
  private hasUndecidedHeldPrompt(sessionId: string): boolean {
    if (this.rt.activeSessions.get(sessionId)?.status !== 'rate_limited') return false
    if (!this.rt.activeRunRequests.has(sessionId)) return false
    return !(this.rt.scheduler.requestQueue.get(sessionId) ?? []).some((req) => req.rateLimitSessionId === sessionId)
  }

  /** Resolve missing provider data, then apply retry policy once before the
   * session gate, queue and countdown all consume the same release time.
   * The usage store keeps raw provider timestamps. */
  prepareRateLimit(agentId: AgentId, event: Extract<NormalizedEvent, { type: 'rate_limit' }>): Extract<NormalizedEvent, { type: 'rate_limit' }> {
    const reset = event.resetsAt ?? this.rt.usageLimits.resetsAtFor(agentId, event.windowDurationMins)
    const resetsAt = reset === null ? null : reset + (agentId === 'codex' ? CODEX_RATE_LIMIT_SEND_BUFFER_SECONDS : 0)
    return resetsAt === event.resetsAt ? event : { ...event, resetsAt }
  }

  scheduleRateLimitRelease(sessionId: string, resetsAt: number | null): void {
    this.clearRateLimitTimer(sessionId)
    if (resetsAt === null) return
    const delay = Math.max(resetsAt * 1000 - Date.now(), 0)
    const timer = setTimeout(() => {
      // The timer releases a prompt somebody queued. A window reopening is not
      // itself a decision, so a held prompt the user has not answered for stays
      // held — releasing it here would either run it unasked or discard it.
      if (this.hasUndecidedHeldPrompt(sessionId)) return
      this.releaseRateLimitQueue(sessionId, 'wait')
    }, delay)
    timer.unref?.()
    this.rateLimitTimers.set(sessionId, timer)
  }

  clearRateLimitTimer(sessionId: string): void {
    const timer = this.rateLimitTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.rateLimitTimers.delete(sessionId)
    }
  }

  cleanupRateLimitTimerIfUnused(sessionId: string): void {
    const queue = this.rt.scheduler.requestQueue.get(sessionId) ?? []
    if (queue.some((r) => r.rateLimitSessionId === sessionId)) return
    this.clearRateLimitTimer(sessionId)
    this.rateLimits.clear(sessionId)
    // Removing the last prompt a limit was holding ends the limit, and nothing
    // else will: the session would keep the `rate_limited` status, and the card
    // its countdown, until some unrelated turn moved it.
    if (this.rt.activeSessions.get(sessionId)?.status !== 'rate_limited') return
    this.rt.sessionEmitter.resolveRateLimit(sessionId)
    this.rt.statuses.setStatus(sessionId, 'idle')
    this.broadcastRateLimitResolved(sessionId, 'stop')
    this.dropParkedSession(sessionId)
  }

  queueActiveRateLimitedRequest(sessionId: string): boolean {
    const event = this.currentRateLimitEvent(sessionId)
    if (event?.type !== 'rate_limit') return false

    const queue = this.rt.scheduler.requestQueue.get(sessionId) ?? []
    if (queue.some((r) => r.rateLimitSessionId === sessionId)) return false

    const run = this.rt.activeRunRequests.get(sessionId)
    if (!run) return false

    try {
      this.rt.scheduler.enqueueRequest({
        ...run,
        target: { kind: 'session', sessionId },
      }, {
        sessionId,
        reason: 'rate_limit',
        rateLimitSessionId: sessionId,
        releaseAt: event.resetsAt ?? undefined,
        rateLimitType: event.rateLimitType,
      })
      // Completion routes are fields on the copied request, so they move with
      // the logical prompt into its retry instead of being rebound by queue id.
    } catch (err) {
      log.error('rate_limit_queue_failed', { sessionId, error: String(err) })
      return false
    }
    this.rt.activeRunRequests.delete(sessionId)
    return true
  }

  private releaseRateLimitQueue(sessionId: string, action: RateLimitDecisionAction): void {
    this.rt.sessionEmitter.resolveRateLimit(sessionId)
    this.clearRateLimitTimer(sessionId)
    this.rateLimits.clear(sessionId)

    for (const req of this.rt.scheduler.requestQueue.get(sessionId) ?? []) {
      if (req.rateLimitSessionId !== sessionId) continue
      req.releaseAt = undefined
    }

    const hasQueued = (this.rt.scheduler.requestQueue.get(sessionId) ?? []).some((req) => req.rateLimitSessionId === sessionId)
    const session = this.rt.activeSessions.get(sessionId)
    if (hasQueued || session?.status !== 'running') {
      // Releasing a limit does not start work. Dispatch sets the next turn's
      // status; a restored or failed entry can still be held for Resume.
      this.rt.statuses.setStatus(sessionId, 'idle')
    }
    this.broadcastRateLimitResolved(sessionId, action)
    if (!hasQueued) this.dropParkedSession(sessionId)
    this.rt.scheduler.processQueueForSession(sessionId)
  }

  /**
   * Finish the teardown the `exit` handler deferred. A run that ends on a rate
   * limit keeps its session record so the held turn can resume at release, and
   * the run watchdog exempts it while the status says `rate_limited`. Once the
   * limit is resolved with nothing left to dispatch, that exemption is gone and
   * the record describes a session with no provider run behind it — which the
   * watchdog reads as a dead agent and kills a minute later. Callers run this
   * after the status change and the broadcast, both of which read the record.
   */
  private dropParkedSession(sessionId: string): void {
    const session = this.rt.activeSessions.get(sessionId)
    // Every caller settles the status to `idle` first. Anything else means a run
    // took the session over between the limit resolving and this teardown.
    if (session?.status !== 'idle') return
    const agentSessionId = session.agentSessionId
    if (agentSessionId && this.rt.backendFor(session.backendId).isSessionRunning(agentSessionId)) return
    this.rt.activeSessions.delete(sessionId)
    this.rt.activeRunRequests.delete(sessionId)
    this.rt.missingRunCounts.delete(sessionId)
  }

  rejectRateLimitQueue(sessionId: string, reason: Error): void {
    const queue = this.rt.scheduler.requestQueue.get(sessionId)
    if (!queue) return
    for (let i = queue.length - 1; i >= 0; i--) {
      const req = queue[i]
      if (req.rateLimitSessionId !== sessionId) continue
      this.rt.scheduler.requestQueue.remove(sessionId, req.queueId)
      this.rt.cancelRunExchanges(req.run)
      req.reject(reason)
      this.rt.publish(req.sessionId, { type: 'prompt_dequeued', queueId: req.queueId })
    }
    this.rt.scheduler.requestQueue.save(sessionId)
  }

  broadcastRateLimitResolved(sessionId: string, action: RateLimitDecisionAction): void {
    // The event's own `sessionId` is what the renderer matches its rate-limit
    // card against — the provider thread it was raised for.
    const agentSessionId = this.rt.agentSessionIdFor(sessionId)
    if (!agentSessionId) return
    this.rt.publish(sessionId, {
      type: 'rate_limit_resolved',
      sessionId: agentSessionId,
      action,
    })
  }
}
