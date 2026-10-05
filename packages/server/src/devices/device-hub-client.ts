import { z } from 'zod'
import type { DevicePlatform, DeviceSummary } from '@solus/contracts/device-types'
import { boundedDetail } from './device-process'
import { DeviceDomainError } from './device-errors'

/**
 * The few hub JSON routes Solus calls itself. Only the host reaches the hub;
 * clients never receive its origin (docs/plans/native-devices.md, D2).
 */

const BOOT_TIMEOUT_MS = 3 * 60_000
const REQUEST_TIMEOUT_MS = 15_000
const SCREENSHOT_TIMEOUT_MS = 20_000
const MAX_DEVICES_PER_HOST = 200
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024

/** How the hub tags a discovery error with the platform it came from. */
const HUB_ERROR_PREFIX = { ios: '[apple-utils]', android: '[android-utils]' } as const satisfies Record<DevicePlatform, string>

export const vendorPrefix = (platform: DevicePlatform) => (platform === 'ios' ? '/vendor/serve-sim' : '/vendor/serve-emu')

const hubDeviceSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string(),
  version: z.string(),
  platform: z.enum(['ios', 'android']),
  booted: z.boolean(),
  physical: z.boolean(),
})

/** Unreadable entries are dropped one by one; one bad device does not hide the rest. */
const hubDeviceListSchema = z.object({
  simulators: z.array(z.unknown()).catch([]),
  emulators: z.array(z.unknown()).catch([]),
  errors: z.array(z.object({ message: z.string() }).catch({ message: '' })).catch([]),
})

const hubActionSchema = z.object({
  ok: z.boolean().catch(false),
  id: z.string().optional().catch(undefined),
  serial: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
})
type HubActionResult = z.infer<typeof hubActionSchema>

export type HubBootResult = { ok: true; deviceId: string } | { ok: false; reason: 'disk_space' | 'timeout' | 'launch_failed' }

export class DeviceHubClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async text(url: string, init: RequestInit, operation: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<string> {
    let response: Response
    try {
      response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (cause) {
      throw new DeviceDomainError('request_failed', `Could not reach device support during ${operation}. Try again.`, cause)
    }
    const body = await response.text().catch(() => '')
    if (!response.ok) throw new DeviceDomainError('request_failed', `Device support refused ${operation} (HTTP ${response.status}).`)
    return body
  }

  private async parsed<T>(schema: z.ZodType<T>, url: string, init: RequestInit, operation: string, timeoutMs?: number): Promise<T> {
    const body = await this.text(url, init, operation, timeoutMs)
    let result: z.ZodSafeParseResult<T>
    try {
      result = schema.safeParse(JSON.parse(body))
    } catch (cause) {
      throw new DeviceDomainError('request_failed', `Device support returned an unreadable reply to ${operation}.`, cause)
    }
    if (!result.success) throw new DeviceDomainError('request_failed', `Device support returned an unexpected reply to ${operation}.`)
    return result.data
  }

  private post(origin: string, path: string, body: { [field: string]: string }, operation: string, timeoutMs?: number): Promise<HubActionResult> {
    return this.parsed(hubActionSchema, `${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, operation, timeoutMs)
  }

  /**
   * Simulators and emulators, plus the first line of each discovery error.
   * Errors from a platform in `unavailable` are dropped: the platform's own
   * reason already says what is missing, so the hub's raw failure is noise.
   */
  async listDevices(origin: string, deviceHostId: string, unavailable: readonly DevicePlatform[] = []): Promise<{ devices: DeviceSummary[]; detail?: string }> {
    const list = await this.parsed(hubDeviceListSchema, `${origin}/api/devices`, {}, 'listing devices')
    const devices: DeviceSummary[] = []
    for (const raw of [...list.simulators, ...list.emulators]) {
      const device = hubDeviceSchema.safeParse(raw)
      if (!device.success || devices.length >= MAX_DEVICES_PER_HOST) continue
      devices.push({
        deviceHostId,
        deviceId: device.data.id,
        platform: device.data.platform,
        name: device.data.name.slice(0, 200),
        version: device.data.version.slice(0, 80),
        booted: device.data.booted,
        physical: device.data.physical,
      })
    }
    // Hub errors carry stack traces and host paths; only first lines travel on.
    const detail = list.errors
      .filter((entry) => !unavailable.some((platform) => entry.message.startsWith(HUB_ERROR_PREFIX[platform])))
      .map((entry) => boundedDetail(entry.message, 160)).filter(Boolean).slice(0, 4).join('\n')
    if (!detail) return { devices }
    return { devices, detail }
  }

  /** Boot through the hub so its list and its streaming helper both see the device. */
  async boot(origin: string, device: DeviceSummary): Promise<HubBootResult> {
    const result = await this.post(origin, '/api/devices/boot', {
      platform: device.platform,
      id: device.deviceId,
      name: device.name,
    }, 'boot', BOOT_TIMEOUT_MS)
    if (!result.ok) {
      const error = result.error ?? ''
      if (/insufficient.*(?:disk|space)|not enough.*(?:disk|space)|no space left/i.test(error)) return { ok: false, reason: 'disk_space' }
      if (/timed? out|timeout/i.test(error)) return { ok: false, reason: 'timeout' }
      return { ok: false, reason: 'launch_failed' }
    }
    if (device.platform === 'ios') await this.attachIos(origin, device.deviceId)
    // Android AVDs change id when they boot (AVD name to emulator serial).
    return { ok: true, deviceId: result.serial ?? result.id ?? device.deviceId }
  }

  /** Booting alone does not attach serve-sim's capture helper; this does, idempotently. */
  async attachIos(origin: string, udid: string): Promise<void> {
    const result = await this.post(origin, `${vendorPrefix('ios')}/grid/api/start`, { udid }, 'attaching the stream', BOOT_TIMEOUT_MS)
    if (!result.ok) throw new DeviceDomainError('boot_failed', 'The simulator is running but its stream helper could not attach.')
  }

  async shutdown(origin: string, platform: DevicePlatform, deviceId: string): Promise<boolean> {
    const result = platform === 'ios'
      ? await this.post(origin, `${vendorPrefix('ios')}/grid/api/shutdown`, { udid: deviceId }, 'shutdown')
      : await this.post(origin, '/api/devices/shutdown', { platform, id: deviceId }, 'shutdown')
    return result.ok
  }

  async screenshot(origin: string, platform: DevicePlatform, deviceId: string): Promise<Uint8Array> {
    const url = `${origin}${vendorPrefix(platform)}/api/screenshot?device=${encodeURIComponent(deviceId)}`
    let response: Response
    try {
      response = await this.fetchImpl(url, { method: 'POST', signal: AbortSignal.timeout(SCREENSHOT_TIMEOUT_MS) })
    } catch (cause) {
      throw new DeviceDomainError('request_failed', 'The screenshot did not finish. Try again.', cause)
    }
    if (!response.ok) throw new DeviceDomainError('request_failed', `The device refused the screenshot (HTTP ${response.status}).`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_SCREENSHOT_BYTES) throw new DeviceDomainError('request_failed', 'The screenshot is too large.')
    return bytes
  }
}

export interface PngSize {
  width: number
  height: number
}

/** Width and height from a PNG's IHDR chunk; anything else reports 0×0. */
export function pngDimensions(png: Uint8Array): PngSize {
  if (png.length < 24) return { width: 0, height: 0 }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const isPng = view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a && view.getUint32(12) === 0x49484452
  return isPng ? { width: view.getUint32(16), height: view.getUint32(20) } : { width: 0, height: 0 }
}

/** `simctl list devices available --json`: devices grouped by runtime identifier. */
const simctlDevicesSchema = z.object({
  devices: z.record(z.string(), z.array(z.object({
    udid: z.string().min(1).max(256),
    name: z.string(),
    state: z.string(),
    isAvailable: z.boolean().optional().catch(undefined),
  }).catch({ udid: '', name: '', state: '' }))),
})

/** Available iOS simulators from simctl, named the way the hub names them. */
export function parseSimctlDevices(stdout: string, deviceHostId: string): DeviceSummary[] {
  let parsed: z.ZodSafeParseResult<z.infer<typeof simctlDevicesSchema>>
  try {
    parsed = simctlDevicesSchema.safeParse(JSON.parse(stdout))
  } catch {
    return []
  }
  if (!parsed.success) return []
  const devices: DeviceSummary[] = []
  for (const [runtime, entries] of Object.entries(parsed.data.devices)) {
    const match = /SimRuntime\.iOS-(\d+)-(\d+)/.exec(runtime)
    if (!match) continue
    for (const entry of entries) {
      if (!entry.udid || entry.isAvailable === false || devices.length >= MAX_DEVICES_PER_HOST) continue
      devices.push({
        deviceHostId,
        deviceId: entry.udid,
        platform: 'ios',
        name: entry.name.slice(0, 200),
        version: `iOS ${match[1]}.${match[2]}`,
        booted: entry.state.toLowerCase() === 'booted',
        physical: false,
      })
    }
  }
  return devices
}
