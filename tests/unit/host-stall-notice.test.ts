import { describe, expect, test } from 'bun:test'
import type { ConnectionsServerInfo, HostEventLoopStall } from '@solus/contracts/host-api'
import { hostStallNotice, unshownHostStallNotice } from '@solus/client-core/host-stall-notice'
import { hostStallLine } from '../../apps/mobile/src/features/connection/lib/host-stall-line'
import type { NativeHost } from '../../apps/mobile/src/features/hosts/host-registry'

// docs/mobile-connections.md "When a host freezes": a client says why its host
// dropped, one time for each stall, and says only what the host reported.

const stall: HostEventLoopStall = { endedAt: 1_792_000_000_000, durationMs: 12_422, loadAverage: 219.4, cpuCount: 18 }

describe('hostStallNotice', () => {
  test('blames an overloaded computer only when the load is above the core count', () => {
    expect(hostStallNotice('host-1', 'leftbook', stall)).toEqual({
      key: 'host-1:1792000000000',
      title: 'leftbook stopped answering for 12 s',
      description: 'The computer was overloaded (load 219 on 18 cores).',
    })
    const busy = 'Solus on leftbook was too busy to answer.'
    expect(hostStallNotice('host-1', 'leftbook', { ...stall, loadAverage: 4 })?.description).toBe(busy)
    const { loadAverage: _load, ...noLoad } = stall
    expect(hostStallNotice('host-1', 'leftbook', noLoad)?.description).toBe(busy)
  })

  test('says nothing for a host that reports no stall, such as an older host', () => {
    expect(hostStallNotice('host-1', 'leftbook', undefined)).toBeNull()
  })
})

describe('unshownHostStallNotice', () => {
  test('shows a stall one time, however often the server info is read again', () => {
    // WHY: server info reloads after each reconnect and on other events; a repeated toast is noise.
    const shown = new Set<string>()
    expect(unshownHostStallNotice(shown, 'host-1', 'leftbook', stall)?.title).toBe('leftbook stopped answering for 12 s')
    expect(unshownHostStallNotice(shown, 'host-1', 'leftbook', stall)).toBeNull()
    expect(unshownHostStallNotice(shown, 'host-1', 'leftbook', { ...stall })).toBeNull()
  })

  test('a new stall, or the same stall time on another host, shows again', () => {
    const shown = new Set<string>()
    unshownHostStallNotice(shown, 'host-1', 'leftbook', stall)
    expect(unshownHostStallNotice(shown, 'host-2', 'rightbook', stall)).not.toBeNull()
    expect(unshownHostStallNotice(shown, 'host-1', 'leftbook', { ...stall, endedAt: stall.endedAt + 60_000 })).not.toBeNull()
  })
})

describe('hostStallLine (mobile host row)', () => {
  // SAFETY: the line reads only the id and label of the host.
  const host = { id: 'host-1', label: 'leftbook' } as NativeHost

  function connections(phase: 'connected' | 'reconnecting', info: Partial<ConnectionsServerInfo> | undefined) {
    const ensured: string[] = []
    const facts = {
      ensure: (key: string) => { ensured.push(key) },
      value: (key: string) => (key === 'serverInfo' ? info : undefined),
    }
    return {
      ensured,
      // SAFETY: the line reads `state().phase` and `connection().facts` with `ensure` and `value` only.
      connections: { state: () => ({ phase }), connection: () => ({ facts }) } as never,
    }
  }

  test('shows the notice on a connected host that reports a stall', () => {
    const { connections: reported, ensured } = connections('connected', { recentEventLoopStall: stall })
    expect(hostStallLine(reported, host)).toBe('leftbook stopped answering for 12 s. The computer was overloaded (load 219 on 18 cores).')
    expect(ensured).toEqual(['serverInfo'])
  })

  test('shows nothing while the host is not connected, or when it reports no stall', () => {
    // WHY: a reconnecting row already says it is reconnecting; an old answer must not explain it.
    expect(hostStallLine(connections('reconnecting', { recentEventLoopStall: stall }).connections, host)).toBeNull()
    expect(hostStallLine(connections('connected', {}).connections, host)).toBeNull()
  })
})
