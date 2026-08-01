import { describe, expect, test } from 'bun:test'
import { providerUsage } from '../../src/renderer/components/project-panel/lib/usage-meters'
import type { AgentMetadata, AgentUsageLimits } from '../../src/shared/types'

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
})
