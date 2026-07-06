import type { NormalizedEvent, RateLimitInfo } from '../shared/types'

type RateLimitEvent = Extract<NormalizedEvent, { type: 'rate_limit' }>

/** ms-vs-seconds + relative-vs-absolute reset heuristic. */
export function normalizeResetNumber(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null
  if (value > 10_000_000_000) return Math.ceil(value / 1000)
  const nowSeconds = Date.now() / 1000
  if (value > nowSeconds - 60) return Math.ceil(value)
  return Math.ceil(nowSeconds + value)
}

export function findResetTimestamp(value: unknown): number | null {
  if (value == null) return null

  if (typeof value === 'number') return normalizeResetNumber(value)

  if (typeof value === 'string') {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return normalizeResetNumber(numeric)

    const parsedDate = Date.parse(value)
    if (!Number.isNaN(parsedDate)) return Math.ceil(parsedDate / 1000)

    const tryAgainMatch = value.match(/try again at (\d{1,2}):(\d{2})\s*(AM|PM)/i)
    if (tryAgainMatch) {
      let hours = parseInt(tryAgainMatch[1], 10)
      const minutes = parseInt(tryAgainMatch[2], 10)
      const meridiem = tryAgainMatch[3].toUpperCase()
      if (meridiem === 'AM' && hours === 12) hours = 0
      if (meridiem === 'PM' && hours !== 12) hours += 12
      const now = new Date()
      const reset = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0)
      if (reset.getTime() <= now.getTime()) reset.setDate(reset.getDate() + 1)
      return Math.ceil(reset.getTime() / 1000)
    }

    return null
  }

  if (typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  for (const key of [
    'resetsAt',
    'resetAt',
    'reset_at',
    'retryAfter',
    'retry_after',
    'retryAfterSeconds',
    'secondsUntilReset',
    'resetInSeconds',
  ]) {
    const found = findResetTimestamp(record[key])
    if (found) return found
  }

  return null
}

export function decorateRateLimit(event: RateLimitEvent): RateLimitEvent {
  if (event.info) return event

  const info = rateLimitInfo(event)
  const used = typeof event.usedPercent === 'number' ? `, ${Math.round(event.usedPercent)}% used` : ''
  const message = event.status === 'allowed_warning'
    ? `Rate limit warning (${event.rateLimitType}).${used ? ` ${used.slice(2)}.` : ''} Resets at ${new Date(event.resetsAt * 1000).toLocaleString()}.`
    : `Rate limited (${event.rateLimitType}${used}). Resets at ${new Date(event.resetsAt * 1000).toLocaleString()}.`
  return { ...event, info, message }
}

function rateLimitInfo(event: RateLimitEvent): RateLimitInfo {
  return {
    resetsAt: event.resetsAt,
    rateLimitType: event.rateLimitType,
    prompt: 'Solus is taking a short breather before trying again.',
    queuedPrompt: 'Queued safely. Solus will send it when the limit resets.',
  }
}

export class RateLimitState {
  private active = new Map<string, RateLimitEvent>()
  private warningKeys = new Map<string, Set<string>>()

  record(sessionId: string, event: RateLimitEvent): RateLimitEvent | null {
    const decorated = decorateRateLimit(event)

    if (decorated.status === 'allowed_warning') {
      const warningKey = `${decorated.rateLimitType}:${decorated.resetsAt}`
      let sessionWarnings = this.warningKeys.get(sessionId)
      if (!sessionWarnings) {
        sessionWarnings = new Set()
        this.warningKeys.set(sessionId, sessionWarnings)
      }
      if (sessionWarnings.has(warningKey)) return null
      sessionWarnings.add(warningKey)
      return decorated
    }

    if (isBlockingRateLimit(decorated)) {
      this.active.set(sessionId, decorated)
    }

    return decorated
  }

  current(sessionId: string, now: number): RateLimitEvent | null {
    const event = this.active.get(sessionId)
    if (!event) return null
    if (event.resetsAt <= now) {
      this.active.delete(sessionId)
      return null
    }
    return event
  }

  hasActive(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  clear(sessionId: string): void {
    this.active.delete(sessionId)
    this.warningKeys.delete(sessionId)
  }

  clearAll(): void {
    this.active.clear()
    this.warningKeys.clear()
  }
}

function isBlockingRateLimit(event: RateLimitEvent): boolean {
  return event.status !== 'allowed' && event.status !== 'allowed_warning' && !event.isUsingOverage
}
