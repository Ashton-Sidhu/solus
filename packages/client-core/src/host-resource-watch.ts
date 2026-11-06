import { MAX_TELEMETRY_HISTORY_POINTS, type HostResources, type HostTelemetry, type HostTelemetryEvent, type HostTelemetryPoint, type HostTelemetrySample, type HostTelemetryUnavailableReason } from '@solus/contracts/host-resources'
import type { HostApi } from './host-api'
import type { HostEventSubscriber } from './host-event-subscriber'

/** Machine load moves slowly, and the host caches it for 5 s. This also renews
 *  the telemetry lease, which restores it after a reconnect. */
const REFRESH_MS = 5_000

export type HostTelemetryView =
  /** This client may not read the process table here. */
  | { state: 'hidden' }
  | { state: 'loading' }
  | { state: 'live'; sample: HostTelemetrySample | null; history: HostTelemetryPoint[] }
  | { state: 'unavailable'; reason: HostTelemetryUnavailableReason }

export interface HostResourceView {
  /** The last answer. It stays when a read fails, and `stale` says so. */
  resources: HostResources | null
  stale: boolean
  telemetry: HostTelemetryView
}

export const EMPTY_HOST_RESOURCE_VIEW: HostResourceView = { resources: null, stale: false, telemetry: { state: 'loading' } }

export interface HostResourceWatchOptions {
  api: Pick<HostApi, 'hostResources' | 'hostTelemetrySubscribe' | 'hostTelemetryUnsubscribe'>
  events: HostEventSubscriber
  /** Asked on each refresh: the host answers permissions after the first read. */
  mayReadProcesses: () => boolean
  onChange: (view: HostResourceView) => void
}

/**
 * What one open surface shows about a host (docs/plans/resource-telemetry.md).
 * Plain TypeScript for desktop, web, and mobile. It runs only while a surface
 * holds it, so a client that does not look asks the host for nothing.
 */
export class HostResourceWatch {
  private view: HostResourceView = EMPTY_HOST_RESOURCE_VIEW
  private timer: ReturnType<typeof setInterval> | null = null
  private stopEvents: (() => void) | null = null
  private subscribed = false

  constructor(private readonly options: HostResourceWatchOptions) {}

  start(): void {
    if (this.timer) return
    this.stopEvents = this.options.events.subscribe('host.telemetry', (event) => this.receive(event))
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS)
    void this.refresh()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    this.stopEvents?.()
    this.stopEvents = null
    if (this.subscribed) void this.options.api.hostTelemetryUnsubscribe().catch(() => {})
    this.subscribed = false
  }

  private get running(): boolean {
    return this.timer !== null
  }

  private update(change: Partial<HostResourceView>): void {
    this.view = { ...this.view, ...change }
    this.options.onChange(this.view)
  }

  private async refresh(): Promise<void> {
    await Promise.all([this.refreshResources(), this.refreshTelemetry()])
  }

  private async refreshResources(): Promise<void> {
    try {
      const resources = await this.options.api.hostResources()
      if (this.running) this.update({ resources, stale: false })
    } catch {
      if (this.running) this.update({ stale: true })
    }
  }

  private async refreshTelemetry(): Promise<void> {
    if (!this.options.mayReadProcesses()) {
      this.update({ telemetry: { state: 'hidden' } })
      return
    }
    try {
      const telemetry = await this.options.api.hostTelemetrySubscribe()
      if (!this.running) {
        // `stop` ran first, so nothing else will end this subscription.
        void this.options.api.hostTelemetryUnsubscribe().catch(() => {})
        return
      }
      this.subscribed = true
      this.update({ telemetry: this.withSample(telemetry) })
    } catch {
      // A dropped host: the last view stays, `stale` says so, and the next refresh renews.
    }
  }

  /** The host's answer, with the newer sample a client may already hold. */
  private withSample(telemetry: HostTelemetry): HostTelemetryView {
    if (telemetry.state !== 'live') return telemetry
    const current = this.view.telemetry
    const held = current.state === 'live' ? current.sample : null
    const sample = held && (!telemetry.sample || held.sampledAt > telemetry.sample.sampledAt) ? held : telemetry.sample
    return { state: 'live', sample, history: telemetry.history }
  }

  private receive(event: HostTelemetryEvent): void {
    if (event.state === 'unavailable') {
      this.update({ telemetry: event })
      return
    }
    const current = this.view.telemetry
    const history = current.state === 'live' ? current.history : []
    const point: HostTelemetryPoint = { sampledAt: event.sample.sampledAt, cpuPercent: event.sample.cpuPercent, residentBytes: event.sample.residentBytes }
    this.update({ telemetry: { state: 'live', sample: event.sample, history: [...history, point].slice(-MAX_TELEMETRY_HISTORY_POINTS) } })
  }
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatResourceBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`
}

/** "23% of 12 cores". */
export function machineCpuText(resources: HostResources): string {
  const cores = `${resources.cpuCount} ${resources.cpuCount === 1 ? 'core' : 'cores'}`
  return resources.cpuUtilization === null ? `Unknown, ${cores}` : `${Math.round(resources.cpuUtilization * 100)}% of ${cores}`
}

/** "8.4 GB available of 32 GB". */
export function machineMemoryText(resources: HostResources): string {
  return `${formatResourceBytes(resources.availableMemoryBytes)} available of ${formatResourceBytes(resources.totalMemoryBytes)}`
}

export function machineMemoryUsedShare(resources: HostResources): number {
  return resources.totalMemoryBytes > 0 ? 1 - resources.availableMemoryBytes / resources.totalMemoryBytes : 0
}

export function telemetrySummaryText(sample: HostTelemetrySample): string {
  const processes = `${sample.processCount} ${sample.processCount === 1 ? 'process' : 'processes'}`
  return `${Math.round(sample.cpuPercent)}% CPU · ${formatResourceBytes(sample.residentBytes)} · ${processes}`
}

export function telemetryUnavailableText(reason: HostTelemetryUnavailableReason): string {
  return reason === 'missing'
    ? 'This host has no resource monitor. Machine load still shows.'
    : 'The resource monitor stopped. Solus tries again while this page is open.'
}

/** The top of a CPU chart: one full core, or the highest point when it is higher. */
export function telemetryCpuPeak(history: readonly HostTelemetryPoint[]): number {
  return Math.max(100, ...history.map((point) => point.cpuPercent))
}

/** Points scaled to a `width` by `height` box, for an SVG polyline. Null below two points. */
export function telemetrySparkline(history: readonly HostTelemetryPoint[], width: number, height: number): string | null {
  if (history.length < 2) return null
  const peak = telemetryCpuPeak(history)
  return history
    .map((point, index) => `${((index / (history.length - 1)) * width).toFixed(1)},${(height - (point.cpuPercent / peak) * height).toFixed(1)}`)
    .join(' ')
}
