import { describe, expect, mock, test } from 'bun:test'
import { RunningServers, type RunningServersSource } from '@solus/client-core/running-servers'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import type { RunningServer } from '@solus/contracts/running-servers'
import { runningServer } from './running-server-fixtures'

function setup() {
  const events = new HostEventSubscriber()
  let resolve: (servers: RunningServer[]) => void = () => {}
  const watch = mock(() => new Promise<RunningServer[]>((answer) => { resolve = answer }))
  const unwatch = mock(async () => {})
  const source: RunningServersSource = { api: { runningServersWatch: watch, runningServersUnwatch: unwatch, runningServerStop: async () => ({ status: 'stopped' }), runningServerTunnel: async () => ({ relativeUrl: '/tunnel', expiresAt: 1 }), runningServersCheckoutRoots: async (paths) => paths.map((path) => ({ path, root: path })), projectConfigLoad: async () => null, projectConfigSave: async (_path, config) => config }, events, ready: true }
  let connectionChanged = () => {}
  const store = new RunningServers(() => ({ ...source }), (changed) => { connectionChanged = changed; return () => {} })
  return { store, watch, unwatch, events, source,
    answer: async (servers = [runningServer()]) => { resolve(servers); await Promise.resolve(); await Promise.resolve() },
    connect: (ready: boolean) => { source.ready = ready; connectionChanged() },
  }
}

describe('shared running server state', () => {
  test('two readers retain one host subscription until the last leaves', async () => {
    const s = setup()
    const first = s.store.retain()
    const second = s.store.retain()
    expect(s.watch).toHaveBeenCalledTimes(1)
    await s.answer()
    expect(s.store.current.status).toBe('ready')
    first()
    expect(s.unwatch).not.toHaveBeenCalled()
    second()
    expect(s.unwatch).toHaveBeenCalledTimes(1)
    second()
    expect(s.unwatch).toHaveBeenCalledTimes(1)
  })

  test('a changed event cannot be overwritten by an older initial RPC', async () => {
    const s = setup()
    const release = s.store.retain()
    s.events.receive({ type: 'runningServers.changed', payload: { servers: [runningServer('new')], error: null }, occurredAt: 1 })
    await s.answer([runningServer('old')])
    expect(s.store.current.servers[0].serverId).toBe('new')
    release()
  })

  test('a disconnect clears the list and rejects an old connection answer', async () => {
    const s = setup()
    const release = s.store.retain()
    s.connect(false)
    await s.answer()
    expect(s.store.current).toEqual({ status: 'disconnected', servers: [], error: null })
    s.connect(true)
    await s.answer([runningServer('reconnected')])
    expect(s.store.current.servers[0].serverId).toBe('reconnected')
    release()
  })

  test('releasing during initial load discards its answer and closes the lease', async () => {
    const s = setup()
    const release = s.store.retain()
    release()
    await s.answer()
    expect(s.store.current.servers).toHaveLength(0)
    expect(s.unwatch).toHaveBeenCalled()
  })

  test('a failed scan removes stale running claims and can recover through an event', async () => {
    const s = setup()
    const release = s.store.retain()
    await s.answer()
    s.events.receive({ type: 'runningServers.changed', payload: { servers: [], error: 'Cannot read processes' }, occurredAt: 1 })
    expect(s.store.current).toEqual({ status: 'error', servers: [], error: 'Cannot read processes' })
    s.events.receive({ type: 'runningServers.changed', payload: { servers: [runningServer()], error: null }, occurredAt: 2 })
    expect(s.store.current.status).toBe('ready')
    release()
  })
})

test('a missing host starts disconnected rather than loading forever', () => {
  const store = new RunningServers(() => null, () => () => {})
  const release = store.retain()
  expect(store.current.status).toBe('disconnected')
  release()
})

test('an equal host update keeps object identity and does not invalidate readers', async () => {
  const s = setup()
  const release = s.store.retain()
  await s.answer()
  const held = s.store.current
  const listener = mock(() => {})
  const unsubscribe = s.store.subscribe(listener)
  s.events.receive({ type: 'runningServers.changed', payload: { servers: structuredClone([...held.servers]), error: null }, occurredAt: 1 })
  expect(s.store.current).toBe(held)
  expect(listener).not.toHaveBeenCalled()
  unsubscribe()
  release()
})
