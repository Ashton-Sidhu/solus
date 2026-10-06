import { LOCAL_DEVICE_HOST_ID, isDeviceRunActive, type DeviceRun, type DeviceRunProfile, type DeviceSummary } from '@solus/contracts/device-types'

/**
 * Build-and-run profiles for the Devices pane (plan 016, S02): which
 * profiles and runs belong to the device on screen. Editing profiles is
 * shared with the mobile app in `@solus/client-core/device-run-profiles`.
 */

/** Profiles that build for this device: its platform, and a simulator or device build to match. */
export function profilesForDevice(profiles: readonly DeviceRunProfile[] | null | undefined, device: DeviceSummary): DeviceRunProfile[] {
  return (profiles ?? []).filter((profile) => profile.platform === device.platform
    && (profile.target === 'any' || (profile.target === 'device') === device.physical))
}

/**
 * The phone the simulator's toolbar can push a build to: one connected to
 * this host on the simulator's platform, with a profile that builds for a
 * device. A phone that cannot take an install keeps its reason, so the
 * button says why it is off.
 */
export function phoneTarget(devices: readonly DeviceSummary[], profiles: readonly DeviceRunProfile[] | null | undefined, simulator: DeviceSummary): { phone: DeviceSummary; profile: DeviceRunProfile } | null {
  if (simulator.physical) return null
  const phones = devices.filter((device) => device.physical && device.platform === simulator.platform && device.deviceHostId === LOCAL_DEVICE_HOST_ID)
  const phone = phones.find((device) => !device.unavailableReason) ?? phones[0]
  const profile = phone ? profilesForDevice(profiles, phone)[0] : undefined
  return phone && profile ? { phone, profile } : null
}

/** The run the toolbar shows for a device: one in progress, or the last one if it did not succeed. */
export function shownRun(runs: readonly DeviceRun[], device: Pick<DeviceSummary, 'deviceHostId' | 'deviceId'>): DeviceRun | null {
  const latest = runs.find((run) => run.deviceHostId === device.deviceHostId && run.deviceId === device.deviceId)
  if (!latest) return null
  return isDeviceRunActive(latest) || latest.stage === 'failed' ? latest : null
}

export function runStageLabel(run: DeviceRun): string {
  return {
    building: `Building ${run.profileName}…`,
    installing: `Installing on ${run.deviceName ?? 'the device'}…`,
    done: run.deviceName ? `Running on ${run.deviceName}` : `Built ${run.profileName}`,
    failed: 'Build and run failed',
    cancelled: 'Cancelled',
  }[run.stage]
}
