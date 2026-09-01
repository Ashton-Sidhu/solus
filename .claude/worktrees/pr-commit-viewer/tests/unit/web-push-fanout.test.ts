import { describe, expect, test } from 'bun:test'
import {
  fanOutPushHosts,
  planPushReconciliation,
  pushHostRefs,
} from '../../client/src/lib/web-push-core'
import { routeForPushClick, serverIdForInstallation } from '../../client/src/lib/push-click'
import {
  loadServers,
  onServerRemoving,
  removeServer,
  saveServers,
  type SavedServer,
} from '../../src/client-core/server-registry'

function saved(id: string, installationId: string): SavedServer {
  return {
    id,
    installationId,
    label: id,
    url: `https://${id}.example`,
    sessionToken: `token-${id}`,
    lastConnected: 1,
  }
}

describe('web push host fan-out', () => {
  test('includes every saved host and de-duplicates the primary', () => {
    expect(pushHostRefs(
      [saved('host-a', 'install-a'), saved('host-b', 'install-b')],
      { serverId: 'host-a', installationId: 'install-a' },
    )).toEqual([
      { serverId: 'host-a', installationId: 'install-a' },
      { serverId: 'host-b', installationId: 'install-b' },
    ])
  })

  test('one host failure does not stop subscriptions on other hosts', async () => {
    const calls: string[] = []
    const result = await fanOutPushHosts(
      [{ serverId: 'host-a' }, { serverId: 'offline' }, { serverId: 'host-b' }],
      async (host) => {
        calls.push(host.serverId)
        if (host.serverId === 'offline') throw new Error('unreachable')
        return `subscription-${host.serverId}`
      },
    )

    expect(calls).toEqual(['host-a', 'offline', 'host-b'])
    expect(result.fulfilled.map((item) => item.value)).toEqual(['subscription-host-a', 'subscription-host-b'])
    expect(result.rejected).toEqual([{ serverId: 'offline' }])
  })

  test('one reconciliation describes enable, disable, and host removal', () => {
    const hosts = [
      { serverId: 'host-a', installationId: 'install-a' },
      { serverId: 'host-b', installationId: 'install-b' },
    ]

    expect(planPushReconciliation(hosts, ['orphan'], true)).toEqual({
      subscribe: hosts,
      unsubscribe: ['orphan'],
    })
    expect(planPushReconciliation(hosts, ['host-a', 'host-b'], false)).toEqual({
      subscribe: [],
      unsubscribe: ['host-a', 'host-b'],
    })
    expect(planPushReconciliation(hosts, ['host-a', 'host-b'], true, 'host-b')).toEqual({
      subscribe: [hosts[0]],
      unsubscribe: ['host-b'],
    })
  })

  test('host removal publishes the host before deleting its saved connection', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    const values = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    })
    try {
      saveServers([saved('host-a', 'install-a')])
      const seen: string[] = []
      const stop = onServerRemoving((server) => {
        seen.push(server.id)
        expect(loadServers().map((item) => item.id)).toEqual(['host-a'])
      })

      removeServer('host-a')
      stop()
      expect(seen).toEqual(['host-a'])
      expect(loadServers()).toEqual([])
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })
})

describe('push click host resolution', () => {
  const servers = [saved('host-a', 'install-a'), saved('host-b', 'install-b')]

  test('maps the host installation id to a scoped session route', () => {
    expect(serverIdForInstallation('install-b', servers)).toBe('host-b')
    expect(routeForPushClick({
      installationId: 'install-b',
      sessionId: 'session-1',
    }, servers)).toBe('/chat/session-1~host-b')
  })

  test('falls back to the legacy unscoped route for an unknown old host', () => {
    expect(routeForPushClick({ sessionId: 'session-1' }, servers)).toBe('/chat/session-1')
  })
})
