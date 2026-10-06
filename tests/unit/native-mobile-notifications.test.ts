import { describe, expect, test } from 'bun:test'
import { NativeNotificationHub } from '../../apps/mobile/src/features/notifications/notification-hub'
import { nativeDestination } from '../../apps/mobile/src/features/notifications/lib/native-destinations'
import { Listeners } from '../../apps/mobile/src/lib/listeners'
import type { HostConnections } from '../../apps/mobile/src/features/hosts/host-connections'
import type { HostRegistry } from '../../apps/mobile/src/features/hosts/host-registry'
import { FakeNotificationSource } from './helpers/fake-notification-source'

// plans/015-notifications-hub.md v2 §6, stage 4 (native): the phone reads every
// host it knows through the connections the app already holds, with the same
// engine as desktop and web. An unreachable host keeps no one else waiting and is
// read again when it connects; another person signing in sees nothing of the
// last one's; and a resource the app has no screen for says where it opens.

interface FakeWorld {
  hub: NativeNotificationHub
  sources: Record<string, FakeNotificationSource>
  connected: Set<string>
  connectionChanges: Listeners
  account: { id: string | null; changes: Listeners }
}

function world(hostIds: string[]): FakeWorld {
  const sources: Record<string, FakeNotificationSource> = {}
  for (const id of hostIds) sources[id] = new FakeNotificationSource()
  const connected = new Set(hostIds)
  const connectionChanges = new Listeners()
  const registryChanges = new Listeners()
  const account = { id: null as string | null, changes: new Listeners() }
  // SAFETY: the hub reads only these members of the registry and the connections.
  const registry = { changes: registryChanges, hosts: () => hostIds.map((id) => ({ id, label: id })) } as unknown as HostRegistry
  const connections = {
    changes: connectionChanges,
    state: (id: string) => ({ phase: connected.has(id) ? 'connected' : 'offline' }),
    connection: (id: string) => {
      if (!connected.has(id)) return null
      const link = sources[id]!.link()
      return { api: link.api, events: { subscribe: (_topic: string, listener: () => void) => link.onChanged(listener) }, onAccepted: link.onReconnected }
    },
  } as unknown as HostConnections
  const hub = new NativeNotificationHub({ registry, connections, identity: () => account.id ? `account:${account.id}` : 'device' })
  return { hub, sources, connected, connectionChanges, account }
}

async function settled(hub: NativeNotificationHub): Promise<void> {
  // The engine's reads are promise chains; a refresh with nothing new is the deterministic barrier.
  await hub.refresh()
  await hub.refresh()
}

describe('native notifications hub', () => {
  test('native startup keeps the badge live and reads history only while its screen has focus', async () => {
    const { hub, sources, account } = world(['mac'])
    sources.mac!.add({ id: 'first', createdAt: 1 })
    const stop = hub.start(account.changes)
    await settled(hub)
    expect(hub.snapshot().unread.unread).toBe(1)
    expect(sources.mac!.calls).not.toContain('notificationsList')
    const blur = hub.showHistory()
    await settled(hub)
    expect(hub.snapshot().entries.map((row) => row.notification.id)).toEqual(['first'])
    blur()
    sources.mac!.calls.length = 0
    sources.mac!.add({ id: 'second', createdAt: 2 })
    sources.mac!.emitChanged()
    await settled(hub)
    expect(hub.snapshot().unread.unread).toBe(2)
    expect(sources.mac!.calls).not.toContain('notificationsList')
    stop()
  })

  test('every host this device knows feeds one list; the snapshot is stable between changes', async () => {
    const { hub, sources, account } = world(['mac', 'vm'])
    sources.mac!.add({ id: 'm', createdAt: 1 })
    sources.vm!.add({ id: 'v', createdAt: 2 })
    const stop = hub.start(account.changes)
    hub.showHistory()
    await settled(hub)
    expect(hub.snapshot().entries.map((row) => row.notification.id)).toEqual(['v', 'm'])
    expect(hub.snapshot()).toBe(hub.snapshot())
    expect(hub.snapshot().unread).toEqual({ unread: 2, isCapped: false, isComplete: true })
    stop()
  })

  test('an unreachable host holds no one else, and is read once it connects', async () => {
    const { hub, sources, connected, connectionChanges, account } = world(['mac', 'vm'])
    sources.mac!.add({ id: 'm', createdAt: 1 })
    sources.vm!.add({ id: 'v', createdAt: 2 })
    connected.delete('vm')
    const stop = hub.start(account.changes)
    hub.showHistory()
    await settled(hub)
    expect(hub.snapshot().entries.map((row) => row.notification.id)).toEqual(['m'])
    expect(hub.snapshot().sources.find((state) => state.source.serverId === 'vm')?.status).toBe('offline')

    connected.add('vm')
    connectionChanges.notify()
    await settled(hub)
    expect(hub.snapshot().entries.map((row) => row.notification.id)).toEqual(['v', 'm'])
    stop()
  })

  test('another person signing in sees nothing of the last one\'s', async () => {
    const { hub, sources, account } = world(['mac'])
    sources.mac!.add({ id: 'private', createdAt: 1 })
    const stop = hub.start(account.changes)
    hub.showHistory()
    await settled(hub)
    expect(hub.snapshot().entries).toHaveLength(1)
    sources.mac!.items.clear()
    account.id = 'someone-else'
    account.changes.notify()
    expect(hub.snapshot().entries).toEqual([])
    await settled(hub)
    expect(hub.snapshot().entries).toEqual([])
    stop()
  })

  test('a resource the app has no screen for says where it opens', () => {
    expect(nativeDestination({ kind: 'task', taskId: 't' })).toEqual({ kind: 'unsupported', message: 'This app does not show tasks yet. Open it in Solus on your computer or on the web.' })
  })
})
