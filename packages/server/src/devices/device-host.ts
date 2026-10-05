import type {
  DeviceHostSummary,
  DevicePlatform,
  DevicePlatformAvailability,
} from '@solus/contracts/device-types'
import type { DeviceCommandRunner } from './device-process'
import type { DeviceToolName } from './device-toolchain'

/**
 * A machine with simulators or emulators on it. The device manager only talks
 * to this interface, so the SSH host slots in beside the local one without
 * touching discovery, streaming, actions or agent tools. Adapted from T3 Code
 * (MIT, pingdotgg/t3code@43bd667, apps/server/src/device/DeviceHost.ts).
 *
 * A ready host presents a loopback origin where expo-device-hub answers. The
 * agent-device daemon endpoint exists only after agent access is granted. For
 * an SSH host both are forwarded to this machine's loopback.
 */

export interface DeviceHostReady {
  /** Loopback origin of expo-device-hub, e.g. `http://127.0.0.1:3400`. */
  hubOrigin: string
  /** Node on the device host, for helper scripts the hub vendors. */
  nodePath: string
  /** Runs `xcrun`, `adb`, `emulator` or a vendored helper where the devices live. */
  run: DeviceCommandRunner
  helpers: { serveSimAxSettings: string | null; serveSimCli: string | null }
}

export interface AgentDeviceEndpoint {
  baseUrl: string
  token: string
}

export interface DeviceHostAgentReady extends DeviceHostReady {
  agentDevice: AgentDeviceEndpoint
}

export type DeviceHostPhase = 'installing' | 'starting'
export type DeviceHostPhaseListener = (phase: DeviceHostPhase, detail?: string) => void

export class DeviceHostError extends Error {
  constructor(readonly deviceHostId: string, readonly step: string, detail?: string) {
    super(`Device host ${deviceHostId} failed while ${step}${detail ? `: ${detail}` : ''}.`)
  }
}

export interface DeviceHost {
  readonly deviceHostId: string
  readonly kind: 'local' | 'ssh'
  /** Inventory and tool versions. Never installs or starts anything. */
  summary(): Promise<DeviceHostSummary>
  platformAvailability(platform: DevicePlatform): Promise<DevicePlatformAvailability>
  /** Install the hub on first use and start it. Concurrent callers share one start. */
  ensureReady(onPhase: DeviceHostPhaseListener): Promise<DeviceHostReady>
  /** Install and start agent-device after agent access is granted. */
  ensureAgentReady(onPhase: DeviceHostPhaseListener): Promise<DeviceHostAgentReady>
  /** Current endpoints when already running, without starting anything. */
  current(): DeviceHostReady | null
  /** Install one pinned tool without starting it. */
  updateTool(tool: DeviceToolName): Promise<void>
  /** Stop agent-device only. Manual viewing stays available. */
  stopAgent(): Promise<void>
  /** Stop owned helpers. Devices keep running; the user owns those. */
  stop(): Promise<void>
}
