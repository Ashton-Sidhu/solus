import { describe, expect, mock, spyOn, test } from 'bun:test'
import { RunningServersController, type RunningServersSource } from '@solus/client-core/running-servers'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import type { RunningServer } from '@solus/contracts/running-servers'
import { runningServer } from './running-server-fixtures'

function setup() {
  const events = new HostEventSubscriber()
  let resolve: (servers: RunningServer[]) => void = () => {}
  const watch = mock((_paths: string[]) => new Promise<RunningServer[]>((answer) => { resolve = answer }))
  const unwatch = mock(async () => {})
  const source: RunningServersSource = { api: { runningServersWatch: watch, runningServersUnwatch: unwatch, runningServerStop: async () => ({ status: 'stopped' }), runningServerTunnel: async () => ({ relativeUrl: '/tunnel', expiresAt: 1 }), runningServersCheckoutRoots: async (paths) => paths.map((path) => ({ path, root: path })), projectConfigLoad: async () => null, projectConfigSave: async (_path, config) => config }, events, ready: true }
  let connectionChanged = () => {}
  const store = new RunningServersController(() => ({ ...source }), (changed) => { connectionChanged = changed; return () => {} })
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
    expect(s.store.status).toBe('ready')
    first()
    expect(s.unwatch).not.toHaveBeenCalled()
    second()
    // The watch ends once the tick ends with no holder.
    await Promise.resolve()
    expect(s.unwatch).toHaveBeenCalledTimes(1)
    second()
    await Promise.resolve()
    expect(s.unwatch).toHaveBeenCalledTimes(1)
  })

  // WHY: a tab switch unmounts the old Git section and mounts the new one in
  // one tick. That sent an unwatch, a watch, a checkout-roots read, and a second
  // watch; it is one watch with the new path, and a checkout read before
  // needs no roots read.
  test('a tab switch moves the watch to the new checkout in one call', async () => {
    const s = setup()
    const roots = mock(async (paths: string[]) => paths.map((path) => ({ path, root: path })))
    s.source.api.runningServersCheckoutRoots = roots
    const releaseA = s.store.retainCheckout('/a')
    await s.answer()
    releaseA()
    const releaseB = s.store.retainCheckout('/b')
    await Promise.resolve()
    expect(s.unwatch).not.toHaveBeenCalled()
    expect(s.watch.mock.calls.map(([paths]) => paths)).toEqual([['/a'], ['/b']])
    await s.answer()
    releaseB()
    const releaseAgain = s.store.retainCheckout('/a')
    await Promise.resolve()
    expect(s.watch.mock.calls.map(([paths]) => paths)).toEqual([['/a'], ['/b'], ['/a']])
    expect(roots.mock.calls.map(([paths]) => paths)).toEqual([['/a'], ['/b']])
    await s.answer()
    releaseAgain()
    await Promise.resolve()
    expect(s.unwatch).toHaveBeenCalledTimes(1)
  })

  // The host keeps a watch until the client leaves and pushes changes, so a
  // held watch costs no traffic; only a port forward's ticket needs renewal.
  test('a held watch without forwards schedules no renewal', async () => {
    const interval = spyOn(globalThis, 'setInterval')
    const s = setup()
    const release = s.store.retain()
    await s.answer()
    expect(interval).not.toHaveBeenCalled()
    expect(s.watch).toHaveBeenCalledTimes(1)
    release()
    interval.mockRestore()
  })

  test('checkout rows that mount and unmount together send one watch each way', async () => {
    const s = setup()
    const release = s.store.retain()
    await s.answer()
    const releases = ['/a', '/b', '/b'].map((path) => s.store.retainCheckout(path))
    await Promise.resolve()
    expect(s.watch.mock.calls.map(([paths]) => paths)).toEqual([[], ['/a', '/b']])
    await s.answer()
    for (const releaseCheckout of releases) releaseCheckout()
    await Promise.resolve()
    expect(s.watch.mock.calls.map(([paths]) => paths)).toEqual([[], ['/a', '/b'], []])
    release()
  })

  test('a changed event cannot be overwritten by an older initial RPC', async () => {
    const s = setup()
    const release = s.store.retain()
    s.events.receive({ type: 'runningServers.changed', payload: { servers: [runningServer('new')], error: null }, occurredAt: 1 })
    await s.answer([runningServer('old')])
    expect(s.store.servers[0].serverId).toBe('new')
    release()
  })

  test('a disconnect clears the list and rejects an old connection answer', async () => {
    const s = setup()
    const release = s.store.retain()
    s.connect(false)
    await s.answer()
    expect({ status: s.store.status, servers: s.store.servers, error: s.store.error }).toEqual({ status: 'disconnected', servers: [], error: null })
    s.connect(true)
    await s.answer([runningServer('reconnected')])
    expect(s.store.servers[0].serverId).toBe('reconnected')
    release()
  })

  test('releasing during initial load discards its answer and closes the lease', async () => {
    const s = setup()
    const release = s.store.retain()
    release()
    await s.answer()
    expect(s.store.servers).toHaveLength(0)
    expect(s.unwatch).toHaveBeenCalled()
  })

  test('a failed scan removes stale running claims and can recover through an event', async () => {
    const s = setup()
    const release = s.store.retain()
    await s.answer()
    s.events.receive({ type: 'runningServers.changed', payload: { servers: [], error: 'Cannot read processes' }, occurredAt: 1 })
    expect({ status: s.store.status, servers: s.store.servers, error: s.store.error }).toEqual({ status: 'error', servers: [], error: 'Cannot read processes' })
    s.events.receive({ type: 'runningServers.changed', payload: { servers: [runningServer()], error: null }, occurredAt: 2 })
    expect(s.store.status).toBe('ready')
    release()
  })
})

test('a missing host starts disconnected rather than loading forever', () => {
  const store = new RunningServersController(() => null, () => () => {})
  const release = store.retain()
  expect(store.status).toBe('disconnected')
  release()
})

test('an equal host update keeps object identity and does not invalidate readers', async () => {
  const s = setup()
  const release = s.store.retain()
  await s.answer()
  const held = s.store.servers
  const listener = mock(() => {})
  const unsubscribe = s.store.subscribe(listener)
  s.events.receive({ type: 'runningServers.changed', payload: { servers: structuredClone([runningServer()]), error: null }, occurredAt: 1 })
  expect(s.store.servers).toBe(held)
  expect(listener).not.toHaveBeenCalled()
  unsubscribe()
  release()
})

function whenReady(store: RunningServersController): Promise<void> {
  if (store.status === 'ready') return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = store.subscribe(() => { if (store.status === 'ready') { unsubscribe(); resolve() } })
  })
}

test('checkout filtering uses the host root instead of a subfolder prefix', async () => {
  const s = setup()
  const main = runningServer('main')
  main.location.worktreePath = '/project'
  s.source.api.runningServersWatch = async () => [main, runningServer('worktree')]
  s.source.api.runningServersCheckoutRoots = async (paths) => paths.map((path) => ({ path, root: '/project/worktree' }))
  const ready = whenReady(s.store)
  const release = s.store.retainCheckout('/project/worktree/api')
  await ready
  expect(s.store.inCheckout('/project/worktree/api').map((server) => server.serverId)).toEqual(['worktree'])
  release()
})

test('forwarding keeps discovery retained and Stop forwarding closes its last lease', async () => {
  const s = setup()
  s.source.api.runningServersWatch = async () => [runningServer()]
  const stop = mock(async (_forwardId: string) => {})
  const start = mock(async (request: import('@solus/contracts/running-servers').NativeServerForwardRequest) => ({ forwardId: 'forward', endpointKey: request.endpointKey, localPort: 1234, url: 'http://127.0.0.1:1234/' }))
  const store = new RunningServersController(() => s.source, () => () => {}, { keyPrefix: 'host', origin: () => 'https://host.test', start, stop, list: async () => [], openExternal: async () => true })
  const ready = whenReady(store)
  const release = store.retain()
  await ready
  const server = store.servers[0]
  await server.forward(server.endpoints[0])
  expect(start.mock.calls[0][0].tunnelUrl).toBe('wss://host.test/tunnel')
  release()
  expect(s.unwatch).not.toHaveBeenCalled()
  expect(server.forwards).toHaveLength(1)
  await server.stopForward('forward')
  expect(server.forwards).toEqual([])
  expect(stop).toHaveBeenCalledWith('forward')
  // A watch still in flight when the last holder leaves is closed again when it answers.
  expect(s.unwatch).toHaveBeenCalled()
})

test('a refresh updates the same RunningServers object, and a removed identity cannot be stopped', async () => {
  const s = setup()
  const release = s.store.retain()
  await s.answer()
  const server = s.store.servers[0]
  const changed = runningServer()
  changed.process.name = 'API'
  s.events.receive({ type: 'runningServers.changed', payload: { servers: [changed], error: null }, occurredAt: 1 })
  expect(s.store.servers[0]).toBe(server)
  expect(server.process.name).toBe('API')
  const stop = mock(async () => ({ status: 'stopped' as const }))
  s.source.api.runningServerStop = stop
  s.events.receive({ type: 'runningServers.changed', payload: { servers: [runningServer('replacement')], error: null }, occurredAt: 2 })
  await expect(server.stop()).rejects.toThrow('no longer connected')
  expect(stop).not.toHaveBeenCalled()
  release()
})

test('opening a local host endpoint in the system browser skips the forward', async () => {
  const s = setup()
  s.source.api.runningServersWatch = async () => [runningServer()]
  const start = mock(async (request: import('@solus/contracts/running-servers').NativeServerForwardRequest) => ({ forwardId: 'forward', endpointKey: request.endpointKey, localPort: 1234, url: 'http://127.0.0.1:1234/' }))
  const openExternal = mock(async (_url: string) => true)
  const store = new RunningServersController(() => s.source, () => () => {}, { keyPrefix: 'host', origin: () => 'https://host.test', start, stop: async () => {}, list: async () => [], openExternal })
  const ready = whenReady(store)
  const release = store.retain()
  await ready
  const server = store.servers[0]
  const endpoint = server.endpoints[0]
  await server.openExternal(endpoint, { isLocalHost: true })
  expect(start).not.toHaveBeenCalled()
  expect(openExternal).toHaveBeenLastCalledWith(endpoint.url)
  await server.openExternal(endpoint)
  expect(start).toHaveBeenCalled()
  expect(openExternal).toHaveBeenLastCalledWith('http://127.0.0.1:1234/')
  await server.stopForward('forward')
  release()
})
