import { describe, expect, test } from 'bun:test'
import { providerUsage } from '@solus/workspace-ui/components/project-panel/lib/usage-meters'
import type { AgentMetadata, AgentUsageLimits } from '@solus/contracts/types'

const NOW = 1_700_000_000_000

function agent(id: string, overrides: Partial<AgentMetadata> = {}): AgentMetadata {
  return { id: id as AgentMetadata['id'], label: id === 'claude-code' ? 'Claude' : 'Codex', models: [], defaultModel: 'x', ...overrides }
}

function limits(id: string, overrides: Partial<AgentUsageLimits> = {}): AgentUsageLimits {
  return {
    provider: id as AgentUsageLimits['provider'],
    fiveHour: { usedPercent: 40, resetsAt: NOW + 2 * 3_600_000, resetsLabel: null },
    weekly: { usedPercent: 80, resetsAt: NOW + 3 * 86_400_000, resetsLabel: null },
    planType: 'Max',
    fetchedAt: NOW,
    stale: false,
    ...overrides,
  }
}

describe('providerUsage', () => {
  test('reports what is left, not what was spent', () => {
    const [row] = providerUsage([agent('codex')], { codex: limits('codex') }, NOW)
    expect(row.meters.map((meter) => meter.remainingPercent)).toEqual([60, 20])
    expect(row.meters.map((meter) => meter.resetText)).toEqual(['2h', '3d'])
  })

  test('tints by how close a window is to exhaustion', () => {
    const [row] = providerUsage([agent('codex')], { codex: limits('codex') }, NOW)
    // 60% left is unremarkable; 20% left is the point a user needs to notice.
    expect(row.meters.map((meter) => meter.tone)).toEqual(['ok', 'low'])
  })

  // Claude reports no epoch, only localized text — it still has to become a
  // countdown, since "Jul 31 at 1am" alone doesn't answer "how long do I have".
  test('counts down from Claude label wording', () => {
    const noon = new Date(2025, 6, 30, 12, 0, 0, 0).getTime()
    const claude = limits('claude-code', {
      fiveHour: { usedPercent: 43, resetsAt: null, resetsLabel: 'Jul 30 at 3:30pm (America/Toronto)' },
      weekly: null,
    })
    const [row] = providerUsage([agent('claude-code')], { 'claude-code': claude }, noon)
    expect(row.meters).toHaveLength(1)
    expect(row.meters[0].resetText).toBe('3h 30m')
  })

  test('counts down from a remote Claude weekday in UTC', () => {
    const wednesdayNoon = Date.UTC(2025, 6, 30, 12, 0, 0, 0)
    const claude = limits('claude-code', {
      fiveHour: { usedPercent: 43, resetsAt: null, resetsLabel: 'Wednesday at 3:30pm (UTC)' },
      weekly: { usedPercent: 48, resetsAt: null, resetsLabel: 'Monday at 10am (UTC)' },
    })
    const [row] = providerUsage([agent('claude-code')], { 'claude-code': claude }, wednesdayNoon)
    expect(row.meters.map((meter) => meter.resetText)).toEqual(['3h 30m', '4d 22h'])
  })

  test('counts down from the comma-separated UTC date returned by a remote host', () => {
    const sixUtc = Date.UTC(2026, 7, 12, 6, 0, 0, 0)
    const claude = limits('claude-code', {
      fiveHour: { usedPercent: 20, resetsAt: null, resetsLabel: 'Aug 12, 9:40am (UTC)' },
      weekly: { usedPercent: 49, resetsAt: null, resetsLabel: 'Aug 13, 9pm (UTC)' },
    })
    const [row] = providerUsage([agent('claude-code')], { 'claude-code': claude }, sixUtc)
    expect(row.meters.map((meter) => meter.resetText)).toEqual(['3h 40m', '1d 15h'])
  })

  test('falls back to the provider wording when the label is unreadable', () => {
    const claude = limits('claude-code', {
      fiveHour: { usedPercent: 10, resetsAt: null, resetsLabel: 'soon-ish' },
      weekly: null,
    })
    const [row] = providerUsage([agent('claude-code')], { 'claude-code': claude }, NOW)
    expect(row.meters[0].resetText).toBe('soon-ish')
  })

  // A meterless row would read as "no quota left" rather than "no quota data".
  test('drops providers that are unavailable or report nothing', () => {
    const rows = providerUsage(
      [agent('claude-code', { available: false }), agent('codex')],
      { 'claude-code': limits('claude-code'), codex: limits('codex', { fiveHour: null, weekly: null }) },
      NOW,
    )
    expect(rows).toEqual([])
  })

  // Claude's quota comes from an account endpoint that can answer empty or
  // rate-limited. Dropping the row then would claim the provider has no quota,
  // when the truth is that nobody could read it.
  test('keeps a meterless row when the read failed', () => {
    const rows = providerUsage(
      [agent('claude-code')],
      { 'claude-code': limits('claude-code', { fiveHour: null, weekly: null, stale: true }) },
      NOW,
    )
    expect(rows).toEqual([
      { provider: 'claude-code', label: 'Claude', stale: true, meters: [], status: 'unavailable' },
    ])
  })

  test('describes API billing instead of treating missing subscription windows as a failed read', () => {
    const rows = providerUsage(
      [agent('codex')],
      { codex: limits('codex', { fiveHour: null, weekly: null, usageMode: 'api' }) },
      NOW,
    )

    expect(rows).toEqual([
      { provider: 'codex', label: 'Codex', stale: false, meters: [], status: 'api' },
    ])
  })
})
