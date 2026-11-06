import { describe, expect, test } from 'bun:test'
import { MAX_TELEMETRY_COMMAND_LENGTH, MAX_TELEMETRY_HISTORY_POINTS, MAX_TELEMETRY_PROCESS_ROWS, type HostTelemetryEvent } from '@solus/contracts/host-resources'
import type { MonitorSnapshot, ResourceMonitorOptions } from '../../packages/server/src/host/resource-monitor'
import { ResourceTelemetry, telemetrySampleOf } from '../../packages/server/src/host/resource-telemetry'

function snapshot(sampledAtUnixMs: number, count = 1): MonitorSnapshot {
  return {
    type: 'snapshot',
    sampledAtUnixMs,
    processes: Array.from({ length: count }, (_, index) => ({ pid: index + 1, ppid: 0, name: `p${index}`, command: 'c', cpuPercent: index, residentBytes: 10 })),
  }
}

function harness(opts: { path?: string | null; throwOnCreate?: boolean } = {}) {
  const clock = { now: 1_000 }
  const published: { clientIds: string[]; event: HostTelemetryEvent }[] = []
  const sampling: number[] = []
  const monitors: Pick<ResourceMonitorOptions, 'onSnapshot' | 'onFailed'>[] = []
  let stopped = 0
  const telemetry = new ResourceTelemetry({
    resolvePath: () => opts.path === undefined ? '/bin/monitor' : opts.path,
    createMonitor: (options) => {
      if (opts.throwOnCreate) throw new Error('spawn failed')
      monitors.push(options)
      return { setSampling: (ms) => sampling.push(ms), stop: () => { stopped += 1 } }
    },
    publish: (clientIds, event) => published.push({ clientIds, event }),
    rootPid: 1,
    now: () => clock.now,
  })
  return { telemetry, clock, published, sampling, monitors, stops: () => stopped }
}

describe('ResourceTelemetry', () => {
  test('starts nothing until a client asks', () => {
    const { monitors } = harness()
    expect(monitors).toHaveLength(0)
  })

  test('one monitor serves many clients, and samples go only to them', () => {
    const { telemetry, monitors, published } = harness()
    telemetry.subscribe('a')
    telemetry.subscribe('b')
    expect(monitors).toHaveLength(1)
    monitors[0]!.onSnapshot(snapshot(1_000))
    expect(published[0]?.clientIds).toEqual(['a', 'b'])
  })

  test('sampling stops with the last client and starts again with the next', () => {
    const { telemetry, sampling, monitors } = harness()
    telemetry.subscribe('a')
    telemetry.unsubscribe('a')
    expect(sampling).toEqual([0])
    telemetry.subscribe('b')
    expect(sampling).toEqual([0, 2_000])
    expect(monitors).toHaveLength(1)
  })

  test('a client that leaves without a word stops counting after its lease', () => {
    const { telemetry, sampling, monitors, clock, published } = harness()
    telemetry.subscribe('gone')
    clock.now += 21_000
    monitors[0]!.onSnapshot(snapshot(clock.now))
    expect(sampling).toEqual([0])
    expect(published).toHaveLength(0)
  })

  test('renewing keeps a client, and gives one state, not a second monitor', () => {
    const { telemetry, sampling, monitors, clock, published } = harness()
    telemetry.subscribe('a')
    clock.now += 15_000
    telemetry.subscribe('a')
    clock.now += 15_000
    monitors[0]!.onSnapshot(snapshot(clock.now))
    expect(monitors).toHaveLength(1)
    expect(sampling).toEqual([])
    expect(published).toHaveLength(1)
  })

  test('history is bounded, and a late client gets only what is recent', () => {
    const { telemetry, monitors, clock } = harness()
    telemetry.subscribe('a')
    for (let index = 0; index < MAX_TELEMETRY_HISTORY_POINTS + 50; index += 1) {
      clock.now += 2_000
      telemetry.subscribe('a')
      monitors[0]!.onSnapshot(snapshot(clock.now))
    }
    const state = telemetry.subscribe('b')
    expect(state.state === 'live' && state.history.length).toBe(MAX_TELEMETRY_HISTORY_POINTS)
    clock.now += 60 * 60_000
    const later = telemetry.subscribe('b')
    expect(later.state === 'live' && later.history.length).toBe(0)
  })

  test('a host without the monitor says so and keeps working', () => {
    const { telemetry, monitors } = harness({ path: null })
    expect(telemetry.subscribe('a')).toEqual({ state: 'unavailable', reason: 'missing' })
    expect(monitors).toHaveLength(0)
  })

  test('a spawn that throws is reported, not raised to the caller', () => {
    const { telemetry } = harness({ throwOnCreate: true })
    expect(telemetry.subscribe('a')).toEqual({ state: 'unavailable', reason: 'failed' })
  })

  test('a crash tells each client, and a later subscribe tries again, not sooner', () => {
    const { telemetry, monitors, clock, published } = harness()
    telemetry.subscribe('a')
    monitors[0]!.onFailed()
    expect(published.at(-1)).toEqual({ clientIds: ['a'], event: { state: 'unavailable', reason: 'failed' } })
    clock.now += 5_000
    expect(telemetry.subscribe('a').state).toBe('unavailable')
    expect(monitors).toHaveLength(1)
    clock.now += 30_000
    expect(telemetry.subscribe('a').state).toBe('live')
    expect(monitors).toHaveLength(2)
  })

  test('stop ends the child', () => {
    const { telemetry, stops } = harness()
    telemetry.subscribe('a')
    telemetry.stop()
    expect(stops()).toBe(1)
  })
})

describe('telemetrySampleOf', () => {
  test('a sample that crosses the network has a fixed size, and names what it left out', () => {
    const large = snapshot(5, 5_000)
    large.processes[0]!.command = 'x'.repeat(16 * 1024)
    large.processes[0]!.cpuPercent = 9_999
    const sample = telemetrySampleOf(large)
    expect(sample.processes).toHaveLength(MAX_TELEMETRY_PROCESS_ROWS)
    expect(sample.processCount).toBe(5_000)
    expect(sample.processes[0]?.pid).toBe(1)
    expect(sample.processes[0]?.command).toHaveLength(MAX_TELEMETRY_COMMAND_LENGTH)
    expect(JSON.stringify(sample).length).toBeLessThan(8_000)
  })

  test('totals cover the whole tree, not only the rows sent', () => {
    expect(telemetrySampleOf(snapshot(5, 100)).residentBytes).toBe(1_000)
  })
})
