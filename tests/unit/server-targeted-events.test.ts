import { describe, expect, test } from 'bun:test'
import type { HostEvent } from '../../src/shared/host-events'
import { ClientEventRegistry } from '../../src/main/events/client-event-registry'
import { HostEventPublisher } from '../../src/main/events/host-event-publisher'

function captureClient(registry: ClientEventRegistry, clientId: string): {
  events: HostEvent[]
  unsubscribe: () => void
} {
  const events: HostEvent[] = []
  const unsubscribe = registry.register(clientId, (event) => events.push(event))
  return { events, unsubscribe }
}

describe('HostEventPublisher', () => {
  test('publishes to one client without leaking to another client', () => {
    const registry = new ClientEventRegistry()
    const publisher = new HostEventPublisher(registry)
    const clientA = captureClient(registry, 'ws:a')
    const clientB = captureClient(registry, 'ws:b')

    expect(publisher.publish('ws:a', 'session.eventReceived', {
      tabId: 'tab-a',
      event: { type: 'assistant_message', text: 'A' },
    })).toBe(1)

    expect(clientA.events).toHaveLength(1)
    expect(clientA.events[0]).toMatchObject({
      type: 'session.eventReceived',
      payload: { tabId: 'tab-a', event: { type: 'assistant_message', text: 'A' } },
    })
    expect(clientB.events).toEqual([])
  })

  test('accepts many client ids and deduplicates them', () => {
    const registry = new ClientEventRegistry()
    const publisher = new HostEventPublisher(registry)
    const clientA = captureClient(registry, 'ws:a')
    const clientB = captureClient(registry, 'ws:b')

    expect(publisher.publish(['ws:a', 'ws:b', 'ws:a'], 'tasks.invalidated', {})).toBe(2)

    expect(clientA.events).toHaveLength(1)
    expect(clientB.events).toHaveLength(1)
  })

  test('reports only routable recipients and broadcasts to every registered client', () => {
    const registry = new ClientEventRegistry()
    const publisher = new HostEventPublisher(registry)
    const clientA = captureClient(registry, 'ws:a')
    const clientB = captureClient(registry, 'ws:b')

    expect(publisher.publish(['ws:a', 'ws:missing'], 'tasks.invalidated', {})).toBe(1)
    expect(publisher.broadcast('tasks.invalidated', {})).toBe(2)

    expect(clientA.events.map((event) => event.payload)).toEqual([
      {},
      {},
    ])
    expect(clientB.events.map((event) => event.payload)).toEqual([{}])
  })

  test('treats an empty recipient list as a successful no-op', () => {
    const publisher = new HostEventPublisher(new ClientEventRegistry())
    expect(publisher.publish([], 'tasks.invalidated', {})).toBe(0)
  })

  test('continues after one client delivery endpoint throws', () => {
    const registry = new ClientEventRegistry()
    const publisher = new HostEventPublisher(registry)
    registry.register('ws:broken', () => { throw new Error('broken endpoint') })
    const healthy = captureClient(registry, 'ws:healthy')

    expect(publisher.publish(['ws:broken', 'ws:healthy'], 'tasks.invalidated', {})).toBe(1)
    expect(healthy.events).toHaveLength(1)
  })

  test('routes to the newest registration and removes it safely', () => {
    const registry = new ClientEventRegistry()
    const publisher = new HostEventPublisher(registry)
    const older = captureClient(registry, 'ws:a')
    const replacement = captureClient(registry, 'ws:a')

    publisher.publish('ws:a', 'tasks.invalidated', {})
    replacement.unsubscribe()
    expect(publisher.publish('ws:a', 'tasks.invalidated', {})).toBe(0)
    older.unsubscribe()

    expect(replacement.events.map((event) => event.payload)).toEqual([{}])
    expect(older.events).toEqual([])
  })
})
