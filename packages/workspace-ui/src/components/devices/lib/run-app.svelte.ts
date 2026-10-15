import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { isDeviceRunActive, type DeviceBuild, type DeviceRun, type DeviceRunTarget, type DeviceSummary } from '@solus/contracts/device-types'
import type { InstallResult } from './build-list'

/**
 * Production builds for one host. Builds belong to the host, not to a
 * conversation or a window, so each host has one Run app: every conversation
 * and window shows the same choices and the same run. A run that is still
 * going on the host wins over the choices, whatever its project, until it
 * ends; then the choices apply again.
 */

export interface RunAppView {
  projectPath: string | null
  branch: string
  target: DeviceRunTarget
  /** The run for what is shown: the active one, else the latest that matches the choices. */
  latest: DeviceRun | undefined
}

export type InstallStatus = { state: 'installing' } | { state: 'installed' } | { state: 'failed'; error: string }

export class RunApp {
  /** Null follows the conversation's project. */
  projectPath = $state<string | null>(null)
  /** Empty uses the project's default branch. */
  branch = $state('')
  /** What a production build runs on. */
  target = $state<DeviceRunTarget>('ios-simulator')
  /** The build whose install list is open; one at a time. */
  openBuildId = $state<string | null>(null)
  /** Devices checked for the open build. */
  readonly installDeviceIds = new SvelteSet<string>()
  /** How the latest install of each build on each device went, by `buildId\0deviceId`. */
  readonly installs = new SvelteMap<string, InstallStatus>()

  /** Open a build's install list, or close it when it is open. Checks start empty. */
  toggleBuild(buildId: string): void {
    this.openBuildId = this.openBuildId === buildId ? null : buildId
    this.installDeviceIds.clear()
  }

  installStatus(buildId: string, deviceId: string): InstallStatus | undefined {
    return this.installs.get(`${buildId}\u0000${deviceId}`)
  }

  /**
   * Install one build on every device at once. Each device reports on its own,
   * so one locked phone does not hide that the rest worked.
   */
  async install(build: DeviceBuild, devices: readonly DeviceSummary[], installOne: (device: DeviceSummary) => Promise<void>, errorText: (cause: unknown) => string): Promise<InstallResult[]> {
    for (const device of devices) this.installs.set(`${build.buildId}\u0000${device.deviceId}`, { state: 'installing' })
    const settled = await Promise.allSettled(devices.map((device) => installOne(device)))
    return devices.map((device, index) => {
      const outcome = settled[index]!
      const error = outcome.status === 'rejected' ? errorText(outcome.reason) : null
      this.installs.set(`${build.buildId}\u0000${device.deviceId}`, error === null ? { state: 'installed' } : { state: 'failed', error })
      return { deviceName: device.name, error }
    })
  }

  chooseProject(projectPath: string | null): void {
    this.projectPath = projectPath
    this.branch = ''
  }

  /**
   * What to show from the host's runs, newest first. `conversationProjectPath`
   * is the default project; `defaultBranchOf` names a project's default branch.
   */
  view(runs: readonly DeviceRun[], conversationProjectPath: string | null, defaultBranchOf: (projectPath: string) => string): RunAppView {
    const active = runs.find(isDeviceRunActive)
    if (active) {
      return {
        projectPath: active.checkoutPath,
        branch: active.mode === 'device' && active.branch ? active.branch : defaultBranchOf(active.checkoutPath),
        target: active.target ?? this.target,
        latest: active,
      }
    }
    const projectPath = this.projectPath ?? conversationProjectPath
    const branch = this.branch || (projectPath ? defaultBranchOf(projectPath) : '')
    const latest = runs.find((run) => run.checkoutPath === projectPath && run.mode === 'device'
      && run.branch === branch && run.target === this.target)
    return { projectPath, branch, target: this.target, latest }
  }
}

/** One Run app per host, made on first use. */
class RunApps {
  /** Not reactive: filled lazily from a `$derived`; each Run app's fields are `$state`. */
  private readonly byHost = new Map<string, RunApp>()

  for(serverId: string): RunApp {
    let runApp = this.byHost.get(serverId)
    if (!runApp) {
      runApp = new RunApp()
      this.byHost.set(serverId, runApp)
    }
    return runApp
  }
}

export const runApps = new RunApps()

/** Whether a build or dev server is still going on the host, for the Run app button. */
export function hasActiveRun(runs: readonly DeviceRun[]): boolean {
  return runs.some(isDeviceRunActive)
}
