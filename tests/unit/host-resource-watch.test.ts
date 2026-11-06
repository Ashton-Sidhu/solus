import { afterEach, describe, expect, test } from 'bun:test'
import { HostResourceWatch, machineCpuText, machineMemoryText, telemetryCpuPeak, telemetrySparkline, type HostResourceView } from '@solus/client-core/host-resource-watch'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { MAX_TELEMETRY_HISTORY_POINTS, type HostResources, type HostTelemetry, type HostTelemetrySample } from '@solus/contracts/host-resources'

const resources: HostResources = { sampledAt: 1, cpuUtilization: 0.25, cpuCount: 8, availableMemoryBytes: 4 * 1024 ** 3, totalMemoryBytes: 16 * 1024 ** 3 }
const sample = (sampledAt: number): HostTelemetrySample => ({ sampledAt, processCount: 1, cpuPercent: 5, residentBytes: 1, processes: [] })

function harness(opts: { allowed?: boolean; telemetry?: HostTelemetry; failReads?: boolean } = {}) {
  const calls = { subscribe: 0, unsubscribe: 0 }
  const events = new HostEventSubscriber()
  const views: HostResourceView[] = []
  const api = {
    hostResources: async () => {
      if (opts.failReads) throw new Error('down')
      return resources
    },
    hostTelemetrySubscribe: async () => {
      calls.subscribe += 1
      return opts.telemetry ?? { state: 'live' as const, sample: null, history: [] }
    },
    hostTelemetryUnsubscribe: async () => { calls.unsubscribe += 1 },
  }
  const watch = new HostResourceWatch({ api, events, mayReadProcesses: () => opts.allowed ?? true, onChange: (view) => views.push(view) })
  return { watch, calls, events, views, latest: () => views.at(-1)! }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
let running: HostResourceWatch | null = null
afterEach(() => running?.stop())

describe('HostResourceWatch', () => {
  test('a person without host admin sees machine load and asks for no process table', async () => {
    const h = harness({ allowed: false })
    running = h.watch
    h.watch.start()
    await flush()
    expect(h.latest().resources).toEqual(resources)
    expect(h.latest().telemetry).toEqual({ state: 'hidden' })
    expect(h.calls.subscribe).toBe(0)
  })

  test('live samples extend the history and stay bounded', async () => {
    const h = harness({ telemetry: { state: 'live', sample: null, history: [] } })
    running = h.watch
    h.watch.start()
    await flush()
    for (let index = 0; index < MAX_TELEMETRY_HISTORY_POINTS + 20; index += 1) {
      h.events.receive({ type: 'host.telemetry', payload: { state: 'live', sample: sample(index) }, occurredAt: 0 })
    }
    const telemetry = h.latest().telemetry
    expect(telemetry.state === 'live' && telemetry.history.length).toBe(MAX_TELEMETRY_HISTORY_POINTS)
  })

  test('a host that stops answering keeps the last read and says it is stale', async () => {
    const h = harness({ failReads: true })
    running = h.watch
    h.watch.start()
    await flush()
    expect(h.latest()).toMatchObject({ resources: null, stale: true })
  })

  test('a monitor that fails shows why, and the machine numbers stay', async () => {
    const h = harness()
    running = h.watch
    h.watch.start()
    await flush()
    h.events.receive({ type: 'host.telemetry', payload: { state: 'unavailable', reason: 'failed' }, occurredAt: 0 })
    expect(h.latest().telemetry).toEqual({ state: 'unavailable', reason: 'failed' })
    expect(h.latest().resources).toEqual(resources)
  })

  test('leaving the page ends the subscription and hears nothing more', async () => {
    const h = harness()
    h.watch.start()
    await flush()
    h.watch.stop()
    await flush()
    expect(h.calls.unsubscribe).toBe(1)
    const seen = h.views.length
    h.events.receive({ type: 'host.telemetry', payload: { state: 'live', sample: sample(1) }, occurredAt: 0 })
    expect(h.views).toHaveLength(seen)
  })

  test('leaving before the host answers still ends the subscription', async () => {
    const h = harness()
    h.watch.start()
    h.watch.stop()
    await flush()
    expect(h.calls.unsubscribe).toBe(1)
  })
})

describe('resource text', () => {
  test('reads as a person says it', () => {
    expect(machineCpuText(resources)).toBe('25% of 8 cores')
    expect(machineMemoryText(resources)).toBe('4.0 GB available of 16.0 GB')
  })

  test('an unknown CPU reading is not shown as zero', () => {
    expect(machineCpuText({ ...resources, cpuUtilization: null })).toBe('Unknown, 8 cores')
  })

  test('a CPU chart tops out at one core, or at a higher point', () => {
    const point = (cpuPercent: number) => ({ sampledAt: 1, cpuPercent, residentBytes: 1 })
    expect(telemetryCpuPeak([point(20), point(60)])).toBe(100)
    expect(telemetryCpuPeak([point(20), point(340)])).toBe(340)
  })

  test('a sparkline needs two points', () => {
    expect(telemetrySparkline([{ sampledAt: 1, cpuPercent: 1, residentBytes: 1 }], 10, 10)).toBeNull()
    expect(telemetrySparkline([{ sampledAt: 1, cpuPercent: 0, residentBytes: 1 }, { sampledAt: 2, cpuPercent: 100, residentBytes: 1 }], 10, 10)).toBe('0.0,10.0 10.0,0.0')
  })
})
