import { describe, expect, test } from 'bun:test'
import type { HostEvent } from '@solus/contracts/host-events'
import { ClientEventRegistry } from '@solus/server/transport/events/client-event-registry'
import { HostEventPublisher } from '@solus/server/transport/events/host-event-publisher'

/**
 * Room events (a session's watchers, a work open live) are frequent, and the
 * audience check reads the share list. A member is checked on its first event
 * in a room and not again until a share list or a task changes; a refusal is
 * never remembered, and delivery order per client never changes.
 */

function setup(allowed: Set<string>) {
  const checks: string[] = []
  const registry = new ClientEventRegistry(async (clientId: string, event: HostEvent) => {
    checks.push(`${clientId}:${event.type}`)
    return allowed.has(clientId)
  })
  const received = new Map<string, string[]>()
  for (const clientId of ['alice', 'bob']) {
    received.set(clientId, [])
    registry.register(clientId, (event) => {
      received.get(clientId)!.push(event.type === 'workLive.update' ? event.payload.update : event.type)
    })
  }
  return { registry, events: new HostEventPublisher(registry), checks, received }
}

const room = { kind: 'work', id: 'w1' } as const
const update = (n: number) => ({ workId: 'w1', update: String(n) })

describe('room admissions', () => {
  test('a member is checked on its first event in a room, not on every event', async () => {
    const { events, checks, received } = setup(new Set(['alice', 'bob']))
    for (let n = 0; n < 5; n += 1) await events.publishToRoom(room, ['alice', 'bob'], 'workLive.update', update(n))
    expect(checks).toEqual(['alice:workLive.update', 'bob:workLive.update'])
    expect(received.get('alice')).toEqual(['0', '1', '2', '3', '4'])
  })

  test('a refusal is not remembered: a member who gains access hears the next event', async () => {
    const allowed = new Set(['alice'])
    const { events, received } = setup(allowed)
    await events.publishToRoom(room, ['bob'], 'workLive.update', update(1))
    allowed.add('bob')
    await events.publishToRoom(room, ['bob'], 'workLive.update', update(2))
    expect(received.get('bob')).toEqual(['2'])
  })

  test('after a share or task change every member is checked again, so one who lost access hears nothing more', async () => {
    const allowed = new Set(['alice', 'bob'])
    const { events, checks, received } = setup(allowed)
    await events.publishToRoom(room, ['alice', 'bob'], 'workLive.update', update(1))
    allowed.delete('bob')
    events.forgetRoomAdmissions()
    await events.publishToRoom(room, ['alice', 'bob'], 'workLive.update', update(2))
    await events.publishToRoom(room, ['alice', 'bob'], 'workLive.update', update(3))
    expect(received.get('bob')).toEqual(['1'])
    expect(received.get('alice')).toEqual(['1', '2', '3'])
    // Bob, refused, is checked on each event again; Alice once after the change.
    expect(checks.filter((check) => check.startsWith('alice'))).toHaveLength(2)
  })

  test('a pass in one room does not admit the member to another', async () => {
    const allowed = new Set(['alice'])
    const { events, received } = setup(allowed)
    await events.publishToRoom(room, ['alice'], 'workLive.update', update(1))
    allowed.delete('alice')
    await events.publishToRoom({ kind: 'work', id: 'w2' }, ['alice'], 'workLive.update', { workId: 'w2', update: 'x' })
    expect(received.get('alice')).toEqual(['1'])
  })

  test('a client that reconnects is checked again', async () => {
    const allowed = new Set(['alice'])
    const { registry, events, checks } = setup(allowed)
    await events.publishToRoom(room, ['alice'], 'workLive.update', update(1))
    const unregister = registry.register('alice', () => {})
    unregister()
    registry.register('alice', () => {})
    await events.publishToRoom(room, ['alice'], 'workLive.update', update(2))
    expect(checks).toEqual(['alice:workLive.update', 'alice:workLive.update'])
  })
})
