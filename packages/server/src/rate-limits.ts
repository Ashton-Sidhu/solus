import type { NormalizedEvent, RateLimitInfo } from '@solus/contracts/types'

type RateLimitEvent = Extract<NormalizedEvent, { type: 'rate_limit' }>

/** ms-vs-seconds + relative-vs-absolute reset heuristic. Applied to a number a
 *  provider stated, never to one read out of prose. */
export function normalizeResetNumber(value: number, nowSeconds = Date.now() / 1000): number | null {
  if (!Number.isFinite(value) || value <= 0) return null
  if (value > 10_000_000_000) return Math.ceil(value / 1000)
  if (value > nowSeconds - 60) return Math.ceil(value)
  return Math.ceil(nowSeconds + value)
}

/**
 * Whether a terminal error is the provider saying the account is spent.
 *
 * It reports only that, never when the window reopens. Codex writes the moment
 * into prose ("try again at Sep 15th, 2026 12:26 AM") and Claude's wording
 * carries no year, so Solus used to parse the sentence and guess five minutes
 * when the parse failed — which released a weekly limit's queued prompt six
 * days early. When an error omits its reset, `UsageLimitsStore` supplies the
 * epoch the provider already stated on the stream, if one is known.
 */
export function isRateLimitMessage(message: string): boolean {
  return /(?:rate|usage|session) limit/i.test(message)
}

export function decorateRateLimit(event: RateLimitEvent): RateLimitEvent {
  if (event.info) return event
  return { ...event, info: rateLimitInfo(event) }
}

function rateLimitInfo(event: RateLimitEvent): RateLimitInfo {
  return {
    resetsAt: event.resetsAt,
    rateLimitType: event.rateLimitType,
    prompt: 'Solus is taking a short breather before trying again.',
    queuedPrompt: event.resetsAt === null
      ? 'Queued safely. Solus will send it when you say so.'
      : 'Queued safely. Solus will send it when the limit resets.',
  }
}

/** Whether the window this limit describes is still shut. A limit with no known
 *  reset never reopens on a clock — only an explicit send releases it. */
export function isWindowClosed(event: RateLimitEvent, nowSeconds = Date.now() / 1000): boolean {
  return event.resetsAt === null || event.resetsAt > nowSeconds
}

export class RateLimitState {
  private active = new Map<string, RateLimitEvent>()

  record(sessionId: string, event: RateLimitEvent): RateLimitEvent | null {
    const decorated = decorateRateLimit(event)

    if (isBlockingRateLimit(decorated)) {
      this.active.set(sessionId, decorated)
    }

    return decorated
  }

  current(sessionId: string, now: number): RateLimitEvent | null {
    const event = this.active.get(sessionId)
    if (!event) return null
    // A limit with no known reset never expires on a clock. It is cleared when
    // the session is, or when the next turn succeeds.
    if (!isWindowClosed(event, now)) {
      this.active.delete(sessionId)
      return null
    }
    return event
  }

  /** The limit parked on a session, whether or not its window has reopened.
   *  A reopened window is not a decision: the card that is still asking what to
   *  do with the held prompt reads this, and `current` would retire it. */
  peek(sessionId: string): RateLimitEvent | null {
    return this.active.get(sessionId) ?? null
  }

  hasActive(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  clear(sessionId: string): void {
    this.active.delete(sessionId)
  }

  clearAll(): void {
    this.active.clear()
  }
}

function isBlockingRateLimit(event: RateLimitEvent): boolean {
  return event.status !== 'allowed' && !event.isUsingOverage
}
