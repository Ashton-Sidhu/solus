import { describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { RunningServer } from '@solus/contracts/running-servers'
import { runningServer } from './running-server-fixtures'
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { RunningServerRegistry } = await import('@solus/server/host/running-servers/registry')

function setup() {
  let now = 0
  let servers = [runningServer()]
  let failure: Error | null = null
  let sameIdentity = true
  const ticks: (() => Promise<void>)[] = []
  const publish = mock((_clients: string[], _servers: RunningServer[], _error: string | null) => {})
  const signal = mock(async (_server: RunningServer) => { servers = []; return { status: 'stopped' as const } })
  const scan = mock(async () => { if (failure) throw failure; return structuredClone(servers) })
  const registry = new RunningServerRegistry({
    discovery: { discover: scan, checkoutRoots: async () => [], identityMatches: async () => sameIdentity, stopJob: signal },
    publish, now: () => now,
    schedule: (tick) => { ticks.push(tick); return () => { const index = ticks.indexOf(tick); if (index >= 0) ticks.splice(index, 1) } },
  })
  return { registry, scan, publish, signal, ticks,
    advance: (ms: number) => { now += ms },
    replace: (next: RunningServer[]) => { servers = next },
    fail: () => { failure = new Error('Process table unavailable') },
    changeIdentity: () => { sameIdentity = false },
  }
}

function detectedServer(serverId = 'server-1'): RunningServer {
  const server = runningServer(serverId)
  server.endpoints[0].response = null
  return server
}

describe('one running server registry per host', () => {
  test('a temporary listener stays available to live discovery without changing the watched list', async () => {
    const s = setup()
    const server = detectedServer()
    s.replace([server])
    expect(await s.registry.watch('desktop')).toEqual([])
    expect(await s.registry.list()).toEqual([server])
    s.publish.mockClear()
    s.replace([])
    s.advance(3000)
    await s.ticks.shift()!()
    expect(s.publish).not.toHaveBeenCalled()
    s.replace([server])
    s.advance(12_000)
    await s.ticks.shift()!()
    expect(s.publish).not.toHaveBeenCalled()
    s.registry.stop()
  })

  test('each detected port waits 15 seconds, then disappears on the first scan without it', async () => {
    const s = setup()
    const server = detectedServer()
    const [first] = server.endpoints
    const second = { ...first, endpointId: '3002', port: 3002, url: 'http://127.0.0.1:3002/' }
    s.replace([server])
    expect(await s.registry.watch('desktop')).toEqual([])
    s.publish.mockClear()
    s.advance(3000)
    s.replace([{ ...server, endpoints: [first, second] }])
    await s.registry.list(true)
    s.advance(11_999)
    expect(await s.registry.watch('phone', ['/project/worktree'])).toEqual([])
    expect(s.publish).not.toHaveBeenCalled()
    s.advance(1)
    await s.ticks.shift()!()
    expect(s.publish).toHaveBeenLastCalledWith(['desktop', 'phone'], [server], null)
    expect(await s.registry.watch('web')).toEqual([server])
    s.advance(3000)
    s.replace([{ ...server, endpoints: [second] }])
    await s.ticks.shift()!()
    expect(s.publish).toHaveBeenLastCalledWith(['desktop', 'phone', 'web'], [{ ...server, endpoints: [second] }], null)
    s.registry.stop()
  })

  test('a new process on the same port starts its own 15-second wait', async () => {
    const s = setup()
    s.replace([detectedServer()])
    await s.registry.watch('desktop')
    s.advance(12_000)
    const replacement = detectedServer('replacement')
    s.replace([replacement])
    await s.ticks.shift()!()
    s.publish.mockClear()
    s.advance(3000)
    await s.ticks.shift()!()
    expect(s.publish).not.toHaveBeenCalled()
    s.advance(12_000)
    await s.ticks.shift()!()
    expect(s.publish).toHaveBeenLastCalledWith(['desktop'], [replacement], null)
    s.registry.stop()
  })

  test('a responding configured URL appears immediately, even on an agent process', async () => {
    const s = setup()
    const server = runningServer()
    expect(await s.registry.watch('desktop')).toEqual([server])
    s.registry.stop()
  })

  test('clients share a scan and unchanged polls send no list', async () => {
    const s = setup()
    await Promise.all([s.registry.watch('desktop'), s.registry.watch('phone')])
    expect(s.scan).toHaveBeenCalledTimes(1)
    s.publish.mockClear()
    s.advance(3000)
    await s.ticks.shift()!()
    expect(s.publish).not.toHaveBeenCalled()
    s.registry.stop()
  })

  test('a vanished server is removed on every subscribed client', async () => {
    const s = setup()
    await s.registry.watch('desktop')
    await s.registry.watch('phone')
    s.replace([])
    s.advance(3000)
    await s.ticks.shift()!()
    expect(s.publish).toHaveBeenLastCalledWith(['desktop', 'phone'], [], null)
    s.registry.stop()
  })

  // A client watches once; the disconnect hook ends the watch, so the client sends no renewal.
  test('a watch keeps scanning without renewal until its client leaves', async () => {
    const s = setup()
    await s.registry.watch('desktop')
    s.advance(60_000)
    await s.ticks.shift()!()
    expect(s.scan).toHaveBeenCalledTimes(2)
    expect(s.ticks).toHaveLength(1)
    s.registry.unwatch('desktop')
    expect(s.ticks).toHaveLength(0)
  })

  test('the last client leaving cancels polling', async () => {
    const s = setup()
    await s.registry.watch('desktop')
    s.registry.unwatch('desktop')
    expect(s.ticks).toHaveLength(0)
  })

  test('scan errors are visible, not a successful empty list', async () => {
    const s = setup()
    await s.registry.watch('desktop')
    s.fail()
    await s.ticks.shift()!()
    expect(s.publish).toHaveBeenLastCalledWith(['desktop'], [], 'Process table unavailable')
    s.registry.stop()
  })

  test('a reused PID cannot receive a stop meant for the previous process', async () => {
    const s = setup()
    await s.registry.list()
    s.replace([runningServer('replacement')])
    expect(await s.registry.stopServer('server-1')).toEqual({ status: 'refused', reason: 'identity-changed' })
    expect(s.signal).not.toHaveBeenCalled()
  })

  test('stop rechecks identity immediately before signalling', async () => {
    const s = setup()
    await s.registry.list()
    s.changeIdentity()
    expect(await s.registry.stopServer('server-1')).toEqual({ status: 'refused', reason: 'identity-changed' })
    expect(s.signal).not.toHaveBeenCalled()
  })

  test('unattributed processes cannot be stopped and no caller PID is accepted', async () => {
    const s = setup()
    const server = runningServer()
    server.actions.canStop = false
    server.startedBy = { kind: 'unknown' }
    s.replace([server])
    await s.registry.list()
    expect(await s.registry.stopServer('server-1')).toEqual({ status: 'refused', reason: 'not-permitted' })
    expect(await s.registry.stopServer('123')).toEqual({ status: 'already-exited' })
    expect(s.signal).not.toHaveBeenCalled()
  })

  test('stopping waits for the verified job and publishes its removal immediately', async () => {
    const s = setup()
    await s.registry.list()
    expect(await s.registry.stopServer('server-1')).toEqual({ status: 'stopped' })
    expect(s.signal).toHaveBeenCalledTimes(1)
    expect(s.signal.mock.calls[0][0].serverId).toBe('server-1')
    expect(s.publish).toHaveBeenLastCalledWith([], [], null)
  })
})
