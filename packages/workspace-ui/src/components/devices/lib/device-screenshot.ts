import type { DeviceSummary } from '@solus/contracts/device-types'
import { devicesStore } from '../../../contexts/devices/devices.store.svelte'
import { downloadHostFile } from '../../conversation/lib/attachment-download'
import { screenshotFileName } from './device-pane'

export async function saveDeviceScreenshot(serverId: string, device: DeviceSummary): Promise<void> {
  const { deviceHostId, deviceId } = device
  const shot = await devicesStore.screenshot(serverId, { deviceHostId, deviceId })
  const name = screenshotFileName(device, shot.capturedAt)
  await downloadHostFile({ serverId, assetId: shot.assetId, name }, name)
}
