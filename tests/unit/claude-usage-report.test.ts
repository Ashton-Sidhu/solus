import { describe, expect, test } from 'bun:test'
import { parseClaudeUsageReport } from '@solus/server/agents/claude/claude-usage'

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
