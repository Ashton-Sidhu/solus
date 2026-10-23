import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/mobile-connections.md "When a host freezes": a host that stalls past the
// ping timeout drops its clients, and only the host can say why after it recovers.

type StallModule = typeof import('@solus/server/host/event-loop-stalls')
type Principal = import('@solus/server/admission/principal').Principal

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let stalls: StallModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-event-loop-stalls-'))
  process.env.SOLUS_DATA_DIR = dataDir
  stalls = await import('@solus/server/host/event-loop-stalls')
})

afterAll(() => {
  stalls.useEventLoopStallMonitor(null)
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

/** A monitor on a fake clock: `advance` is time the loop was free or blocked. */
function fakeMonitor(load: { loadAverage?: number; cpuCount: number } = { loadAverage: 219.43, cpuCount: 18 }) {
  let monotonic = 0
  const wallStart = Date.UTC(2026, 9, 21, 12, 0, 0)
  const monitor = new stalls.EventLoopStallMonitor({
    tickMs: 1_000,
    logAtMs: 2_000,
    monotonicNow: () => monotonic,
    wallNow: () => wallStart + monotonic,
    machineLoad: () => load,
  })
  return {
    monitor,
    wallStart,
    /** The next tick fires `ms` after the last one. */
    tickAfter(ms: number) {
      monotonic += ms
      monitor.check()
    },
    /** Time passes with no tick. */
    advance(ms: number) {
      monotonic += ms
    },
  }
}

describe('event loop stall monitor', () => {
  test('keeps a stall a person felt, with the machine load, and not a short one', () => {
    // WHY: a 3 s hiccup does not drop a client; telling the user about it is noise.
    const clock = fakeMonitor()
    clock.tickAfter(1_000)
    clock.tickAfter(4_000)
    expect(clock.monitor.recentStall()).toBeUndefined()

    clock.tickAfter(13_000)
    expect(clock.monitor.recentStall()).toEqual({
      endedAt: clock.wallStart + 18_000,
      durationMs: 12_000,
      loadAverage: 219.4,
      cpuCount: 18,
    })
  })

  test('a read finds a stall that ended before the next tick', () => {
    // WHY: the client reconnects right after the host frees up; the stall must be in that first answer.
    const clock = fakeMonitor()
    clock.tickAfter(1_000)
    clock.advance(9_000)
    expect(clock.monitor.recentStall()?.durationMs).toBe(8_000)
    // The tick after the read is on time: the same stall is not seen twice.
    clock.tickAfter(1_000)
    expect(clock.monitor.recentStall()?.endedAt).toBe(clock.wallStart + 10_000)
  })

  test('a stall older than 5 minutes no longer explains a drop', () => {
    const clock = fakeMonitor()
    clock.tickAfter(7_000)
    for (let i = 0; i < 300; i++) clock.tickAfter(1_000)
    expect(clock.monitor.recentStall()).toBeDefined()
    clock.tickAfter(1_000)
    expect(clock.monitor.recentStall()).toBeUndefined()
  })

  test('a host with no load average sends none', () => {
    const clock = fakeMonitor({ cpuCount: 4 })
    clock.tickAfter(6_000)
    expect(clock.monitor.recentStall()).toEqual({ endedAt: clock.wallStart + 6_000, durationMs: 5_000, cpuCount: 4 })
  })
})

describe('connectionsGetServerInfo', () => {
  const OWNER: Principal = { kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Mac' }

  async function serverInfo(): Promise<ConnectionsServerInfo> {
    const { SolusServer } = await import('@solus/server/transport/server')
    const { registerConnectionsHandlers } = await import('@solus/server/transport/handlers/connections-handlers')
    const server = new SolusServer()
    registerConnectionsHandlers(server, {
      getServerInfo: () => ({ host: '127.0.0.1', port: 3000, allowLan: false, remoteAccess: false, requireAuth: false, trustLocalNetwork: false, hostKind: 'self-hosted', roles: ['execution', 'collaboration'] }),
      getActiveSessions: () => [],
      discoverLanServers: async () => [],
      setRemoteAccess: async () => { throw new Error('not here') },
      setTrustLocalNetwork: () => { throw new Error('not here') },
      introducedHosts: { list: async () => { throw new Error('not here') }, issue: async () => { throw new Error('not here') }, accept: async () => { throw new Error('not here') }, forget: async () => { throw new Error('not here') }, allow: async () => { throw new Error('not here') } },
      disconnectRemoteHost: () => {},
      tunnelUrl: () => null,
      mirrorOrigin: async () => null,
    })
    return await server.handle('connectionsGetServerInfo', [], { clientId: 'ws:owner', principal: OWNER })
  }

  test('carries the recent stall, and leaves the field out when there is none', async () => {
    // WHY: an older client ignores the field, and a host that did not freeze must not claim it did.
    stalls.useEventLoopStallMonitor(null)
    expect('recentEventLoopStall' in (await serverInfo())).toBe(false)

    const clock = fakeMonitor({ loadAverage: 3, cpuCount: 8 })
    stalls.useEventLoopStallMonitor(clock.monitor)
    clock.tickAfter(1_000)
    expect('recentEventLoopStall' in (await serverInfo())).toBe(false)
    clock.tickAfter(11_000)
    expect((await serverInfo()).recentEventLoopStall).toEqual({ endedAt: clock.wallStart + 12_000, durationMs: 10_000, loadAverage: 3, cpuCount: 8 })
  })
})
