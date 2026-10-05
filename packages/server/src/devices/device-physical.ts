import { z } from 'zod'
import type { DeviceSummary } from '@solus/contracts/device-types'
import type { DeviceCommandRunner } from './device-process'

/**
 * iPhones, iPads and Android phones connected to a device host by cable or
 * Wi-Fi. They take app installs but have no preview: nothing streams their
 * screen. The hub lists simulators and emulators only, so Solus asks
 * `devicectl` and `adb` itself.
 */

const MAX_PHYSICAL_DEVICES = 50

/** devicectl writes JSON only to a file. The script is constant; nothing is interpolated. */
const DEVICECTL_LIST_SCRIPT = 'f=$(mktemp) || exit 1; xcrun devicectl list devices --quiet --json-output "$f" >/dev/null 2>&1; code=$?; cat "$f"; rm -f "$f"; exit $code'

const devicectlDeviceSchema = z.object({
  identifier: z.string().min(1).max(256),
  connectionProperties: z.object({
    pairingState: z.string().optional().catch(undefined),
    tunnelState: z.string().optional().catch(undefined),
  }).catch({}),
  deviceProperties: z.object({
    name: z.string().optional().catch(undefined),
    osVersionNumber: z.string().optional().catch(undefined),
    developerModeStatus: z.string().optional().catch(undefined),
  }).catch({}),
  hardwareProperties: z.object({
    udid: z.string().min(1).max(256).optional().catch(undefined),
    platform: z.string().optional().catch(undefined),
    deviceType: z.string().optional().catch(undefined),
    marketingName: z.string().optional().catch(undefined),
    reality: z.string().optional().catch(undefined),
  }).catch({}),
})

const devicectlListSchema = z.object({
  result: z.object({ devices: z.array(z.unknown()).catch([]) }),
})

/** iPhones and iPads from `devicectl list devices` JSON. Watches, TVs and Macs are left out. */
export function parseDevicectlDevices(stdout: string, deviceHostId: string): DeviceSummary[] {
  let list: z.ZodSafeParseResult<z.infer<typeof devicectlListSchema>>
  try {
    list = devicectlListSchema.safeParse(JSON.parse(stdout))
  } catch {
    return []
  }
  if (!list.success) return []
  const devices: DeviceSummary[] = []
  for (const raw of list.data.result.devices) {
    const parsed = devicectlDeviceSchema.safeParse(raw)
    if (!parsed.success || devices.length >= MAX_PHYSICAL_DEVICES) continue
    const { identifier, connectionProperties: connection, deviceProperties: properties, hardwareProperties: hardware } = parsed.data
    if (hardware.platform !== 'iOS' || hardware.reality === 'virtual') continue
    const isIpad = hardware.deviceType === 'iPad'
    const name = (properties.name ?? hardware.marketingName ?? (isIpad ? 'iPad' : 'iPhone')).slice(0, 200)
    const connected = connection.tunnelState !== 'unavailable'
    const device: DeviceSummary = {
      deviceHostId,
      // agent-device and devicectl both accept the UDID.
      deviceId: hardware.udid ?? identifier,
      platform: 'ios',
      name,
      version: `${isIpad ? 'iPadOS' : 'iOS'} ${properties.osVersionNumber ?? ''}`.trim(),
      booted: connected,
      physical: true,
    }
    const reason = !connected
      ? `${name} is not connected. Connect it with a cable, or put it on the same network as this Mac.`
      : connection.pairingState !== undefined && connection.pairingState !== 'paired'
        ? `${name} does not trust this Mac. Unlock it and tap Trust.`
        : properties.developerModeStatus === 'disabled'
          ? `Turn on Developer Mode on ${name}: Settings → Privacy & Security → Developer Mode.`
          : undefined
    if (reason) device.unavailableReason = reason
    devices.push(device)
  }
  return devices
}

/** Phones and tablets from `adb devices -l`. Emulators come from the hub. */
export function parseAdbDevices(stdout: string, deviceHostId: string): DeviceSummary[] {
  const devices: DeviceSummary[] = []
  for (const line of stdout.split(/\r?\n/).slice(1)) {
    const [serial, state, ...fields] = line.trim().split(/\s+/)
    if (!serial || !state || serial.startsWith('emulator-') || devices.length >= MAX_PHYSICAL_DEVICES) continue
    const model = fields.find((field) => field.startsWith('model:'))?.slice('model:'.length).replaceAll('_', ' ')
    const name = (model || serial).slice(0, 200)
    const device: DeviceSummary = { deviceHostId, deviceId: serial.slice(0, 256), platform: 'android', name, version: 'Android', booted: state === 'device', physical: true }
    if (state === 'unauthorized') device.unavailableReason = `${name} has not allowed USB debugging from this computer. Unlock it and accept the prompt.`
    else if (state !== 'device') device.unavailableReason = `${name} is ${state}. Reconnect it and check that USB debugging is on.`
    devices.push(device)
  }
  return devices
}

/** Connected devices of each available platform. A failed tool lists none. */
export async function discoverPhysicalDevices(run: DeviceCommandRunner, deviceHostId: string, platforms: { ios: boolean; android: boolean }): Promise<DeviceSummary[]> {
  const [ios, android] = await Promise.all([
    platforms.ios ? run('sh', ['-c', DEVICECTL_LIST_SCRIPT], { timeoutMs: 15_000 }) : null,
    platforms.android ? run('adb', ['devices', '-l'], { timeoutMs: 10_000 }) : null,
  ])
  return [
    ...(ios?.code === 0 ? parseDevicectlDevices(ios.stdout, deviceHostId) : []),
    ...(android?.code === 0 ? parseAdbDevices(android.stdout, deviceHostId) : []),
  ]
}
