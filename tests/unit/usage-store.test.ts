import { describe, expect, test } from 'bun:test'
import { CodexTurnNormalizer } from '@solus/server/agents/codex/codex-event-normalizer'
import { UsageLimitsStore } from '@solus/server/usage/usage-store'
import type { NormalizedEvent } from '@solus/contracts/types'

const NOW = Date.parse('2026-09-09T17:32:22Z')
/** The weekly reset Codex reported all through session 01a0865c. */
const WEEKLY_RESET_MS = 1789446377_000

describe('UsageLimitsStore', () => {
  // The reset that could not be detected. Codex stated 1789446377 on the
  // stream from 13:20 onward, then reported the limit as a terminal error
  // naming no window at all. The store is what carries the epoch across that
  // gap, so the limit gets the real Sep 15 reset instead of a five-minute guess.
  test('answers a limit that names no window when one window is open', () => {
    const store = new UsageLimitsStore()
    store.applyWindows('codex', [
      { windowDurationMins: 10_080, usedPercent: 100, resetsAt: WEEKLY_RESET_MS },
    ], NOW)

    expect(store.resetsAtFor('codex', undefined, NOW)).toBe(1789446377)
    expect(store.resetsAtFor('codex', 10_080, NOW)).toBe(1789446377)
  })

  // Guessing here would hold a prompt for a week when the five-hour window was
  // what stopped it. Saying nothing lets the surfaces drop the countdown.
  test('declines when two windows are open and the limit names neither', () => {
    const store = new UsageLimitsStore()
    store.applyWindows('codex', [
      { windowDurationMins: 300, usedPercent: 100, resetsAt: NOW + 3_600_000 },
      { windowDurationMins: 10_080, usedPercent: 40, resetsAt: WEEKLY_RESET_MS },
    ], NOW)

    expect(store.resetsAtFor('codex', undefined, NOW)).toBeNull()
    expect(store.resetsAtFor('codex', 300, NOW)).toBe(Math.ceil((NOW + 3_600_000) / 1000))
  })

  // Claude reports one window per event. A five-hour update must not erase the
  // weekly reset standing beside it, or the next weekly limit has no answer.
  test('merges one window at a time without dropping the other', () => {
    const store = new UsageLimitsStore()
    store.applyWindows('claude-code', [
      { windowDurationMins: 10_080, usedPercent: null, resetsAt: WEEKLY_RESET_MS },
    ], NOW)
    store.applyWindows('claude-code', [
      { windowDurationMins: 300, usedPercent: null, resetsAt: NOW + 600_000 },
    ], NOW)

    expect(store.resetsAtFor('claude-code', 10_080, NOW)).toBe(1789446377)
    expect(store.resetsAtFor('claude-code', 300, NOW)).toBe(Math.ceil((NOW + 600_000) / 1000))
  })

  // A window whose reset has passed has reopened; it is not an answer to "when
  // does the limit that just stopped me lift".
  test('declines a reset that has already passed, and an unknown provider', () => {
    const store = new UsageLimitsStore()
    store.applyWindows('codex', [
      { windowDurationMins: 10_080, usedPercent: 100, resetsAt: NOW - 60_000 },
    ], NOW)

    expect(store.resetsAtFor('codex', 10_080, NOW)).toBeNull()
    expect(store.resetsAtFor('claude-code', 10_080, NOW)).toBeNull()
  })

  // The whole seam, on the payloads session 01a0865c actually produced: the
  // stream update at 13:31:36, then the usageLimitExceeded error at 13:32:22
  // whose only reset is unparsed prose. The old path answered "now + 5 min" and
  // released the queue on Sep 9; the store answers Sep 15, as Codex said.
  test('resolves the reported session end to end, from stream to terminal error', () => {
    const normalizer = new CodexTurnNormalizer({ planMode: false })
    const store = new UsageLimitsStore()
    const record = (events: NormalizedEvent[]): NormalizedEvent[] => {
      for (const event of events) {
        if (event.type === 'usage_limits') store.applyWindows('codex', event.windows, NOW)
      }
      return events
    }

    record(normalizer.push({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: 1789446377 },
          secondary: null,
          credits: { hasCredits: false },
          planType: 'prolite',
          rateLimitReachedType: null,
        },
      },
    }))

    const failed = record(normalizer.push({
      method: 'turn/completed',
      params: {
        threadId: '01a0865c-d1db-7852-b02b-21d272a08525',
        turnId: '01a0865c-d36c-74f2-8f3b-8e1f4ab1ba3f',
        turn: {
          id: '01a0865c-d36c-74f2-8f3b-8e1f4ab1ba3f',
          status: 'failed',
          error: {
            message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 15th, 2026 12:26 AM.",
            codexErrorInfo: 'usageLimitExceeded',
            additionalDetails: null,
          },
        },
      },
    }))

    const limit = failed.find((event) => event.type === 'rate_limit')
    expect(limit).toMatchObject({ type: 'rate_limit', resetsAt: null, rateLimitType: 'usageLimitExceeded' })

    // The store retains the provider epoch; retry policy is applied by the control plane.
    expect(store.resetsAtFor('codex', limit?.type === 'rate_limit' ? limit.windowDurationMins : undefined, NOW))
      .toBe(1789446377)
  })

  // The polled read is a full snapshot and replaces; a stale mark keeps the
  // numbers so a watching panel does not blank on one transient failure.
  test('keeps last-good windows when a refresh fails', () => {
    const store = new UsageLimitsStore()
    store.apply({
      provider: 'codex',
      fiveHour: null,
      weekly: { usedPercent: 100, resetsAt: WEEKLY_RESET_MS, resetsLabel: null },
      planType: 'prolite',
      fetchedAt: NOW,
      stale: false,
    })
    store.markStale('codex', 'no_report')

    expect(store.get('codex')?.stale).toBe(true)
    expect(store.resetsAtFor('codex', 10_080, NOW)).toBe(1789446377)
  })
})
