import { describe, expect, test } from 'bun:test'
import type { HostLinkHealth } from '@solus/contracts/host-pairing'
import { routeRows } from '@solus/client-core/host-route-control'
import type { LinkMachine } from '@solus/client-core/host-linking'
import type { HostReadinessState } from '@solus/client-core/host-readiness'
import { LinkHealthReader } from '../../apps/mobile/solus-core/features/hosts/link-health'
import { hostRouteStates } from '../../apps/mobile/src/solus/host-route-states'

// The phone reads link health only while a screen shows links, and never shows
// a read from a connection that changed (docs/host-pairing.md, "Link health").

const reachable: HostLinkHealth = { installationId: 'build', status: 'reachable', lastReachedAt: 1, lastError: null, expiresAt: null }

function machine(id: string, hostsLinkHealth: () => Promise<HostLinkHealth[]>, isCurrent = () => true): LinkMachine {
  return {
    label: id,
    info: { installationId: id, routes: [], principal: 'local-owner', permissions: ['host.local.reach'], hostKind: 'personal', remoteAccess: 'private' },
    api: { hostsPair: async () => { throw new Error('unused') }, hostsPairClient: async () => { throw new Error('unused') }, hostsUnlink: async () => ({ removed: true }), connectionsGeneratePairToken: async () => { throw new Error('unused') }, hostsLinkHealth },
    snapshot: { hosts: [], forgotten: [] },
    isCurrent,
  } as LinkMachine
}

function fakeTimers() {
  const timers = new Set<number>()
  let next = 0
  return {
    timers,
    setIntervalFn: (() => { timers.add(++next); return next }) as unknown as typeof setInterval,
    clearIntervalFn: ((id: number) => { timers.delete(id) }) as unknown as typeof clearInterval,
  }
}

describe('mobile link health reader', () => {
  test('a watched machine is read at once, and the interval stops with the last watcher', async () => {
    let calls = 0
    const timers = fakeTimers()
    const reader = new LinkHealthReader({ machines: () => [machine('mac', async () => { calls++; return [reachable] })], ...timers })
    const stopFirst = reader.watch(['mac'])
    const stopSecond = reader.watch(['mac'])
    await reader.read()
    expect(calls).toBeGreaterThan(0)
    expect(reader.current().get('mac')).toEqual([reachable])
    stopFirst()
    expect(timers.timers.size).toBe(1)
    stopSecond()
    expect(timers.timers.size).toBe(0)
  })

  test('a host that cannot give health is unavailable, so the link shows Health unknown and not a check that never ends', async () => {
    const reader = new LinkHealthReader({ machines: () => [machine('mac', async () => { throw new Error('Unknown method hostsLinkHealth') })], ...fakeTimers() })
    await reader.read(['mac'])
    expect(reader.current().get('mac')).toBe('unavailable')
  })

  test('a read from a connection that changed while it ran is dropped', async () => {
    let current = true
    const reader = new LinkHealthReader({
      machines: () => [machine('mac', async () => { current = false; return [reachable] }, () => current)],
      ...fakeTimers(),
    })
    await reader.read(['mac'])
    expect(reader.current().has('mac')).toBe(false)
  })
})

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
