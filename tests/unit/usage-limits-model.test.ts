import { describe, expect, test } from 'bun:test'
import {
  accountHue,
  buildPooledBarSegments,
  buildUsageOverview,
  emailInitials,
  filterUsageOverview,
  formatLiveDuration,
  formatLiveResetCountdown,
  formatUsagePercent,
  groupUsageWindowsByModelGroup,
  hasUsageSectionContent,
  maskEmail,
  paceLabel,
  unsupportedAccountOf,
  usageUnsupportedMessage,
  type HostUsageInput,
} from '@solus/client-core/usage-limits'
import type { AgentUsageLimits } from '@solus/contracts/types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 10, 27, 12, 0, 0)

function makeSnapshot(overrides: Partial<AgentUsageLimits> = {}): AgentUsageLimits {
  return {
    provider: 'codex',
    fiveHour: { usedPercent: 40, resetsAt: NOW + 2 * HOUR, resetsLabel: null },
    weekly: { usedPercent: 30, resetsAt: NOW + 4 * DAY, resetsLabel: null },
    planType: 'Plus',
    usageMode: 'subscription',
    fetchedAt: NOW,
    stale: false,
    ...overrides,
  }
}

function makeHost(overrides: Partial<HostUsageInput> = {}): HostUsageInput {
  return {
    serverId: 'host-1',
    label: 'MacBook Pro',
    connected: true,
    state: 'ready',
    snapshots: [],
    ...overrides,
  }
}

describe('buildUsageOverview', () => {
  test('computes even-pace markers and pace labels for session and weekly windows', () => {
    // 5h window with 2.5h left => 50% time elapsed, 50% time left.
    // 70% used (> 55%) => ahead of pace; 30% used (< 45%) => under pace; 52% used => on pace.
    const overview = buildUsageOverview(
      [
        makeHost({
          snapshots: [
            makeSnapshot({
              provider: 'claude-code',
              fiveHour: { usedPercent: 70, resetsAt: NOW + 2.5 * HOUR, resetsLabel: null },
              weekly: { usedPercent: 20, resetsAt: NOW + 3.5 * DAY, resetsLabel: null },
            }),
            makeSnapshot({
              provider: 'codex',
              fiveHour: { usedPercent: 52, resetsAt: NOW + 2.5 * HOUR, resetsLabel: null },
              weekly: null,
            }),
          ],
        }),
      ],
      NOW,
    )

    const claude = overview.providers.find((group) => group.provider === 'claude-code')!
    expect(claude.windows[0]).toMatchObject({
      id: 'fiveHour',
      remainingPercent: 30,
      paceRemainingPercent: 50,
      paceUsedPercent: 50,
      pace: 'ahead',
      tone: 'low',
    })
    expect(claude.windows[1]).toMatchObject({
      id: 'weekly',
      remainingPercent: 80,
      paceRemainingPercent: 50,
      pace: 'under',
      tone: 'ok',
    })
    expect(paceLabel('ahead')).toBe('Ahead of pace')
    expect(paceLabel('on')).toBe('On pace')
    expect(paceLabel('under')).toBe('Under pace')

    const codex = overview.providers.find((group) => group.provider === 'codex')!
    expect(codex.windows[0]).toMatchObject({
      id: 'fiveHour',
      pace: 'on',
      paceRemainingPercent: 50,
    })
  })

  // The Fable week must not pool into, or hide behind, the all-models week.
  test('shows Claude\'s Fable week as its own weekly window', () => {
    const overview = buildUsageOverview(
      [makeHost({ snapshots: [makeSnapshot({
        provider: 'claude-code',
        fableWeekly: { usedPercent: 90, resetsAt: NOW + 3 * DAY, resetsLabel: null },
      })] })],
      NOW,
    )
    const claude = overview.providers.find((group) => group.provider === 'claude-code')!
    expect(claude.windows.map((window) => [window.id, window.label])).toEqual([
      ['fiveHour', 'Session'],
      ['weekly', 'Weekly'],
      ['fableWeekly', 'Fable weekly'],
    ])
    expect(claude.windows[2]).toMatchObject({ kind: 'weekly', remainingPercent: 10, tone: 'spent' })
  })

  test('suppresses session availability when weekly limit reaches 100% used', () => {
    const weeklyReset = NOW + 2 * DAY
    const sessionReset = NOW + 3 * HOUR
    const overview = buildUsageOverview(
      [
        makeHost({
          snapshots: [
            makeSnapshot({
              provider: 'codex',
              fiveHour: { usedPercent: 25, resetsAt: sessionReset, resetsLabel: null },
              weekly: { usedPercent: 100, resetsAt: weeklyReset, resetsLabel: null },
            }),
          ],
        }),
      ],
      NOW,
    )

    const sessionWindow = overview.providers[0]!.windows.find((w) => w.id === 'fiveHour')!
    expect(sessionWindow.remainingPercent).toBe(0)
    expect(sessionWindow.usedPercent).toBe(100)
    expect(sessionWindow.tone).toBe('spent')
    expect(sessionWindow.pace).toBeNull()
    expect(sessionWindow.members[0]!.window.suppressedByWeekly).toBe(true)
    expect(sessionWindow.members[0]!.window.resetsAt).toBe(weeklyReset)
  })

  test('deduplicates the same account email across multiple hosts and keeps the freshest read', () => {
    const overview = buildUsageOverview(
      [
        makeHost({
          serverId: 'laptop',
          label: 'Laptop',
          snapshots: [
            makeSnapshot({
              provider: 'codex',
              accountEmail: 'alex@example.com',
              fiveHour: { usedPercent: 60, resetsAt: NOW + 2 * HOUR, resetsLabel: null },
              weekly: null,
              fetchedAt: NOW - 10 * MINUTE,
            }),
          ],
        }),
        makeHost({
          serverId: 'desktop',
          label: 'Studio',
          snapshots: [
            makeSnapshot({
              provider: 'codex',
              accountEmail: 'ALEX@example.com',
              fiveHour: { usedPercent: 45, resetsAt: NOW + 2 * HOUR, resetsLabel: null },
              weekly: null,
              fetchedAt: NOW - MINUTE,
            }),
          ],
        }),
      ],
      NOW,
    )

    expect(overview.providers).toHaveLength(1)
    const codex = overview.providers[0]!
    expect(codex.accounts).toHaveLength(1)
    expect(codex.accounts[0]!.hosts.map((host) => host.label)).toEqual(['Laptop', 'Studio'])
    expect(codex.windows[0]!.remainingPercent).toBe(55)
  })

  test('pools multiple instances per harness using plan capacity weights and computes next refill', () => {
    // Plus (weight 1) at 100% used resetting in 1h; Pro 100 (weight 5) at 40% used resetting in 4h.
    // Weighted used = (100*1 + 40*5) / 6 = 300 / 6 = 50% used => 50% left.
    // Next refill is the Plus account in 1h restoring round(100 * 1 / 6) = 17% of the pool.
    const overview = buildUsageOverview(
      [
        makeHost({
          snapshots: [
            makeSnapshot({
              provider: 'codex',
              instanceId: 'codex',
              instanceLabel: 'Personal Codex',
              accountEmail: 'personal@example.com',
              planType: 'ChatGPT Plus Subscription',
              fiveHour: { usedPercent: 100, resetsAt: NOW + HOUR, resetsLabel: null },
              weekly: null,
            }),
            makeSnapshot({
              provider: 'codex',
              instanceId: 'codex-work',
              instanceLabel: 'Work Codex',
              accountEmail: 'work@example.com',
              planType: 'ChatGPT Pro 100 Subscription',
              fiveHour: { usedPercent: 40, resetsAt: NOW + 4 * HOUR, resetsLabel: null },
              weekly: null,
            }),
          ],
        }),
      ],
      NOW,
    )

    const sessionPool = overview.providers[0]!.windows[0]!
    expect(sessionPool.members).toHaveLength(2)
    expect(sessionPool.remainingPercent).toBe(50)
    expect(sessionPool.usedPercent).toBe(50)
    expect(sessionPool.nextRefill).toMatchObject({
      restoresPercent: 17,
      countdown: '↻ +17% in 1h',
    })
  })

  test('groups Antigravity model groups and separates non-metered and failed host states', () => {
    const overview = buildUsageOverview(
      [
        makeHost({
          serverId: 'host-a',
          label: 'Workstation',
          snapshots: [
            makeSnapshot({
              provider: 'antigravity',
              fiveHour: null,
              weekly: null,
              modelGroups: [
                { id: '3p', label: 'Claude & GPT', fiveHour: { usedPercent: 95, resetsAt: NOW + 2 * HOUR, resetsLabel: null }, weekly: null },
                { id: 'gemini', label: 'Gemini', fiveHour: { usedPercent: 20, resetsAt: NOW + HOUR, resetsLabel: null }, weekly: null },
              ],
            }),
            makeSnapshot({
              provider: 'codex',
              fiveHour: null,
              weekly: null,
              usageMode: 'api',
            }),
          ],
        }),
        makeHost({
          serverId: 'host-b',
          label: 'Build box',
          state: 'error',
          error: 'Host unreachable',
        }),
      ],
      NOW,
    )

    const agy = overview.providers.find((group) => group.provider === 'antigravity')!
    expect(agy.windows.map((w) => w.groupLabel)).toEqual(['Gemini', 'Claude & GPT'])
    expect(agy.windows[0]!.tone).toBe('ok')
    expect(agy.windows[1]!.tone).toBe('spent')

    const codex = overview.providers.find((group) => group.provider === 'codex')!
    expect(codex.nonMeteredAccounts).toHaveLength(1)
    expect(codex.nonMeteredAccounts[0]!.status).toBe('api')

    expect(overview.failedHosts).toEqual([
      { serverId: 'host-b', label: 'Build box', message: 'Host unreachable' },
    ])
  })

  test('formats display modes, masks emails, and derives stable initials and hue', () => {
    expect(formatUsagePercent(0.4, 99.6, 'remaining')).toMatchObject({ formatted: '<1', suffix: '% left' })
    expect(formatUsagePercent(0.4, 99.6, 'used')).toMatchObject({ formatted: '>99', suffix: '% used' })
    expect(maskEmail('dev@solus.sh')).toBe('••••••@••••••')
    expect(emailInitials('dev@solus.sh')).toBe('DS')
    expect(accountHue('dev@solus.sh')).toBe(accountHue('dev@solus.sh'))
  })

  test('filters usage overview by harness and state criteria', () => {
    const overview = buildUsageOverview(
      [
        makeHost({
          snapshots: [
            makeSnapshot({
              provider: 'claude-code',
              // 50% elapsed, 72% used -> ahead of pace
              fiveHour: { usedPercent: 72, resetsAt: NOW + 2.5 * HOUR, resetsLabel: null },
              weekly: { usedPercent: 24, resetsAt: NOW + 4 * DAY, resetsLabel: null },
            }),
            makeSnapshot({
              provider: 'codex',
              fiveHour: null,
              weekly: null,
              usageMode: 'signed_out',
            }),
            makeSnapshot({
              provider: 'antigravity',
              fiveHour: null,
              weekly: null,
              modelGroups: [
                { id: 'gemini', label: 'Gemini', fiveHour: { usedPercent: 16, resetsAt: NOW + 4 * HOUR, resetsLabel: null }, weekly: null },
                { id: '3p', label: 'Claude & GPT', fiveHour: { usedPercent: 100, resetsAt: NOW + HOUR, resetsLabel: null }, weekly: { usedPercent: 100, resetsAt: NOW + DAY, resetsLabel: null } },
              ],
            }),
          ],
        }),
      ],
      NOW,
    )

    const onlyClaude = filterUsageOverview(overview, { providers: new Set(['claude-code']) })
    expect(onlyClaude.providers.map((group) => group.provider)).toEqual(['claude-code'])

    const aheadOnly = filterUsageOverview(overview, { state: 'ahead' })
    expect(aheadOnly.providers.map((group) => group.provider)).toEqual(['claude-code'])
    expect(aheadOnly.providers[0]!.windows.map((w) => w.id)).toEqual(['fiveHour'])

    const blockedOnly = filterUsageOverview(overview, { state: 'blocked' })
    expect(blockedOnly.providers.map((group) => group.provider)).toEqual(['antigravity'])
    expect(blockedOnly.providers[0]!.windows.every((w) => w.groupId === '3p')).toBe(true)

    const signedOutOnly = filterUsageOverview(overview, { state: 'signed_out' })
    expect(signedOutOnly.providers.map((group) => group.provider)).toEqual(['codex'])
    expect(signedOutOnly.providers[0]!.nonMeteredAccounts[0]!.status).toBe('signed_out')
  })

  test('computes proportional LayerChart pooled bar segments and groups model-group windows', () => {
    const overview = buildUsageOverview(
      [
        makeHost({
          snapshots: [
            makeSnapshot({
              provider: 'codex',
              instanceId: 'codex',
              instanceLabel: 'Personal Codex',
              accountEmail: 'personal@example.com',
              planType: 'ChatGPT Plus',
              fiveHour: { usedPercent: 100, resetsAt: NOW + HOUR, resetsLabel: null },
              weekly: null,
            }),
            makeSnapshot({
              provider: 'codex',
              instanceId: 'codex-work',
              instanceLabel: 'Work Codex',
              accountEmail: 'work@example.com',
              planType: 'ChatGPT Pro 100',
              fiveHour: { usedPercent: 40, resetsAt: NOW + 4 * HOUR, resetsLabel: null },
              weekly: null,
            }),
            makeSnapshot({
              provider: 'antigravity',
              fiveHour: null,
              weekly: null,
              modelGroups: [
                { id: 'gemini', label: 'Gemini', fiveHour: { usedPercent: 16, resetsAt: NOW + 4 * HOUR, resetsLabel: null }, weekly: { usedPercent: 9, resetsAt: NOW + 5 * DAY, resetsLabel: null } },
                { id: '3p', label: 'Claude & GPT', fiveHour: { usedPercent: 100, resetsAt: NOW + HOUR, resetsLabel: null }, weekly: { usedPercent: 100, resetsAt: NOW + DAY, resetsLabel: null } },
              ],
            }),
          ],
        }),
      ],
      NOW,
    )

    const codexPool = overview.providers.find((g) => g.provider === 'codex')!.windows[0]!
    const segments = buildPooledBarSegments(codexPool, 'remaining', 1.2)
    expect(segments).toHaveLength(2)
    expect(segments[0]!.start).toBe(0)
    expect(segments[1]!.end).toBeCloseTo(100, 5)
    expect(segments[1]!.width).toBeCloseTo(segments[0]!.width * 5, 5)
    expect(segments[0]!.fillEnd).toBe(segments[0]!.start)
    expect(segments[0]!.restoresPoolPercent).toBe(17)
    expect(segments[1]!.fillEnd).toBeGreaterThan(segments[1]!.start)
    expect(segments[1]!.paceX).not.toBeNull()

    const agyWindows = overview.providers.find((g) => g.provider === 'antigravity')!.windows
    const grouped = groupUsageWindowsByModelGroup(agyWindows)
    expect(grouped.map((g) => g.groupLabel)).toEqual(['Gemini', 'Claude & GPT'])
    expect(grouped[0]!.windows).toHaveLength(2)
    expect(grouped[1]!.windows).toHaveLength(2)
  })

  test('formats live countdown durations down to seconds in full and compact modes', () => {
    const sixDays = 6 * DAY + 12 * HOUR + 4 * MINUTE + 9_000
    expect(formatLiveDuration(sixDays)).toBe('6d 12h 04m 09s')
    expect(formatLiveDuration(sixDays, true)).toBe('6d 12h')
    expect(formatLiveDuration(HOUR + 6 * MINUTE + 5_000)).toBe('1h 06m 05s')
    expect(formatLiveDuration(14 * MINUTE + 32_000, true)).toBe('14m 32s')
    expect(formatLiveDuration(9_000)).toBe('9s')

    expect(formatLiveResetCountdown(NOW + HOUR + 6 * MINUTE + 5_000, null, NOW)).toBe('resets in 1h 06m 05s')
    expect(formatLiveResetCountdown(NOW + 45_000, null, NOW, { verb: '' })).toBe('in 45s')
    expect(formatLiveResetCountdown(NOW - 1_000, null, NOW, { verb: 'reopens' })).toBe('reopens now')
  })

  test('shows an unavailable placeholder for Antigravity when available on hosts without quota snapshots', () => {
    const overview = buildUsageOverview(
      [
        makeHost({
          serverId: 'host-1',
          label: 'Laptop',
          snapshots: [makeSnapshot({ provider: 'codex' })],
          availableProviders: ['codex', 'antigravity', 'replay'],
        }),
        makeHost({
          serverId: 'host-2',
          label: 'Studio',
          snapshots: [],
          availableProviders: ['antigravity'],
        }),
      ],
      NOW,
    )

    expect(overview.providers.map((group) => group.provider)).toEqual(['codex', 'antigravity'])
    expect(overview.staleHosts).toEqual([])

    const agy = overview.providers.find((group) => group.provider === 'antigravity')!
    expect(agy.label).toBe('Google Antigravity')
    expect(agy.windows).toEqual([])
    expect(hasUsageSectionContent(agy)).toBe(true)

    const unsupported = unsupportedAccountOf(agy)
    expect(unsupported).not.toBeNull()
    expect(unsupported?.status).toBe('unsupported')
    expect(unsupported?.stale).toBe(false)
    expect(unsupported?.hosts.map((host) => host.label)).toEqual(['Laptop', 'Studio'])
    expect(usageUnsupportedMessage('antigravity')).toContain('Check Antigravity')

    // Filtering by Antigravity keeps the placeholder; issue/pace/signed-out filters exclude it.
    expect(filterUsageOverview(overview, { providers: new Set(['antigravity']) }).providers.map((g) => g.provider)).toEqual(['antigravity'])
    expect(filterUsageOverview(overview, { state: 'issues' }).providers.some((g) => g.provider === 'antigravity')).toBe(false)
    expect(filterUsageOverview(overview, { state: 'ahead' }).providers.some((g) => g.provider === 'antigravity')).toBe(false)
    expect(filterUsageOverview(overview, { state: 'signed_out' }).providers.some((g) => g.provider === 'antigravity')).toBe(false)
  })

  test('prefers real Antigravity snapshots over the unavailable placeholder when reported', () => {
    const overview = buildUsageOverview(
      [
        makeHost({
          snapshots: [
            makeSnapshot({
              provider: 'antigravity',
              fiveHour: null,
              weekly: null,
              modelGroups: [
                { id: 'gemini', label: 'Gemini', fiveHour: { usedPercent: 25, resetsAt: NOW + HOUR, resetsLabel: null }, weekly: null },
              ],
            }),
          ],
          availableProviders: ['antigravity'],
        }),
      ],
      NOW,
    )

    const agy = overview.providers.find((group) => group.provider === 'antigravity')!
    expect(agy.windows).toHaveLength(1)
    expect(unsupportedAccountOf(agy)).toBeNull()
  })
})
