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
  heldGeneration: number | null,
): Promise<DeviceBuild> {
  if (heldGeneration !== null) return api.deviceInstall({ ...target, buildId: build.buildId, controlGeneration: heldGeneration })
  if (control.lease && !(control.lease.holder.kind === 'agent' && control.agentPaused)) {
    throw new Error(`${control.lease.holder.label} is using this device. Try again when it is free.`)
  }
  const granted = await api.deviceControlAcquire(target)
  if (granted.status !== 'granted') throw new Error('Someone else took control of this device first.')
  try {
    return await api.deviceInstall({ ...target, buildId: build.buildId, controlGeneration: granted.lease.generation })
  } finally {
    await api.deviceControlRelease(target).catch(() => {})
  }
}

/** One line about a build: kind, app id, size and age. */
export function buildSummary(build: DeviceBuild, now: number): string {
  const kind = build.platform === 'android' ? 'Android' : build.runsOn === 'device' ? 'iOS device build' : build.runsOn === 'simulator' ? 'iOS simulator build' : 'iOS'
  const megabytes = build.sizeBytes / (1024 * 1024)
  const size = megabytes >= 10 ? `${Math.round(megabytes)} MB` : `${megabytes.toFixed(1)} MB`
  return [kind, build.appId, size, notificationAge(build.createdAt, now)].filter(Boolean).join(' · ')
}

/** Where the build last went, or null before its first install. */
export function lastInstallLabel(build: DeviceBuild, now: number): string | null {
  return build.lastInstall ? `Installed on ${build.lastInstall.deviceName} · ${notificationAge(build.lastInstall.installedAt, now)}` : null
}
