import { isDeviceRunActive, parseDeviceError, type DeviceRunStartRequest, type DeviceRun, type DeviceRunProfile, type DeviceBuild, type DeviceControlState, type DeviceSummary, type DeviceTarget } from '@solus/contracts/device-types'
import type { HostApi } from './host-api'

/**
 * Installing an app build from a client (plan 016, S02). Shared by the
 * workspace and the native mobile app so both follow the same control rule:
 * an install never takes a device from an agent that is using it.
 */

/** The file name to save a downloaded build as. */
export function buildDownloadName(build: DeviceBuild): string {
  return build.name.endsWith('.apk') ? build.name : `${build.name}.apk`
}

/**
 * Install under control. A lease this client already holds is used as is;
 * otherwise the client takes a free device for the install and gives it back.
 */
export async function installDeviceBuild(
  api: Pick<HostApi, 'deviceControlAcquire' | 'deviceControlRelease' | 'deviceInstall'>,
  target: DeviceTarget & { deviceHostId: string },
  build: DeviceBuild,
  control: DeviceControlState,
  isHeld: boolean,
): Promise<DeviceBuild> {
  if (isHeld) return api.deviceInstall({ ...target, buildId: build.buildId })
  if (control.lease) {
    throw new Error(`${control.lease.holder.label} is using this device. Try again when it is free.`)
  }
  await api.deviceControlAcquire(target)
  try {
    return await api.deviceInstall({ ...target, buildId: build.buildId })
  } finally {
    await api.deviceControlRelease(target).catch(() => {})
  }
}

/**
 * Start an app operation on the selected device. The
 * host asks once per command, because profiles come from the repository:
 * `confirm` shows that question, and null means the person declined.
 */
export async function startDeviceRun(
  api: Pick<HostApi, 'deviceRunStart'>,
  request: DeviceRunStartRequest,
  confirm: (question: string) => boolean | Promise<boolean>,
): Promise<DeviceRun | null> {
  try {
    return await api.deviceRunStart(request)
  } catch (cause) {
    const parsed = parseDeviceError(cause instanceof Error ? cause.message : String(cause))
    if (parsed?.code !== 'confirmation_required') throw cause
    if (!(await confirm(parsed.message))) return null
    return api.deviceRunStart({ ...request, approve: true })
  }
}

/** What a build profile builds for, as a person picks between them. A simulator build cannot go on a phone. */
export function profileTargetLabel(profile: Pick<DeviceRunProfile, 'platform' | 'target'>): string {
  if (profile.platform === 'android') return 'Android'
  return profile.target === 'device' ? 'iPhone or iPad' : profile.target === 'simulator' ? 'iOS Simulator' : 'iOS'
}


/** A saved target configuration must match the device selected before the build. */
export function profilesForDevice(profiles: readonly DeviceRunProfile[] | null | undefined, device: DeviceSummary): DeviceRunProfile[] {
  return (profiles ?? []).filter((profile) => profile.platform === device.platform
    && (profile.target === 'any' || (profile.target === 'device') === device.physical))
}

export function runStageLabel(run: DeviceRun): string {
  return {
    stopping: 'Stopping…', preparing: 'Preparing the build…', starting: 'Connecting to the dev server…', running: 'Dev server running',
    building: `Building ${run.profileName}…`, installing: 'Installing…',
    done: run.mode === 'dev' ? 'Opened with the running dev server' : 'Build ready to install',
    failed: run.mode === 'dev' ? 'Dev run failed' : 'Production build failed', cancelled: 'Stopped',
  }[run.stage]
}

/** Whether a build can go on a device: an iOS simulator build cannot go on a phone, nor a phone build on a simulator. */
export function buildRunsOn(build: Pick<DeviceBuild, 'platform' | 'runsOn'>, device: Pick<DeviceSummary, 'platform' | 'physical'>): boolean {
  return build.platform === device.platform && (build.runsOn === 'any' || (build.runsOn === 'device') === device.physical)
}

export interface DeviceRunBranches {
  branches: string[]
  defaultBranch: string
}

/** Read the host's branch names. Prefer main when it exists, else the current branch. */
export async function loadDeviceRunBranches(api: Pick<HostApi, 'gitRefreshState'>, projectPath: string): Promise<DeviceRunBranches> {
  const state = await api.gitRefreshState(projectPath, { includeRefs: true, includeDetails: false })
  const branches = state?.refs?.branches ?? []
  return { branches, defaultBranch: branches.includes('main') ? 'main' : state?.branch ?? branches[0] ?? '' }
}

/** Runs that were going in the previous snapshot and have now ended, so a client can say how they ended. */
export function finishedRuns(previous: readonly DeviceRun[], next: readonly DeviceRun[]): DeviceRun[] {
  const wasActive = new Set(previous.filter(isDeviceRunActive).map((run) => run.runId))
  return next.filter((run) => wasActive.has(run.runId) && (run.stage === 'done' || run.stage === 'failed'))
}
