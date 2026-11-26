import { afterEach, describe, expect, test } from 'bun:test'
import { HostResourceWatch, telemetryCpuPeak, telemetryCpuShares, type HostResourceView } from '@solus/client-core/host-resource-watch'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { MAX_TELEMETRY_HISTORY_POINTS, type HostTelemetry, type HostTelemetrySample } from '@solus/contracts/host-resources'

const sample = (sampledAt: number): HostTelemetrySample => ({ sampledAt, processCount: 1, cpuPercent: 5, residentBytes: 1, processes: [] })

function harness(opts: { allowed?: boolean; telemetry?: HostTelemetry } = {}) {
  const calls = { subscribe: 0, unsubscribe: 0 }
  const host = { answers: true }
  const events = new HostEventSubscriber()
  const views: HostResourceView[] = []
  const api = {
    hostTelemetrySubscribe: async () => {
      calls.subscribe += 1
      if (!host.answers) throw new Error('down')
      return opts.telemetry ?? { state: 'live' as const, sample: null, history: [] }
    },
    hostTelemetryUnsubscribe: async () => { calls.unsubscribe += 1 },
  }
  const watch = new HostResourceWatch({ api, events, mayReadProcesses: () => opts.allowed ?? true, onChange: (view) => views.push(view) })
  return { watch, calls, host, events, views, latest: () => views.at(-1)! }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
let running: HostResourceWatch | null = null
afterEach(() => running?.stop())

describe('HostResourceWatch', () => {
  test('a person without host admin asks for no process table', async () => {
    const h = harness({ allowed: false })
    running = h.watch
    h.watch.start()
    await flush()
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

  test('a host that stops answering keeps the last process view', async () => {
    const h = harness()
    running = h.watch
    h.watch.start()
    await flush()
    h.events.receive({ type: 'host.telemetry', payload: { state: 'live', sample: sample(1) }, occurredAt: 0 })
    const seen = h.latest()
    h.watch.stop()
    h.host.answers = false
    h.watch.start()
    await flush()
    expect(h.calls.subscribe).toBe(2)
    expect(h.latest()).toBe(seen)
  })

  test('a monitor that fails shows why', async () => {
    const h = harness()
    running = h.watch
    h.watch.start()
    await flush()
    h.events.receive({ type: 'host.telemetry', payload: { state: 'unavailable', reason: 'failed' }, occurredAt: 0 })
    expect(h.latest().telemetry).toEqual({ state: 'unavailable', reason: 'failed' })
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
  test('a CPU chart tops out at one core, or at a higher point', () => {
    const point = (cpuPercent: number) => ({ sampledAt: 1, cpuPercent, residentBytes: 1 })
    expect(telemetryCpuPeak([point(20), point(60)])).toBe(100)
    expect(telemetryCpuPeak([point(20), point(340)])).toBe(340)
  })

  test('the sparkline scales to the chart top, so several busy cores do not run off the line', () => {
    const point = (cpuPercent: number) => ({ sampledAt: 1, cpuPercent, residentBytes: 1 })
    expect(telemetryCpuShares([point(20), point(60)])).toEqual([20, 60])
    expect(telemetryCpuShares([point(100), point(400)])).toEqual([25, 100])
  })
})
