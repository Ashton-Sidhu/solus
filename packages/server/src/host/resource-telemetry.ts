import {
  MAX_TELEMETRY_COMMAND_LENGTH,
  MAX_TELEMETRY_HISTORY_POINTS,
  MAX_TELEMETRY_NAME_LENGTH,
  MAX_TELEMETRY_PROCESS_ROWS,
  type HostTelemetry,
  type HostTelemetryEvent,
  type HostTelemetryPoint,
  type HostTelemetrySample,
  type HostTelemetryUnavailableReason,
} from '@solus/contracts/host-resources'
import type { MonitorSnapshot, ResourceMonitorOptions } from './resource-monitor'

const SAMPLE_INTERVAL_MS = 2_000
/** A client renews while it looks. A window that closes without saying so stops counting. */
const SUBSCRIBER_LEASE_MS = 20_000
/** A failed monitor is tried again on a later subscribe, not in a loop. */
const RETRY_AFTER_MS = 30_000
/** A point this old says nothing about now. Sampling stops while nobody looks. */
const HISTORY_WINDOW_MS = SAMPLE_INTERVAL_MS * MAX_TELEMETRY_HISTORY_POINTS

function round(value: number): number {
  return Math.round(value * 10) / 10
}

/** A row count, not a byte count, bounds the frame: each text is cut too. */
export function telemetrySampleOf(snapshot: MonitorSnapshot): HostTelemetrySample {
  let cpuPercent = 0
  let residentBytes = 0
  for (const process of snapshot.processes) {
    cpuPercent += process.cpuPercent
    residentBytes += process.residentBytes
  }
  const busiest = [...snapshot.processes]
    .sort((a, b) => b.cpuPercent - a.cpuPercent || b.residentBytes - a.residentBytes)
    .slice(0, MAX_TELEMETRY_PROCESS_ROWS)
  return {
    sampledAt: snapshot.sampledAtUnixMs,
    processCount: snapshot.processes.length,
    cpuPercent: round(cpuPercent),
    residentBytes,
    processes: busiest.map((process) => ({
      pid: process.pid,
      ppid: process.ppid,
      name: process.name.slice(0, MAX_TELEMETRY_NAME_LENGTH),
      command: process.command.slice(0, MAX_TELEMETRY_COMMAND_LENGTH),
      cpuPercent: round(process.cpuPercent),
      residentBytes: process.residentBytes,
    })),
  }
}

/** What this module needs of a monitor, so a test can supply its own. */
export interface TelemetryMonitor {
  setSampling(sampleIntervalMs: number): void
  stop(): void
}

export interface ResourceTelemetryDeps {
  /** The binary, or null when this package has none. */
  resolvePath: () => string | null
  createMonitor: (options: Pick<ResourceMonitorOptions, 'path' | 'rootPid' | 'sampleIntervalMs' | 'onSnapshot' | 'onFailed'>) => TelemetryMonitor
  publish: (clientIds: string[], event: HostTelemetryEvent) => void
  rootPid: number
  now: () => number
}

/**
 * Process telemetry for the clients that look at it (docs/plans/resource-telemetry.md).
 * The first subscriber starts the monitor; with none it stops sampling, so an
 * idle server walks no process table. A monitor that is missing or fails makes
 * telemetry unavailable and changes nothing else.
 */
export class ResourceTelemetry {
  /** Client id to the time of its last renewal. */
  private readonly subscribers = new Map<string, number>()
  private readonly history: HostTelemetryPoint[] = []
  private monitor: TelemetryMonitor | null = null
  private sampling = false
  private latest: HostTelemetrySample | null = null
  private unavailable: HostTelemetryUnavailableReason | null = null
  private failedAt: number | null = null

  constructor(private readonly deps: ResourceTelemetryDeps) {}

  /** Start or renew. Idempotent: a client calls it while it looks. */
  subscribe(clientId: string): HostTelemetry {
    this.subscribers.set(clientId, this.deps.now())
    this.ensureSampling()
    if (this.unavailable) return { state: 'unavailable', reason: this.unavailable }
    const oldest = this.deps.now() - HISTORY_WINDOW_MS
    return { state: 'live', sample: this.latest, history: this.history.filter((point) => point.sampledAt >= oldest) }
  }

  unsubscribe(clientId: string): void {
    this.subscribers.delete(clientId)
    if (this.subscribers.size === 0) this.pauseSampling()
  }

  /** Ends the child, which waits on its stdin while no client looks. */
  stop(): void {
    this.monitor?.stop()
    this.monitor = null
    this.sampling = false
  }

  private ensureSampling(): void {
    if (this.monitor) {
      if (!this.sampling) this.monitor.setSampling(SAMPLE_INTERVAL_MS)
      this.sampling = true
      return
    }
    if (this.failedAt !== null && this.deps.now() - this.failedAt < RETRY_AFTER_MS) return
    const path = this.deps.resolvePath()
    if (!path) {
      this.unavailable = 'missing'
      return
    }
    this.unavailable = null
    this.failedAt = null
    this.sampling = true
    let monitor: TelemetryMonitor | null = null
    try {
      monitor = this.deps.createMonitor({
        path,
        rootPid: this.deps.rootPid,
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
        onSnapshot: (snapshot) => this.receive(snapshot),
        onFailed: () => { if (this.monitor === monitor) this.fail() },
      })
      this.monitor = monitor
    } catch {
      this.fail()
    }
  }

  private pauseSampling(): void {
    this.latest = null
    if (!this.monitor || !this.sampling) return
    this.sampling = false
    this.monitor.setSampling(0)
  }

  private fail(): void {
    this.monitor = null
    this.sampling = false
    this.latest = null
    this.unavailable = 'failed'
    this.failedAt = this.deps.now()
    this.deps.publish([...this.subscribers.keys()], { state: 'unavailable', reason: 'failed' })
  }

  private receive(snapshot: MonitorSnapshot): void {
    this.dropExpiredLeases()
    if (this.subscribers.size === 0) return
    const sample = telemetrySampleOf(snapshot)
    this.latest = sample
    this.history.push({ sampledAt: sample.sampledAt, cpuPercent: sample.cpuPercent, residentBytes: sample.residentBytes })
    if (this.history.length > MAX_TELEMETRY_HISTORY_POINTS) this.history.shift()
    this.deps.publish([...this.subscribers.keys()], { state: 'live', sample })
  }

  private dropExpiredLeases(): void {
    const oldest = this.deps.now() - SUBSCRIBER_LEASE_MS
    for (const [clientId, renewedAt] of this.subscribers) {
      if (renewedAt < oldest) this.subscribers.delete(clientId)
    }
    if (this.subscribers.size === 0) this.pauseSampling()
  }
}
