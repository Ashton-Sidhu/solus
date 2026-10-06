import type { DirectoryEntry } from '@solus/contracts/types'
import { deviceBuildFits, type DeviceBuild, type DeviceControlState, type DeviceState, type DeviceSummary, type DeviceTarget } from '@solus/contracts/device-types'
import { notificationAge } from './notifications/presentation'
import type { HostApi } from './host-api'

/**
 * Installing an app build from a client (plan 016, S02). Shared by the
 * workspace and the native mobile app so both follow the same control rule:
 * an install never takes a device from an agent that is using it.
 */

/**
 * Devices this build can run on, best first: a connected phone, then a running
 * simulator or emulator, then a stopped one. A stopped one counts only when
 * the client can boot it (`canBoot`): booting opens it beside a conversation.
 */
export function deviceBuildTargets(state: DeviceState | undefined, build: DeviceBuild, options: { canBoot?: boolean } = {}): DeviceSummary[] {
  if (!state) return []
  const rank = (device: DeviceSummary) => (device.physical ? 0 : device.booted ? 1 : 2)
  return state.devices
    .filter((device) => deviceBuildFits(build, device).fits
      || (options.canBoot === true && !device.physical && !device.booted && deviceBuildFits(build, { ...device, booted: true }).fits))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** A build output a folder browser offers: an iOS `.app` bundle (a folder) or an Android `.apk` file. */
export function isBuildOutput(entry: Pick<DirectoryEntry, 'name' | 'isDir'>): boolean {
  return entry.isDir ? entry.name.endsWith('.app') : entry.name.endsWith('.apk')
}

/** Builds an Android phone can download and install itself. */
export function downloadableBuilds(state: DeviceState | undefined): DeviceBuild[] {
  return (state?.builds ?? []).filter((build) => build.assetId !== null)
}

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
  if (control.lease?.holder.kind === 'agent' && !control.agentPaused) {
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
 * What a build's menu says about it, as label and value rows. The name, kind
 * and age are on the build's row already, so they are left out. A project
 * and a conversation are listed only when the client knows them.
 */
export function buildDetails(
  build: DeviceBuild,
  now: number,
  origin: { projectPath?: string | null; conversationTitle?: string | null } = {},
): { label: string; value: string }[] {
  const megabytes = build.sizeBytes / (1024 * 1024)
  const size = megabytes >= 10 ? `${Math.round(megabytes)} MB` : `${megabytes.toFixed(1)} MB`
  const rows = [{ label: 'App ID', value: build.appId ?? 'Unknown' }, { label: 'Size', value: size }]
  const project = origin.projectPath?.split(/[\\/]/).filter(Boolean).at(-1)
  if (project) rows.push({ label: 'Project', value: project })
  if (origin.conversationTitle) rows.push({ label: 'Conversation', value: origin.conversationTitle })
  if (build.lastInstall) rows.push({ label: 'Installed', value: `${build.lastInstall.deviceName} · ${notificationAge(build.lastInstall.installedAt, now)}` })
  return rows
}

/** The short line under a build's name: what it runs on and how old it is. */
export function buildCardSummary(build: DeviceBuild, now: number): string {
  const kind = build.platform === 'android' ? 'Android' : build.runsOn === 'device' ? 'iPhone or iPad' : build.runsOn === 'simulator' ? 'iOS Simulator' : 'iOS'
  return `${kind} · ${notificationAge(build.createdAt, now)}`
}

/** Builds the device on screen can run, newest first: what its Run button offers. */
export function buildsForDevice(state: DeviceState | undefined, device: DeviceSummary): DeviceBuild[] {
  // A device on screen is running; a stopped one boots when its build runs.
  return (state?.builds ?? []).filter((build) => deviceBuildFits(build, { ...device, booted: true }).fits)
}
