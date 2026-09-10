import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import {
  decorateRateLimit,
  isRateLimitMessage,
  isWindowClosed,
  normalizeResetNumber,
  RateLimitState,
} from '@solus/server/rate-limits'
import type { NormalizedEvent } from '@solus/contracts/types'

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

  // A terminal error reports that the account is spent and nothing else. Its
  // reset wording — Codex's "try again at Sep 15th, 2026 12:26 AM", Claude's
  // "resets 4pm" with no year — is deliberately not read: parsing it produced
  // the wrong countdowns this module used to hand out, and `UsageLimitsStore`
  // holds the epoch the same providers already stated on the stream.
  test('recognizes a spent-account message without reading a time out of it', () => {
    expect(isRateLimitMessage(
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 15th, 2026 12:26 AM.",
    )).toBe(true)
    expect(isRateLimitMessage("You've hit your session limit · resets 4pm (America/Toronto)")).toBe(true)
    expect(isRateLimitMessage('The model produced an invalid tool call.')).toBe(false)
  })
})

describe('decorateRateLimit', () => {
  // The card is the only surface a limit gets, and it reads `info`. Nothing
  // renders prose about a limit, so nothing here writes any.
  test('adds the shared display info the card reads', () => {
    const event: RateLimitEvent = {
      type: 'rate_limit',
      status: 'limited',
      resetsAt: 1767225900,
      rateLimitType: 'Codex 5h',
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
    })
  })

  // With no reset there is no moment to promise, so the queue copy stops
  // promising one rather than counting down to a time nobody knows.
  test('drops the reset promise when no window reset is known', () => {
    expect(decorateRateLimit({
      type: 'rate_limit',
      status: 'limited',
      resetsAt: null,
      rateLimitType: 'usageLimitExceeded',
      isUsingOverage: false,
    }).info).toEqual({
      resetsAt: null,
      rateLimitType: 'usageLimitExceeded',
      prompt: 'Solus is taking a short breather before trying again.',
      queuedPrompt: 'Queued safely. Solus will send it when you say so.',
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
    }

    expect(decorateRateLimit(event)).toBe(event)
  })
})

describe('RateLimitState', () => {
  test('stores blocking events, expires current state, and clears sessions', () => {
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

    state.record('session-1', { ...blocking, resetsAt: 400 })
    expect(state.hasActive('session-1')).toBe(true)
    state.clear('session-1')
    expect(state.hasActive('session-1')).toBe(false)
  })

  // Nothing knows when this one lifts, so no clock may retire it. It stands
  // until the session is cleared or the user sends anyway.
  test('a limit with no known reset never expires on its own', () => {
    const state = new RateLimitState()
    state.record('session-1', {
      type: 'rate_limit',
      status: 'limited',
      resetsAt: null,
      rateLimitType: 'usageLimitExceeded',
      isUsingOverage: false,
    })

    expect(state.current('session-1', Date.now() / 1000)).not.toBeNull()
    expect(state.current('session-1', Number.MAX_SAFE_INTEGER)).not.toBeNull()
    state.clear('session-1')
    expect(state.hasActive('session-1')).toBe(false)
  })

  // `current` is the clock's reading and retires a limit whose window reopened.
  // `peek` is the parked fact, which the card still asking what to do with the
  // held prompt reads: a window reopening is not an answer to that question.
  test('peek keeps a limit its own window has outlived', () => {
    const state = new RateLimitState()
    state.record('session-1', {
      type: 'rate_limit',
      status: 'limited',
      resetsAt: 200,
      rateLimitType: 'Claude',
      isUsingOverage: false,
    })

    expect(state.peek('session-1')?.resetsAt).toBe(200)
    expect(isWindowClosed(state.peek('session-1')!, 199)).toBe(true)
    expect(isWindowClosed(state.peek('session-1')!, 201)).toBe(false)
    expect(state.current('session-1', 201)).toBeNull()
    expect(state.peek('session-1')).toBeNull()
  })

  test('a window using overage is reported but does not block the session', () => {
    const state = new RateLimitState()

    const recorded = state.record('session-1', {
      type: 'rate_limit',
      status: 'limited',
      resetsAt: 400,
      rateLimitType: 'seven_day',
      isUsingOverage: true,
    })

    expect(recorded).not.toBeNull()
    expect(state.hasActive('session-1')).toBe(false)
  })
})
