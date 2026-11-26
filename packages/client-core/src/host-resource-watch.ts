import { MAX_TELEMETRY_HISTORY_POINTS, type HostDiskSpace, type HostTelemetry, type HostTelemetryEvent, type HostTelemetryPoint, type HostTelemetrySample, type HostTelemetryUnavailableReason } from '@solus/contracts/host-resources'
import type { HostApi } from './host-api'
import type { HostEventSubscriber } from './host-event-subscriber'

/** Renews the telemetry lease well inside its 20 s, which also restores it after a reconnect. */
const REFRESH_MS = 5_000

export type HostTelemetryView =
  /** This client may not read the process table here. */
  | { state: 'hidden' }
  | { state: 'loading' }
  | { state: 'live'; sample: HostTelemetrySample | null; history: HostTelemetryPoint[] }
  | { state: 'unavailable'; reason: HostTelemetryUnavailableReason }

/** Machine load is not here: the host's summary reads it (`fleetStore`). */
export interface HostResourceView {
  telemetry: HostTelemetryView
}

export const EMPTY_HOST_RESOURCE_VIEW: HostResourceView = { telemetry: { state: 'loading' } }

export interface HostResourceWatchOptions {
  api: Pick<HostApi, 'hostTelemetrySubscribe' | 'hostTelemetryUnsubscribe'>
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
    this.timer = setInterval(() => void this.refreshTelemetry(), REFRESH_MS)
    void this.refreshTelemetry()
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
      // A dropped host: the last view stays, and the next refresh renews.
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

/** The used share of a disk, 0 to 100. */
export function diskUsedPercent(disk: HostDiskSpace): number {
  return Math.round((1 - disk.availableBytes / disk.totalBytes) * 100)
}

/** How much a person can still write: "128 GB free". */
export function diskFreeText(disk: HostDiskSpace): string {
  return `${formatResourceBytes(disk.availableBytes)} free`
}

export function telemetrySummaryText(sample: HostTelemetrySample): string {
  const processes = `${sample.processCount} ${sample.processCount === 1 ? 'process' : 'processes'}`
  return `${Math.round(sample.cpuPercent)}% CPU · ${formatResourceBytes(sample.residentBytes)} · ${processes}`
}

export function telemetryUnavailableText(reason: HostTelemetryUnavailableReason): string {
  return reason === 'missing'
    ? 'This host has no resource monitor. Machine load shows above.'
    : 'The resource monitor stopped. Solus tries again while this page is open.'
}

/** The top of a CPU chart: one full core, or the highest point when it is higher. */
export function telemetryCpuPeak(history: readonly HostTelemetryPoint[]): number {
  return Math.max(100, ...history.map((point) => point.cpuPercent))
}

/** Each point's CPU as a percentage of the chart's top (`telemetryCpuPeak`), for a sparkline. */
export function telemetryCpuShares(history: readonly HostTelemetryPoint[]): number[] {
  const peak = telemetryCpuPeak(history)
  return history.map((point) => (point.cpuPercent / peak) * 100)
}
