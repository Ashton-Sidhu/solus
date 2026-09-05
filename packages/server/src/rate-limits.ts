import { z } from 'zod'

import type { NormalizedEvent, RateLimitInfo } from '@solus/contracts/types'

type RateLimitEvent = Extract<NormalizedEvent, { type: 'rate_limit' }>

interface ZonedDateTimeParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

/** ms-vs-seconds + relative-vs-absolute reset heuristic. */
export function normalizeResetNumber(value: number, nowSeconds = Date.now() / 1000): number | null {
  if (!Number.isFinite(value) || value <= 0) return null
  if (value > 10_000_000_000) return Math.ceil(value / 1000)
  if (value > nowSeconds - 60) return Math.ceil(value)
  return Math.ceil(nowSeconds + value)
}

const resetDetailsSchema = z.object({
  resetsAt: z.union([z.number(), z.string()]).nullish(),
  resetAt: z.union([z.number(), z.string()]).nullish(),
  reset_at: z.union([z.number(), z.string()]).nullish(),
  retryAfter: z.union([z.number(), z.string()]).nullish(),
  retry_after: z.union([z.number(), z.string()]).nullish(),
  retryAfterSeconds: z.union([z.number(), z.string()]).nullish(),
  secondsUntilReset: z.union([z.number(), z.string()]).nullish(),
  resetInSeconds: z.union([z.number(), z.string()]).nullish(),
})

export function findResetTimestamp<Input>(value: Input, observedAtMs = Date.now()): number | null {
  const numberResult = z.number().safeParse(value)
  if (numberResult.success) return normalizeResetNumber(numberResult.data, observedAtMs / 1000)

  const stringResult = z.string().safeParse(value)
  if (stringResult.success) {
    const numeric = Number(stringResult.data)
    if (Number.isFinite(numeric)) return normalizeResetNumber(numeric, observedAtMs / 1000)

    const parsedDate = Date.parse(stringResult.data)
    if (!Number.isNaN(parsedDate)) return Math.ceil(parsedDate / 1000)

    const clockMatch = stringResult.data.match(/(?:try again at|resets?)\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)(?:\s*\(([^)]+)\))?/i)
    if (clockMatch) {
      let hours = parseInt(clockMatch[1], 10)
      const minutes = parseInt(clockMatch[2] ?? '0', 10)
      const meridiem = clockMatch[3].toUpperCase()
      if (meridiem === 'AM' && hours === 12) hours = 0
      if (meridiem === 'PM' && hours !== 12) hours += 12
      const timeZone = clockMatch[4]
      if (timeZone) return nextResetInTimeZone(hours, minutes, timeZone, observedAtMs)
      const now = new Date(observedAtMs)
      const reset = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0)
      if (reset.getTime() <= now.getTime()) reset.setDate(reset.getDate() + 1)
      return Math.ceil(reset.getTime() / 1000)
    }

    return null
  }

  const detailsResult = resetDetailsSchema.safeParse(value)
  if (!detailsResult.success) return null
  const details = detailsResult.data
  for (const candidate of [
    details.resetsAt,
    details.resetAt,
    details.reset_at,
    details.retryAfter,
    details.retry_after,
    details.retryAfterSeconds,
    details.secondsUntilReset,
    details.resetInSeconds,
  ]) {
    const found = findResetTimestamp(candidate, observedAtMs)
    if (found) return found
  }

  return null
}

/** Convert provider prose such as "session limit · resets 4pm
 * (America/Toronto)" into the same canonical event as a native rate-limit
 * notification. Some Claude versions only expose this terminal error form. */
export function rateLimitEventFromMessage(
  message: string,
  rateLimitType = 'Claude',
  observedAtMs = Date.now(),
): RateLimitEvent | null {
  if (!/(?:rate|usage|session) limit/i.test(message)) return null
  const resetsAt = findResetTimestamp(message, observedAtMs)
  if (!resetsAt) return null
  return decorateRateLimit({
    type: 'rate_limit',
    status: 'limited',
    resetsAt,
    rateLimitType,
    isUsingOverage: false,
  })
}

function nextResetInTimeZone(hours: number, minutes: number, timeZone: string, observedAtMs: number): number | null {
  try {
    const now = observedAtMs
    const current = zonedParts(now, timeZone)
    let wallDate = Date.UTC(current.year, current.month - 1, current.day)
    let reset = zonedEpoch(wallDate, hours, minutes, timeZone)
    if (reset <= now) {
      wallDate += 86_400_000
      reset = zonedEpoch(wallDate, hours, minutes, timeZone)
    }
    return Math.ceil(reset / 1000)
  } catch {
    return null
  }
}

function zonedEpoch(wallDate: number, hours: number, minutes: number, timeZone: string): number {
  const date = new Date(wallDate)
  const targetAsUtc = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    hours,
    minutes,
  )
  let candidate = targetAsUtc
  for (let attempt = 0; attempt < 2; attempt++) {
    const actual = zonedParts(candidate, timeZone)
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute)
    candidate += targetAsUtc - actualAsUtc
  }
  return candidate
}

function zonedParts(epochMs: number, timeZone: string): ZonedDateTimeParts {
  const values = new Map(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(epochMs).map((part) => [part.type, part.value]),
  )
  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute')),
  }
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
    queuedPrompt: 'Queued safely. Solus will send it when the limit resets.',
  }
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
  }

  clearAll(): void {
    this.active.clear()
  }
}

function isBlockingRateLimit(event: RateLimitEvent): boolean {
  return event.status !== 'allowed' && !event.isUsingOverage
}
