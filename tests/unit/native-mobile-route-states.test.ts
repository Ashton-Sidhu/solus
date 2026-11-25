import { describe, expect, test } from 'bun:test'
import { routeRows } from '@solus/client-core/host-route-control'
import type { HostReadinessState } from '@solus/client-core/host-readiness'
import { hostRouteStates } from '../../apps/mobile/src/solus/host-route-states'

// The phone shows how each route of a host is doing, not only the route in use.

describe('mobile route states', () => {
  const holder = { routes: [{ kind: 'lan' as const, url: 'http://192.168.1.4:7777' }, { kind: 'tailnet' as const, url: 'http://mac.tail1.ts.net:7777' }] }
  const refused: HostReadinessState = { readiness: 'refused', away: true, unreachableReason: null, refusedReason: 'auth', lastSeenAt: null }

  test('each route says how it is doing, not only the route in use', () => {
    const ready: HostReadinessState = { readiness: 'ready', away: false, unreachableReason: null, refusedReason: null, lastSeenAt: 1 }
    expect(hostRouteStates(holder, 'http://192.168.1.4:7777', ready).map((row) => row.stateText)).toEqual(['In use', 'Standby'])
  })

  test('a refused sign-in shows on the route it was dialed on', () => {
    const rows = hostRouteStates(holder, 'http://mac.tail1.ts.net:7777', refused)
    expect(rows.map(({ url, stateText }) => [url, stateText])).toEqual([
      ['http://192.168.1.4:7777', 'Not in use'],
      ['http://mac.tail1.ts.net:7777', 'Sign-in refused'],
    ])
    expect(rows.length).toBe(routeRows(holder, { clientOrigin: '' }).length)
  })
})
