import { describe, expect, test } from 'bun:test'
import { ActivityLeases } from '../../src/main/server/activity-leases'

describe('activity leases', () => {
  test('a foreground lease expires on its own clock', () => {
    // WHY: dispatch-client step 7 — a client that dies mid-lease must cost at
    // most one TTL of extra freshness work, with no unsubscribe required.
    const leases = new ActivityLeases()
    leases.report('client-a', true, 1_000)
    expect(leases.hasForegroundLease(1_000)).toBe(true)
    expect(leases.hasForegroundLease(20_999)).toBe(true)
    expect(leases.hasForegroundLease(21_001)).toBe(false)
  })

  test('backgrounding releases the lease without waiting out the TTL', () => {
    const leases = new ActivityLeases()
    leases.report('client-a', true, 1_000)
    leases.report('client-a', false, 2_000)
    expect(leases.hasForegroundLease(2_000)).toBe(false)
  })

  test('any one foregrounded client keeps the host working', () => {
    const leases = new ActivityLeases()
    leases.report('client-a', false, 1_000)
    leases.report('client-b', true, 1_000)
    expect(leases.hasForegroundLease(1_500)).toBe(true)
    leases.drop('client-b')
    expect(leases.hasForegroundLease(1_500)).toBe(false)
  })
})
