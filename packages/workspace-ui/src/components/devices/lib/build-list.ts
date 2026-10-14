import { DEVICE_RUN_TARGET_LABELS, type DeviceBuild, type DeviceRun } from '@solus/contracts/device-types'
import type { ToastSpec } from '../../../lib/toasts'

/**
 * Words for the builds list on Run app: what a build is, where it came from,
 * and how an install or a build ended.
 */

/** What a build runs on, in the words of the Build for picker. */
export function buildTargetLabel(build: Pick<DeviceBuild, 'platform' | 'runsOn'>): string {
  if (build.platform === 'android') return DEVICE_RUN_TARGET_LABELS.android
  return build.runsOn === 'device' ? DEVICE_RUN_TARGET_LABELS['ios-device'] : DEVICE_RUN_TARGET_LABELS['ios-simulator']
}

/** Branch and commit of the production build that made it, or that an agent made it. */
export function buildSourceLabel(build: Pick<DeviceBuild, 'buildId'>, runs: readonly DeviceRun[]): string {
  const run = runs.find((candidate) => candidate.mode === 'device' && candidate.buildId === build.buildId)
  if (!run) return 'Agent build'
  const commit = (run.outputCommit ?? run.commit).slice(0, 7)
  return run.branch ? `${run.branch} @ ${commit}` : commit
}

export function buildSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

export interface InstallResult { deviceName: string; error: string | null }

/** One toast for an install on several devices: how many worked, and why each other one did not. */
export function installSummary(build: Pick<DeviceBuild, 'name'>, results: readonly InstallResult[]): ToastSpec {
  const failed = results.filter((result) => result.error !== null)
  const installed = results.length - failed.length
  const devices = (count: number) => `${count} ${count === 1 ? 'device' : 'devices'}`
  if (!failed.length) {
    return { variant: 'success', message: `Installed ${build.name}`, description: results.length === 1 ? `On ${results[0]!.deviceName}.` : `On ${devices(results.length)}.` }
  }
  return {
    variant: 'error',
    message: installed ? `Installed ${build.name} on ${installed} of ${devices(results.length)}` : `Could not install ${build.name}`,
    description: failed.map((result) => `${result.deviceName}: ${result.error}`).join('\n'),
    duration: 10_000,
  }
}

/**
 * How a build or dev server ended, for a toast that reaches the person
 * wherever they are. A dev run that ends well has already opened the app in
 * front of them, so it needs no toast.
 */
export function runFinishedToast(run: DeviceRun): ToastSpec | null {
  if (run.mode === 'dev') return run.stage === 'failed' ? { variant: 'error', message: 'Dev run failed', description: run.error ?? 'Open Run app to see the log.' } : null
  const target = run.target ? DEVICE_RUN_TARGET_LABELS[run.target] : run.profileName
  if (run.stage === 'done') return { variant: 'success', message: `${target} build ready`, description: 'Open Run app to install it.' }
  return { variant: 'error', message: `${target} build failed`, description: run.error ?? 'Open Run app to see the log.', duration: 10_000 }
}
