import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import {
  decorateRateLimit,
  findResetTimestamp,
  normalizeResetNumber,
  RateLimitState,
} from '../../src/main/rate-limits'
import type { NormalizedEvent } from '../../src/shared/types'

type RateLimitEvent = Extract<NormalizedEvent, { type: 'rate_limit' }>

describe('rate-limit parsing', () => {
  afterEach(() => setSystemTime())

  test('normalizes milliseconds, absolute seconds, relative seconds, and invalid reset values', () => {
    setSystemTime(new Date('2026-01-01T00:00:00Z'))

    expect(normalizeResetNumber(1767225900000)).toBe(1767225900)
    expect(normalizeResetNumber(1767225900)).toBe(1767225900)
    expect(normalizeResetNumber(300)).toBe(1767225900)
    expect(normalizeResetNumber(0)).toBeNull()
    expect(normalizeResetNumber(Number.POSITIVE_INFINITY)).toBeNull()
  })

  test('finds reset timestamps from provider-neutral payload shapes', () => {
    setSystemTime(new Date('2026-01-01T10:00:00-05:00'))

    expect(findResetTimestamp(1767225900000)).toBe(1767225900)
    expect(findResetTimestamp('2026-01-01T16:00:00Z')).toBe(1767283200)
    expect(findResetTimestamp('usage limit reached, try again at 4:00 PM')).toBe(Math.ceil(new Date(2026, 0, 1, 16, 0, 0, 0).getTime() / 1000))
    expect(findResetTimestamp({ nested: true, retryAfterSeconds: 120 })).toBe(1767279720)
    expect(findResetTimestamp(null)).toBeNull()
  })

  test('rolls prose reset times to tomorrow when today has passed', () => {
    setSystemTime(new Date('2026-01-01T16:00:00-05:00'))

    expect(findResetTimestamp('usage limit reached, try again at 3:00 PM')).toBe(Math.ceil(new Date(2026, 0, 2, 15, 0, 0, 0).getTime() / 1000))
  })
})

describe('decorateRateLimit', () => {
  test('adds shared display info and message', () => {
    const event: RateLimitEvent = {
      type: 'rate_limit',
      status: 'limited',
      resetsAt: 1767225900,
      rateLimitType: 'Codex 5h',
      usedPercent: 100,
      isUsingOverage: false,
    }

    expect(decorateRateLimit(event)).toEqual({
      ...event,
      info: {
        resetsAt: 1767225900,
        rateLimitType: 'Codex 5h',
        prompt: 'Solus is taking a short breather before trying again.',
        queuedPrompt: 'Queued safely. Solus will send it when the limit resets.',
      },
      message: `Rate limited (Codex 5h, 100% used). Resets at ${new Date(1767225900 * 1000).toLocaleString()}.`,
    })
  })

  test('returns already-decorated events unchanged', () => {
    const event: RateLimitEvent = {
      type: 'rate_limit',
      status: 'limited',
      resetsAt: 1767225900,
      rateLimitType: 'Claude',
      info: {
        resetsAt: 1767225900,
        rateLimitType: 'Claude',
        prompt: 'Custom prompt',
        queuedPrompt: 'Custom queue copy',
      },
      message: 'Custom message',
    }

    expect(decorateRateLimit(event)).toBe(event)
  })
})

describe('RateLimitState', () => {
  test('stores blocking events, deduplicates warnings, expires current state, and clears sessions', () => {
    const state = new RateLimitState()
    const blocking: RateLimitEvent = {
      type: 'rate_limit',
      status: 'limited',
      resetsAt: 200,
      rateLimitType: 'Claude',
      isUsingOverage: false,
    }

    const recordedBlocking = state.record('session-1', blocking)
    expect(recordedBlocking?.info?.rateLimitType).toBe('Claude')
    expect(state.current('session-1', 199)?.resetsAt).toBe(200)
    expect(state.current('session-1', 200)).toBeNull()
    expect(state.hasActive('session-1')).toBe(false)

    const warning: RateLimitEvent = {
      type: 'rate_limit',
      status: 'allowed_warning',
      resetsAt: 300,
      rateLimitType: 'Codex 5h',
    }
    expect(state.record('session-1', warning)).not.toBeNull()
    expect(state.record('session-1', warning)).toBeNull()
    expect(state.record('session-1', { ...warning, resetsAt: 301 })).not.toBeNull()

    state.record('session-1', { ...blocking, resetsAt: 400 })
    expect(state.hasActive('session-1')).toBe(true)
    state.clear('session-1')
    expect(state.hasActive('session-1')).toBe(false)
  })
})
