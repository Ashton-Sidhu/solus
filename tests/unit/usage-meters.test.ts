import { describe, expect, test } from 'bun:test'
import { providerUsage, signInCommand, usageByProvider } from '@solus/workspace-ui/components/project-panel/lib/usage-meters'
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
  test('shows the selected Antigravity quota group and keeps other groups separate', () => {
    const snapshots = { antigravity: limits('antigravity', {
      fiveHour: null,
      weekly: null,
      modelGroups: [
        { id: 'gemini', label: 'Gemini', fiveHour: { usedPercent: 25, resetsAt: null, resetsLabel: null }, weekly: null },
        { id: '3p', label: 'Claude & GPT', fiveHour: null, weekly: { usedPercent: 100, resetsAt: NOW + 3_600_000, resetsLabel: null } },
        { id: 'gemini-carbon', label: 'Gemini Carbon', fiveHour: null, weekly: null },
      ],
    }) }
    const [row] = providerUsage([agent('antigravity')], snapshots, NOW, 'gemini-4-neon')
    expect(row.groups?.selected?.meters[0]?.remainingPercent).toBe(75)
    expect(row.groups?.other[0]?.meters[0]).toMatchObject({ remainingPercent: 0, resetPhrase: 'resets in 1h' })

    const [unmatched] = providerUsage([agent('antigravity')], snapshots, NOW, 'gemini-4-carbon', true)
    expect(unmatched.groups?.selected).toBeNull()
    expect(unmatched.groups?.other).toHaveLength(2)
    expect(unmatched.groups?.checkedAt).toBeTruthy()
  })

  test('drops Antigravity when its quota groups have no values', () => {
    const snapshots = { antigravity: limits('antigravity', {
      fiveHour: null,
      weekly: null,
      modelGroups: [{ id: 'gemini', label: 'Gemini', fiveHour: null, weekly: null }],
    }) }
    expect(providerUsage([agent('antigravity')], snapshots, NOW, 'gemini-4-neon')).toEqual([])
  })

  test('reports what is left, not what was spent', () => {
    const [row] = providerUsage([agent('codex')], { codex: limits('codex') }, NOW)
    expect(row.meters.map((meter) => meter.remainingPercent)).toEqual([60, 20])
    expect(row.meters.map((meter) => meter.resetPhrase)).toEqual(['resets in 2h', 'resets in 3d'])
  })

  test('adds Claude\'s Fable week after the all-models week', () => {
    const claude = limits('claude-code', { fableWeekly: { usedPercent: 75, resetsAt: NOW + 86_400_000, resetsLabel: null } })
    const [row] = providerUsage([agent('claude-code')], { 'claude-code': claude }, NOW)
    expect(row.meters.map((meter) => [meter.label, meter.remainingPercent])).toEqual([
      ['Session', 60],
      ['Weekly', 20],
      ['Fable weekly', 25],
    ])
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
    expect(row.meters[0].resetPhrase).toBe('resets in 3h 30m')
  })

  test('counts down from a remote Claude weekday in UTC', () => {
    const wednesdayNoon = Date.UTC(2025, 6, 30, 12, 0, 0, 0)
    const claude = limits('claude-code', {
      fiveHour: { usedPercent: 43, resetsAt: null, resetsLabel: 'Wednesday at 3:30pm (UTC)' },
      weekly: { usedPercent: 48, resetsAt: null, resetsLabel: 'Monday at 10am (UTC)' },
    })
    const [row] = providerUsage([agent('claude-code')], { 'claude-code': claude }, wednesdayNoon)
    expect(row.meters.map((meter) => meter.resetPhrase)).toEqual(['resets in 3h 30m', 'resets in 4d 22h'])
  })

  test('counts down from the comma-separated UTC date returned by a remote host', () => {
    const sixUtc = Date.UTC(2026, 7, 12, 6, 0, 0, 0)
    const claude = limits('claude-code', {
      fiveHour: { usedPercent: 20, resetsAt: null, resetsLabel: 'Aug 12, 9:40am (UTC)' },
      weekly: { usedPercent: 49, resetsAt: null, resetsLabel: 'Aug 13, 9pm (UTC)' },
    })
    const [row] = providerUsage([agent('claude-code')], { 'claude-code': claude }, sixUtc)
    expect(row.meters.map((meter) => meter.resetPhrase)).toEqual(['resets in 3h 40m', 'resets in 1d 15h'])
  })

  // The countdown carries the whole phrase because a window that is already due
  // has no duration to slot after "resets in".
  test('says a due window is resetting instead of counting down past zero', () => {
    const codex = limits('codex', {
      fiveHour: { usedPercent: 97, resetsAt: NOW - 1_000, resetsLabel: null },
      weekly: null,
    })
    const [row] = providerUsage([agent('codex')], { codex }, NOW)
    expect(row.meters[0].resetPhrase).toBe('resetting now')
  })

  test('falls back to the provider wording when the label is unreadable', () => {
    const claude = limits('claude-code', {
      fiveHour: { usedPercent: 10, resetsAt: null, resetsLabel: 'soon-ish' },
      weekly: null,
    })
    const [row] = providerUsage([agent('claude-code')], { 'claude-code': claude }, NOW)
    expect(row.meters[0].resetPhrase).toBe('resets in soon-ish')
  })

  // An Enterprise seat has only a monthly spend cap; it has no reset time to show.
  test('shows a spend cap as a Monthly meter with no countdown', () => {
    const [row] = providerUsage(
      [agent('claude-code')],
      { 'claude-code': limits('claude-code', { fiveHour: null, weekly: null, monthly: { usedPercent: 31.459, resetsAt: null, resetsLabel: null } }) },
      NOW,
    )
    expect(row.meters).toEqual([
      { key: 'monthly', label: 'Monthly', remainingPercent: 68.541, tone: 'ok', resetPhrase: null },
    ])
  })

  test('drops providers that are unavailable or report nothing', () => {
    const rows = providerUsage(
      [agent('claude-code', { available: false }), agent('codex')],
      { 'claude-code': limits('claude-code'), codex: limits('codex', { fiveHour: null, weekly: null }) },
      NOW,
    )
    expect(rows).toEqual([])
  })

  test('keeps cached quota after a failed read if it has values', () => {
    const rows = providerUsage(
      [agent('claude-code'), agent('codex'), agent('antigravity')],
      {
        'claude-code': limits('claude-code', { fiveHour: null, weekly: null, stale: true }),
        codex: limits('codex', { stale: true }),
      },
      NOW,
    )
    expect(rows).toEqual([
      expect.objectContaining({ provider: 'codex', stale: true }),
    ])
    expect(rows[0]?.meters.map((meter) => meter.remainingPercent)).toEqual([60, 20])
  })

  test('drops API billing and signed-out providers with no quota windows', () => {
    const rows = providerUsage([agent('claude-code'), agent('codex')], {
      'claude-code': limits('claude-code', { fiveHour: null, weekly: null, usageMode: 'api' }),
      codex: limits('codex', { fiveHour: null, weekly: null, usageMode: 'signed_out' }),
    }, NOW)
    expect(rows).toEqual([])
  })

  test('usageByProvider prefers the built-in primary instance over extra configured instances', () => {
    const primary = limits('codex', { instanceId: 'codex', instanceLabel: 'Codex', fiveHour: { usedPercent: 20, resetsAt: null, resetsLabel: null } })
    const extra = limits('codex', { instanceId: 'work-codex', instanceLabel: 'Work Codex', fiveHour: { usedPercent: 90, resetsAt: null, resetsLabel: null } })
    const byProvider = usageByProvider([primary, extra])
    expect(byProvider.codex?.fiveHour?.usedPercent).toBe(20)
  })
})

test('gives the Codex sign-in command for usage details', () => {
  expect(signInCommand('codex')).toBe('codex login')
})
