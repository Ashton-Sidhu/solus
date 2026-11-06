// ─── Host resources ───
//
// docs/plans/resource-telemetry.md. Machine load is the whole machine at one
// time. Process telemetry is what the resource monitor reports for the Solus
// server's process tree. Both cross the network, so each has a fixed size.

/** The most process rows one sample carries. `processCount` names the whole tree. */
export const MAX_TELEMETRY_PROCESS_ROWS = 20
/** The longest process name and command line a row carries, in characters. */
export const MAX_TELEMETRY_NAME_LENGTH = 80
export const MAX_TELEMETRY_COMMAND_LENGTH = 200
/** The history points a client gets and keeps: 5 minutes at one sample each 2 s. */
export const MAX_TELEMETRY_HISTORY_POINTS = 150

/** Machine load. It reads no process table, so a host without the monitor has it too. */
export interface HostResources {
  /** On the host's clock. A client compares receipt times, never clocks of two machines. */
  sampledAt: number
  /** 0 to 1 over the whole machine. Null when the host could not measure it. */
  cpuUtilization: number | null
  cpuCount: number
  availableMemoryBytes: number
  totalMemoryBytes: number
}

export interface HostProcessRow {
  pid: number
  ppid: number
  name: string
  /** Cut to `MAX_TELEMETRY_COMMAND_LENGTH`. */
  command: string
  /** 100 is one core. */
  cpuPercent: number
  residentBytes: number
}

/** One read of the server's process tree. */
export interface HostTelemetrySample {
  sampledAt: number
  /** Every process in the tree, also those `processes` leaves out. */
  processCount: number
  /** The tree's total. 100 is one core. */
  cpuPercent: number
  residentBytes: number
  /** The busiest rows, at most `MAX_TELEMETRY_PROCESS_ROWS`. */
  processes: HostProcessRow[]
}

/** One history point of the process tree's totals. */
export type HostTelemetryPoint = Pick<HostTelemetrySample, 'sampledAt' | 'cpuPercent' | 'residentBytes'>

/** Why a host has no process telemetry. `missing`: this package has no monitor.
 *  `failed`: the monitor stopped, or it speaks another protocol. */
export type HostTelemetryUnavailableReason = 'missing' | 'failed'

export type HostTelemetry =
  /** `sample` is null until the first read after sampling starts. */
  | { state: 'live'; sample: HostTelemetrySample | null; history: HostTelemetryPoint[] }
  | { state: 'unavailable'; reason: HostTelemetryUnavailableReason }

/** What a subscribed client gets for each read. */
export type HostTelemetryEvent =
  | { state: 'live'; sample: HostTelemetrySample }
  | { state: 'unavailable'; reason: HostTelemetryUnavailableReason }
