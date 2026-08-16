import { describe, expect, test } from 'bun:test'
import { HostEventSubscriber } from '../../src/client-core/host-event-subscriber'
import { subscribeAllHosts } from '../../src/client-core/host-events'
import { hostKey, splitHostKey } from '../../src/client-core/host-key'
import { serverConnections } from '../../src/client-core/server-connections'
import { hostPolicy } from '../../src/client-core/host-policy'
import type { HostApi } from '../../src/client-core/host-api'
import type { SolusAPI } from '../../src/preload'

function verifyHostApiBrand(rawApi: SolusAPI, hostApi: HostApi): void {
  const acceptedApi: SolusAPI = hostApi
  // @ts-expect-error A raw API is not bound to a named host.
  const rejectedApi: HostApi = rawApi
  void acceptedApi
  void rejectedApi
}

void verifyHostApiBrand

describe('host keys', () => {
  test('round-trips a host and path', () => {
    const key = hostKey('studio-mac', '/Users/solus/project')

    expect(splitHostKey(key)).toEqual({
      serverId: 'studio-mac',
      path: '/Users/solus/project',
    })
  })

  test('does not alias the same path on two hosts', () => {
    expect(hostKey('host-a', '/workspace')).not.toBe(hostKey('host-b', '/workspace'))
  })
})

describe('host policy', () => {
  test('only the registered local target is the client machine', () => {
    // WHY: dispatch-client step 5 — the web alias is gone. A browser has no
    // machine of its own, so nothing is "local" there; on desktop only the
    // registered local target is, and call sites must not diverge from that.
    const connections = serverConnections as unknown as { localServerId: () => string | null }
    const originalLocalServerId = connections.localServerId
    connections.localServerId = () => 'desktop-local'
    try {
      expect(hostPolicy.isClientMachine('desktop-local')).toBe(true)
      expect(hostPolicy.isClientMachine('remote')).toBe(false)
      expect(hostPolicy.isClientMachine(undefined)).toBe(false)
      // Web: no registered local target means no client machine at all.
      connections.localServerId = () => null
      expect(hostPolicy.isClientMachine('remote')).toBe(false)
    } finally {
      connections.localServerId = originalLocalServerId
    }
  })
})

describe('host event fan-out', () => {
  test('subscribes to existing and later connections, then releases all subscriptions', () => {
    const existingEvents = new HostEventSubscriber()
    const laterEvents = new HostEventSubscriber()
    const received: string[] = []
    let connectionCreated: ((connection: { serverId: string }) => void) | null = null
    const connections = serverConnections as unknown as {
      connectedServerIds: () => string[]
      eventsFor: (serverId: string) => HostEventSubscriber
      onConnectionCreated: (listener: (connection: { serverId: string }) => void) => () => void
    }
    const originalConnectedServerIds = connections.connectedServerIds
    const originalEventsFor = connections.eventsFor
    const originalOnConnectionCreated = connections.onConnectionCreated

    connections.connectedServerIds = () => ['fan-out-existing']
    connections.eventsFor = (serverId) => serverId === 'fan-out-existing' ? existingEvents : laterEvents
    connections.onConnectionCreated = (listener) => {
      connectionCreated = listener
      return () => { connectionCreated = null }
    }

    try {
      const unsubscribe = subscribeAllHosts('tasks.invalidated', (serverId) => {
        received.push(serverId)
      })
      existingEvents.receive(hostEvent('tasks.invalidated', {}))

      const notifyConnectionCreated = connectionCreated as ((connection: { serverId: string }) => void) | null
      notifyConnectionCreated?.({ serverId: 'fan-out-later' })
      laterEvents.receive(hostEvent('tasks.invalidated', {}))

      expect(received).toEqual(['fan-out-existing', 'fan-out-later'])

      unsubscribe()
      existingEvents.receive(hostEvent('tasks.invalidated', {}))
      laterEvents.receive(hostEvent('tasks.invalidated', {}))
      expect(received).toEqual(['fan-out-existing', 'fan-out-later'])
      expect(connectionCreated).toBeNull()
    } finally {
      connections.connectedServerIds = originalConnectedServerIds
      connections.eventsFor = originalEventsFor
      connections.onConnectionCreated = originalOnConnectionCreated
    }
  })
})

function hostEvent<K extends 'tasks.invalidated'>(type: K, payload: Record<string, never>) {
  return { type, payload, occurredAt: Date.now() }
}
