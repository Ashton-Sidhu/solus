import { describe, expect, test } from 'bun:test'
import type { SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk'
import { claudeUsageFromApi, parseClaudeUsageReport } from '@solus/server/execution/agents/claude/claude-usage'

// Verbatim `claude -p "/usage" --output-format json` result text. The trailing
// breakdown and the per-model week line are what make position-based parsing
// unsafe, so they stay in the fixture.
const REPORT = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 43% used · resets Jul 31 at 1am (America/Toronto)',
  'Current week (all models): 8% used · resets Aug 6 at 4:59pm (America/Toronto)',
  'Current week (Fable): 2% used · resets Aug 6 at 4:59pm (America/Toronto)',
  '',
  "What's contributing to your limits usage?",
  'Last 24h · 3425 requests · 59 sessions',
  '  58% of your usage was at >150k context',
].join('\n')

describe('parseClaudeUsageReport', () => {
  test('reads both windows, and the all-models week rather than a per-model one', () => {
    const usage = parseClaudeUsageReport(REPORT)
    expect(usage?.fiveHour).toEqual({
      usedPercent: 43,
      resetsAt: null,
      resetsLabel: 'Jul 31 at 1am (America/Toronto)',
    })
    // Not 2% — the Fable line sits directly below and would win on position.
    expect(usage?.weekly?.usedPercent).toBe(8)
    expect(usage?.weekly?.resetsLabel).toBe('Aug 6 at 4:59pm (America/Toronto)')
  })

  // Fable has a week of its own; it is the per-model limit a Fable user hits first.
  test('reads the Fable week apart from the all-models week', () => {
    expect(parseClaudeUsageReport(REPORT)?.fableWeekly).toEqual({
      usedPercent: 2,
      resetsAt: null,
      resetsLabel: 'Aug 6 at 4:59pm (America/Toronto)',
    })
    const noFable = parseClaudeUsageReport('Current week (all models): 8% used · resets Aug 6 at 4:59pm (America/Toronto)')
    expect(noFable?.fableWeekly).toBeNull()
  })

  test('keeps the window it can read when the other is absent', () => {
    const weeklyOnly = parseClaudeUsageReport(
      'Current week (all models): 8% used · resets Aug 6 at 4:59pm (America/Toronto)',
    )
    expect(weeklyOnly?.fiveHour).toBeNull()
    expect(weeklyOnly?.weekly?.usedPercent).toBe(8)
  })

  test('reads a session window that has not opened yet, which prints no reset', () => {
    // Before the first request of a 5-hour block there is nothing to reset, so
    // the clause is absent. Dropping the window here hid the meter at the start
    // of every block — 0% used is exactly when it is worth reading.
    const fresh = parseClaudeUsageReport('Current session: 0% used')
    expect(fresh?.fiveHour).toEqual({ usedPercent: 0, resetsAt: null, resetsLabel: null })
  })

  test('returns null on a report it cannot read, so no number is invented', () => {
    // A wording change must surface as "unknown" and let the cache go stale —
    // showing a fabricated or dead percentage is worse than showing nothing.
    expect(parseClaudeUsageReport('Usage: session 43 percent, week 8 percent')).toBeNull()
    expect(parseClaudeUsageReport('')).toBeNull()
  })
})

// Shaped like the SDK's `usage_EXPERIMENTAL_...` answer; only the fields the
// mapping reads are filled.
function apiResponse(overrides: Partial<SDKControlGetUsageResponse>): SDKControlGetUsageResponse {
  return {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 43, resets_at: '2026-07-31T05:00:00Z' },
      seven_day: { utilization: 8.5, resets_at: '2026-08-06T20:59:00Z' },
      model_scoped: [{ display_name: 'Fable', utilization: 2, resets_at: '2026-08-06T20:59:00Z' }],
    },
    behaviors: null,
    ...overrides,
  } as SDKControlGetUsageResponse
}

describe('claudeUsageFromApi', () => {
  test('keeps the percent as given, the exact reset time, and the plan tier', () => {
    const usage = claudeUsageFromApi(apiResponse({}))
    // The SDK reports 0-100, the same unit as the meter: 43 stays 43, not 4300.
    expect(usage?.fiveHour).toEqual({
      usedPercent: 43,
      resetsAt: Date.parse('2026-07-31T05:00:00Z'),
      resetsLabel: null,
    })
    // The all-models week, not the per-model Fable window.
    expect(usage?.weekly?.usedPercent).toBe(8.5)
    expect(usage?.weekly?.resetsAt).toBe(Date.parse('2026-08-06T20:59:00Z'))
    expect(usage?.planType).toBe('max')
  })

  test('keeps the Fable week from the per-model windows, matched by its label', () => {
    expect(claudeUsageFromApi(apiResponse({}))?.fableWeekly).toEqual({
      usedPercent: 2,
      resetsAt: Date.parse('2026-08-06T20:59:00Z'),
      resetsLabel: null,
    })
    const otherModelOnly = claudeUsageFromApi(apiResponse({
      rate_limits: {
        five_hour: { utilization: 43, resets_at: null },
        model_scoped: [{ display_name: 'Opus', utilization: 50, resets_at: null }],
      },
    }))
    expect(otherModelOnly?.fableWeekly).toBeNull()
  })

  test('reports no data when plan limits do not apply, rather than 0%', () => {
    expect(claudeUsageFromApi(apiResponse({ rate_limits_available: false, rate_limits: null }))).toBeNull()
    expect(claudeUsageFromApi(apiResponse({ rate_limits: null }))).toBeNull()
  })

  test('drops a window with no utilization and keeps a window with no reset', () => {
    const usage = claudeUsageFromApi(apiResponse({
      rate_limits: {
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: null, resets_at: '2026-08-06T20:59:00Z' },
      },
    }))
    expect(usage?.fiveHour).toEqual({ usedPercent: 0, resetsAt: null, resetsLabel: null })
    expect(usage?.weekly).toBeNull()
  })

  // An Enterprise seat has no 5h or weekly window; its limit is a monthly spend
  // cap. Reading that as "no data" left the meter marked unavailable for good.
  test('reads an Enterprise seat\'s monthly spend cap when no window is reported', () => {
    const usage = claudeUsageFromApi(apiResponse({
      subscription_type: 'enterprise',
      rate_limits: {
        five_hour: null,
        seven_day: null,
        extra_usage: { is_enabled: true, monthly_limit: 100000, used_credits: 31459, utilization: 31.459 },
      },
    }))
    expect(usage).toEqual({
      fiveHour: null,
      weekly: null,
      monthly: { usedPercent: 31.459, resetsAt: null, resetsLabel: null },
      planType: 'enterprise',
    })
  })

  test('works out the spend cap percent from credits when utilization is missing', () => {
    const usage = claudeUsageFromApi(apiResponse({
      rate_limits: {
        five_hour: null,
        seven_day: null,
        extra_usage: { is_enabled: true, monthly_limit: 200, used_credits: 50, utilization: null },
      },
    }))
    expect(usage?.monthly?.usedPercent).toBe(25)
  })

  // On a Pro or Max seat, extra usage is overage beyond the windows, not the
  // limit, so it must not appear as one.
  test('ignores extra usage on a seat that reports windows', () => {
    const usage = claudeUsageFromApi(apiResponse({
      rate_limits: {
        five_hour: { utilization: 10, resets_at: null },
        seven_day: null,
        extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 100, utilization: 2 },
      },
    }))
    expect(usage?.monthly).toBeUndefined()
  })

  test('reports no data when there is neither a window nor a spend limit', () => {
    expect(claudeUsageFromApi(apiResponse({
      rate_limits: {
        five_hour: null,
        seven_day: null,
        extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
      },
    }))).toBeNull()
  })
})
