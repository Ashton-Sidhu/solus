import { join } from 'node:path'
import type { DeviceState, SshDeviceHostConfig } from '@solus/contracts/device-types'
import { writeAssetBytes } from '../data/assets/assets'
import { dataDir } from '../platform/paths'
import { DeviceAgentBridge } from './device-agent-bridge'
import { DeviceBuildStore } from './device-builds'
import { DeviceRuns } from './device-run'
import { DeviceHubProxy } from './device-hub-proxy'
import { spawnHelper } from './device-helpers'
import type { DeviceHost } from './device-host'
import { DeviceManager } from './device-manager'
import { runDeviceCommand } from './device-process'
import { DeviceSettingsStore } from './device-settings-store'
import { DeviceToolchain } from './device-toolchain'
import { LocalDeviceHost, processCommandLine } from './local-device-host'

/**
 * Composes the device domain for one Solus host process. Everything it owns
 * lives under `<data dir>/devices`: pinned tools, helper state and settings.
 */

export interface DeviceDomain {
  manager: DeviceManager
  /** The signed pass-through route from a client to a device's hub stream. */
  hubProxy: DeviceHubProxy
  /** Where the agent-device CLI keeps per-host endpoint config (0600). */
  agentConfigDir: string
  toolchain: DeviceToolchain
  /** The guarded loopback path from an agent's CLI to the daemon. */
  bridge: DeviceAgentBridge
  /** Build and run of a project's saved run profiles. */
  runs: DeviceRuns
  /** A client's connection expired: its proxied streams close and its control ends. */
  dropClient: (clientId: string) => void
}

export interface DeviceDomainOptions {
  publish: (state: DeviceState) => void
  surfaceRequested: (payload: { sessionId: string; devicePreviewId: string; openedBy: 'user' | 'agent' }) => void
  makeSshHost?: (config: SshDeviceHostConfig, deps: { toolchain: DeviceToolchain; stateDir: string }) => DeviceHost
  isLocalSshTarget?: (config: SshDeviceHostConfig) => Promise<boolean>
  root?: string
}

let current: DeviceDomain | null = null

export function initDeviceDomain(options: DeviceDomainOptions): DeviceDomain {
  const root = options.root ?? join(dataDir(), 'devices')
  const toolchain = new DeviceToolchain(join(root, 'tools'), runDeviceCommand)
  const stateDir = join(root, 'state')
  const localHost = new LocalDeviceHost({
    stateDir: join(stateDir, 'local'),
    toolchain,
    run: runDeviceCommand,
    spawn: spawnHelper,
    processCommandLine: (pid) => processCommandLine(pid, runDeviceCommand),
  })
  const makeSshHost = options.makeSshHost
  // The bridge and the manager refer to each other: the bridge checks leases
  // the manager owns, and the manager revokes bindings when access ends.
  let manager: DeviceManager | null = null
  let runs: DeviceRuns | null = null
  const bridge = new DeviceAgentBridge({
    endpoint: (deviceHostId) => manager?.agentEndpoint(deviceHostId) ?? null,
    acquire: (binding, holder) => { manager!.control.acquireForAgent(binding, holder) },
  })
  manager = new DeviceManager({
    settings: new DeviceSettingsStore(join(root, 'settings.json')),
    localHost,
    makeSshHost: makeSshHost ? (config) => makeSshHost(config, { toolchain, stateDir: join(stateDir, 'ssh', config.id) }) : undefined,
    isLocalSshTarget: options.isLocalSshTarget,
    publish: options.publish,
    surfaceRequested: options.surfaceRequested,
    storeImage: async (bytes) => ({ assetId: (await writeAssetBytes(bytes, 'png')).id }),
    builds: new DeviceBuildStore({ path: join(root, 'builds.json'), run: runDeviceCommand }),
    runs: () => runs?.list() ?? [],
    revokeAgentBindings: (predicate) => bridge.revoke(predicate),
  })
  const runner = new DeviceRuns({ manager, approvalsPath: join(root, 'run-approvals.json'), changed: () => manager?.changed() })
  runs = runner
  const hubProxy = new DeviceHubProxy({
    hubOrigin: async (target) => (await manager!.resolveDevice(target.deviceHostId, target.deviceId)).ready.hubOrigin,
    holdsControl: (target, clientId) => {
      const holder = manager!.control.state(target).lease?.holder
      return holder?.kind === 'user' && holder.clientId === clientId
    },
  })
  const dropClient = (clientId: string) => {
    hubProxy.dropClient(clientId)
    manager!.control.dropClient(clientId)
  }
  current = { manager, hubProxy, agentConfigDir: join(stateDir, 'agent-config'), toolchain, bridge, runs: runner, dropClient }
  return current
}

/** The process's device domain, for agent tools. Null before boot composes it. */
export function deviceDomain(): DeviceDomain | null {
  return current
}
