import { describe, expect, test } from 'bun:test'
import { HOST_LOGIN_SEAT } from '@solus/contracts/seats'
import type { AgentId, NormalizedEvent } from '@solus/contracts/types'
import { HOST_ACTOR, memberSeat, seatFor, type Actor } from '@solus/server/admission/actor'
import { RateLimitState } from '@solus/server/execution/rate-limits'
import { providerSpent } from '@solus/server/execution/sessions/provider-usage'
import { UsageLimitsStore } from '@solus/server/usage/usage-store'

// WHY: the fallback model replaces a default only while its provider cannot
// answer. A provider can refuse turns below 100% (a Claude weekly limit at
// 95%), so a limit that holds a session counts as well as a spent window. A
// member's seat has its own limits: one person's limit must not move another
// person's sessions to the fallback.

const NOW = Date.parse('2026-11-24T12:00:00Z')
const HOUR = 3_600_000

type RateLimitEvent = Extract<NormalizedEvent, { type: 'rate_limit' }>

function limit(resetsAtMs: number | null): RateLimitEvent {
  return { type: 'rate_limit', status: 'rejected', resetsAt: resetsAtMs === null ? null : resetsAtMs / 1000, rateLimitType: 'seven_day_overage_included' }
}

const member: Actor = {
  ...HOST_ACTOR,
  principal: { kind: 'org-member', userId: 'user-bob', organizationId: 'org-globex', organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName: 'Bob', deviceId: 'phone' } as Actor['principal'],
}

function readers(options: { weeklyPercent?: number; weeklyResetsAt?: number | null; held?: Array<{ sessionId: string; provider: AgentId; event: RateLimitEvent; actor?: Actor }> } = {}) {
  const usage = new UsageLimitsStore()
  usage.apply({
    provider: 'claude-code',
    fiveHour: { usedPercent: 10, resetsAt: NOW + HOUR, resetsLabel: null },
    weekly: { usedPercent: options.weeklyPercent ?? 95, resetsAt: options.weeklyResetsAt === undefined ? NOW + 24 * HOUR : options.weeklyResetsAt, resetsLabel: null },
    planType: null, fetchedAt: NOW, stale: false,
  })
  const held = new RateLimitState()
  const sessions = new Map<string, { provider: AgentId; actor?: Actor }>()
  for (const entry of options.held ?? []) {
    held.record(entry.sessionId, entry.event)
    sessions.set(entry.sessionId, { provider: entry.provider, actor: entry.actor })
  }
  return { usage, held, providerOf: (id: string) => sessions.get(id)?.provider, actorOf: (id: string) => sessions.get(id)?.actor }
}

describe('providerSpent', () => {
  test('a limit that holds a session counts as spent, below 100% use', () => {
    const reset = NOW + 6 * HOUR
    const state = readers({ held: [{ sessionId: 's1', provider: 'claude-code', event: limit(reset) }] })
    expect(providerSpent(state, 'claude-code', HOST_LOGIN_SEAT, NOW)).toEqual({ resetsAt: reset / 1000 })
    expect(providerSpent(state, 'codex', HOST_LOGIN_SEAT, NOW)).toBeNull()
  })

  test('95% use with no held limit is not spent', () => {
    expect(providerSpent(readers(), 'claude-code', HOST_LOGIN_SEAT, NOW)).toBeNull()
  })

  test('a spent window counts until its reset, and not after', () => {
    const reset = NOW + 24 * HOUR
    expect(providerSpent(readers({ weeklyPercent: 100 }), 'claude-code', HOST_LOGIN_SEAT, NOW)).toEqual({ resetsAt: reset / 1000 })
    expect(providerSpent(readers({ weeklyPercent: 100, weeklyResetsAt: NOW - HOUR }), 'claude-code', HOST_LOGIN_SEAT, NOW)).toBeNull()
  })

  test('a held limit whose reset has passed is not spent', () => {
    const state = readers({ held: [{ sessionId: 's1', provider: 'claude-code', event: limit(NOW - HOUR) }] })
    expect(providerSpent(state, 'claude-code', HOST_LOGIN_SEAT, NOW)).toBeNull()
  })

  test('with two signs, the provider opens at the later reset', () => {
    const later = NOW + 48 * HOUR
    const state = readers({ weeklyPercent: 100, held: [{ sessionId: 's1', provider: 'claude-code', event: limit(later) }] })
    expect(providerSpent(state, 'claude-code', HOST_LOGIN_SEAT, NOW)).toEqual({ resetsAt: later / 1000 })
  })

  test('a held limit with no known reset is spent with no reset', () => {
    const state = readers({ held: [{ sessionId: 's1', provider: 'codex', event: limit(null) }] })
    expect(providerSpent(state, 'codex', HOST_LOGIN_SEAT, NOW)).toEqual({ resetsAt: null })
  })

  test('each seat counts only its own limits', () => {
    const bobSeat = memberSeat('user-bob', 'Bob')
    expect(seatFor(member)).toEqual(bobSeat)
    const ownerLimited = readers({ weeklyPercent: 100, held: [{ sessionId: 's1', provider: 'claude-code', event: limit(NOW + HOUR) }] })
    // The host login is spent; Bob's own seat is not.
    expect(providerSpent(ownerLimited, 'claude-code', bobSeat, NOW)).toBeNull()

    const bobLimited = readers({ held: [{ sessionId: 's2', provider: 'claude-code', event: limit(NOW + HOUR), actor: member }] })
    expect(providerSpent(bobLimited, 'claude-code', bobSeat, NOW)).toEqual({ resetsAt: (NOW + HOUR) / 1000 })
    expect(providerSpent(bobLimited, 'claude-code', HOST_LOGIN_SEAT, NOW)).toBeNull()
  })
})
