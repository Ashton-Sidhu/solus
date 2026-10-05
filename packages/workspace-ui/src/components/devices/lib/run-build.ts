import type { DeviceBuild, DeviceSummary } from '@solus/contracts/device-types'
import { devicesStore } from '../../../contexts/devices/devices.store.svelte'
import { deviceViewState } from './device-view-state.svelte'

/**
 * One click from a build to the app running where the person can see it
 * (plan 016, S02). A simulator or emulator opens beside the conversation,
 * booting first if it is stopped; the build installs and opens; the pane
 * shows that device. A connected phone gets the install and the launch, and
 * the person looks at the phone.
 */
export async function runDeviceBuild(
  shell: { openDevices(sessionId?: string, serverId?: string): void },
  serverId: string,
  sessionId: string | null | undefined,
  build: DeviceBuild,
  device: DeviceSummary,
): Promise<DeviceSummary> {
  if (device.physical) {
    await devicesStore.installBuild(serverId, device, build)
    return device
  }
  if (!sessionId) {
    if (!device.booted) throw new Error(`Open a conversation to start ${device.name}.`)
    await devicesStore.installBuild(serverId, device, build)
    return device
  }
  // Opening boots a stopped device; an Android AVD comes back under its serial.
  const preview = await devicesStore.open(serverId, sessionId, device)
  const target = { deviceHostId: preview.deviceHostId, deviceId: preview.deviceId }
  await devicesStore.installBuild(serverId, target, build)
  deviceViewState.select(serverId, sessionId, preview.devicePreviewId)
  deviceViewState.showBuilds(serverId, false)
  shell.openDevices(sessionId, serverId)
  return devicesStore.device(serverId, target) ?? device
}
