import { z } from 'zod'
import {
  deviceSupportsAction,
  DEVICE_COLOR_FILTERS,
  DEVICE_TEXT_SIZES,
  type DeviceAction,
  type DeviceForegroundApp,
  type DeviceOrientation,
  type DevicePermission,
  type DevicePlatform,
  type DeviceSettings,
  type DeviceTextSize,
} from '@solus/contracts/device-types'
import { DeviceDomainError } from './device-errors'
import type { DeviceHostReady } from './device-host'
import { boundedDetail, type DeviceCommandResult } from './device-process'

/**
 * Device settings and one-shot actions, run on the device host with typed
 * commands instead of serve-sim's shell-exec channel, which would hand any
 * client arbitrary command execution. Ported from T3 Code (MIT,
 * pingdotgg/t3code@43bd667, apps/server/src/device/DeviceActions.ts).
 *
 * Unsupported actions fail before any process runs (deviceSupportsAction).
 */

type Ready = Pick<DeviceHostReady, 'run' | 'helpers' | 'nodePath'>

const IOS_TEXT_SIZES = {
  small: 'small',
  default: 'large',
  large: 'extra-extra-large',
  'extra-large': 'accessibility-large',
} as const satisfies Record<DeviceTextSize, string>

const ANDROID_TEXT_SIZES = {
  small: '0.85',
  default: '1.0',
  large: '1.15',
  'extra-large': '1.3',
} as const satisfies Record<DeviceTextSize, string>

export function textSizeFromIos(category: string): DeviceTextSize {
  const exact = DEVICE_TEXT_SIZES.find((size) => IOS_TEXT_SIZES[size] === category)
  if (exact) return exact
  if (category.startsWith('accessibility')) return 'extra-large'
  if (category.includes('extra')) return 'large'
  return category === 'extra-small' || category === 'small' || category === 'medium' ? 'small' : 'default'
}

export function textSizeFromAndroid(scale: number): DeviceTextSize {
  if (scale <= 0.9) return 'small'
  if (scale >= 1.25) return 'extra-large'
  if (scale >= 1.1) return 'large'
  return 'default'
}

const IOS_TOGGLE_OPTIONS = {
  reduceMotion: 'reduce-motion',
  reduceTransparency: 'reduce-transparency',
  showBorders: 'show-borders',
  voiceOver: 'voiceover',
} as const

const IOS_TCC_SERVICES = new Map<DevicePermission, string>([
  ['camera', 'camera'], ['microphone', 'microphone'], ['photos', 'photos'], ['contacts', 'contacts'], ['calendar', 'calendar'],
  ['reminders', 'reminders'], ['motion', 'motion'], ['media-library', 'media-library'], ['faceid', 'faceid'], ['location', 'location'],
])

const ANDROID_PERMISSIONS = new Map<DevicePermission, readonly string[]>([
  ['camera', ['android.permission.CAMERA']],
  ['microphone', ['android.permission.RECORD_AUDIO']],
  ['photos', ['android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_EXTERNAL_STORAGE']],
  ['contacts', ['android.permission.READ_CONTACTS', 'android.permission.WRITE_CONTACTS']],
  ['calendar', ['android.permission.READ_CALENDAR', 'android.permission.WRITE_CALENDAR']],
  ['location', ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION']],
  ['notifications', ['android.permission.POST_NOTIFICATIONS']],
  ['motion', ['android.permission.ACTIVITY_RECOGNITION']],
])

// Gravity vector that makes the emulator report each orientation, and the
// window-manager rotation index for physical devices.
const ANDROID_GRAVITY = {
  portrait: '0:9.81:0', landscape_left: '9.81:0:0', portrait_upside_down: '0:-9.81:0', landscape_right: '-9.81:0:0',
} as const satisfies Record<DeviceOrientation, string>
const ANDROID_ROTATION = {
  portrait: '0', landscape_left: '1', portrait_upside_down: '2', landscape_right: '3',
} as const satisfies Record<DeviceOrientation, string>

function ok(operation: string, result: DeviceCommandResult): string {
  if (result.code === 0) return result.stdout
  throw new DeviceDomainError('command_failed', `Device ${operation} failed (exit code ${result.code}). ${boundedDetail(result.stderr)}`.trim())
}

function unsupported(action: DeviceAction, platform: DevicePlatform): DeviceDomainError {
  return new DeviceDomainError('action_unsupported', `${action.type} is not supported on ${platform === 'ios' ? 'iOS' : 'Android'}.`)
}

/** Any JSON object; arrays and scalars are refused. */
const pushObjectSchema = z.looseObject({})

/** Encode a push payload. Plain text becomes an alert body; JSON must be an object. */
export function pushPayloadJson(payload: Extract<DeviceAction, { type: 'sendPush' }>['payload']): string {
  if (payload.kind === 'text') return JSON.stringify({ aps: { alert: payload.body } })
  let parsed: z.ZodSafeParseResult<z.infer<typeof pushObjectSchema>>
  try {
    parsed = pushObjectSchema.safeParse(JSON.parse(payload.json))
  } catch {
    throw new DeviceDomainError('invalid_request', 'The push payload is not valid JSON.')
  }
  if (!parsed.success) throw new DeviceDomainError('invalid_request', 'The push payload must be a JSON object such as {"aps":{"alert":"Hi"}}.')
  return JSON.stringify(parsed.data)
}

export async function runDeviceAction(ready: Ready, platform: DevicePlatform, deviceId: string, action: DeviceAction): Promise<void> {
  if (!deviceSupportsAction(platform, action)) throw unsupported(action, platform)
  if (platform === 'ios') await runIos(ready, deviceId, action)
  else await runAndroid(ready, deviceId, action)
}

const simctl = async (ready: Ready, udid: string, args: readonly string[], operation: string, stdin?: string) =>
  ok(operation, await ready.run('xcrun', ['simctl', args[0] ?? '', udid, ...args.slice(1)], stdin === undefined ? {} : { stdin }))

async function axSettings(ready: Ready, udid: string, args: readonly string[]): Promise<string> {
  const helper = ready.helpers.serveSimAxSettings
  if (!helper) throw new DeviceDomainError('helper_missing', 'This accessibility setting needs a helper missing from this install. Set up device support again.')
  return ok('accessibility', await ready.run('xcrun', ['simctl', 'spawn', udid, helper, ...args]))
}

/** The `simctl` arguments for an iOS action that is one plain command, or null. */
function iosSimctlArgs(action: DeviceAction): { args: string[]; operation: string } | null {
  switch (action.type) {
    case 'setAppearance': return { args: ['ui', 'appearance', action.value], operation: 'appearance' }
    case 'setTextSize': return { args: ['ui', 'content_size', IOS_TEXT_SIZES[action.value]], operation: 'text size' }
    case 'setLocation': return { args: ['location', 'set', `${action.latitude},${action.longitude}`], operation: 'location' }
    case 'clearLocation': return { args: ['location', 'clear'], operation: 'location' }
    case 'openUrl': return { args: ['openurl', action.url], operation: 'open url' }
    case 'launchApp': return { args: ['launch', action.appId], operation: 'launch' }
    case 'terminateApp': return { args: ['terminate', action.appId], operation: 'terminate' }
    default: return null
  }
}

async function runIos(ready: Ready, udid: string, action: DeviceAction): Promise<void> {
  const plain = iosSimctlArgs(action)
  if (plain) {
    await simctl(ready, udid, plain.args, plain.operation)
    return
  }
  switch (action.type) {
    case 'setToggle':
      if (action.setting === 'increaseContrast') {
        await simctl(ready, udid, ['ui', 'increase_contrast', action.value ? 'enabled' : 'disabled'], 'increase contrast')
        return
      }
      if (action.setting === 'networkEnabled') throw unsupported(action, 'ios')
      await axSettings(ready, udid, ['set', IOS_TOGGLE_OPTIONS[action.setting], action.value ? 'on' : 'off'])
      return
    case 'setLiquidGlass':
      await axSettings(ready, udid, ['set', 'liquid-glass', action.value])
      return
    case 'setColorFilter':
      await axSettings(ready, udid, ['set', 'color-filter', action.value])
      return
    case 'setPermission':
      await iosPermission(ready, udid, action)
      return
    case 'sendPush':
      // The payload is data on stdin, never an argument or shell text.
      await simctl(ready, udid, ['push', action.appId, '-'], 'push', pushPayloadJson(action.payload))
      return
    default:
      throw unsupported(action, 'ios')
  }
}

async function iosPermission(ready: Ready, udid: string, action: Extract<DeviceAction, { type: 'setPermission' }>): Promise<void> {
  if (action.permission === 'notifications') {
    // simctl has no notification permission verb; serve-sim's CLI edits it.
    const cli = ready.helpers.serveSimCli
    if (!cli) throw new DeviceDomainError('helper_missing', 'Notification permissions need a helper missing from this install.')
    ok('permission', await ready.run(ready.nodePath, [cli, 'permissions', action.decision, action.permission, action.appId, '-d', udid]))
    return
  }
  const service = IOS_TCC_SERVICES.get(action.permission)
  if (!service) throw unsupported(action, 'ios')
  await simctl(ready, udid, ['privacy', action.decision, service, action.appId], 'permission')
}

/** The `adb shell` arguments for an Android action that is one plain command, or null. */
function androidShellArgs(action: DeviceAction): { args: string[]; operation: string } | null {
  switch (action.type) {
    case 'setAppearance': return { args: ['cmd', 'uimode', 'night', action.value === 'dark' ? 'yes' : 'no'], operation: 'appearance' }
    case 'setTextSize': return { args: ['settings', 'put', 'system', 'font_scale', ANDROID_TEXT_SIZES[action.value]], operation: 'text size' }
    case 'openUrl': return { args: ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', action.url], operation: 'open url' }
    case 'launchApp': return { args: ['monkey', '-p', action.appId, '-c', 'android.intent.category.LAUNCHER', '1'], operation: 'launch' }
    case 'terminateApp': return { args: ['am', 'force-stop', action.appId], operation: 'terminate' }
    default: return null
  }
}

async function runAndroid(ready: Ready, serial: string, action: DeviceAction): Promise<void> {
  const adb = async (args: readonly string[], operation: string) => ok(operation, await ready.run('adb', ['-s', serial, ...args]))
  const plain = androidShellArgs(action)
  if (plain) {
    await adb(['shell', ...plain.args], plain.operation)
    return
  }
  switch (action.type) {
    case 'setToggle':
      await androidToggle(adb, action)
      return
    case 'setOrientation':
      // Tilting an emulator's accelerometer rotates the captured display;
      // `user-rotation lock` alone only rotates window content on recent images.
      if (serial.startsWith('emulator-')) {
        await adb(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '1'], 'orientation')
        await adb(['shell', 'cmd', 'window', 'user-rotation', 'free'], 'orientation')
        await adb(['emu', 'sensor', 'set', 'acceleration', ANDROID_GRAVITY[action.value]], 'orientation')
        return
      }
      await adb(['shell', 'cmd', 'window', 'user-rotation', 'lock', ANDROID_ROTATION[action.value]], 'orientation')
      return
    case 'setLocation':
      await adb(['emu', 'geo', 'fix', String(action.longitude), String(action.latitude)], 'location')
      return
    case 'setPermission':
      await androidPermission(ready, serial, action)
      return
    default:
      throw unsupported(action, 'android')
  }
}

async function androidToggle(adb: (args: readonly string[], operation: string) => Promise<string>, action: Extract<DeviceAction, { type: 'setToggle' }>): Promise<void> {
  if (action.setting === 'networkEnabled') {
    const state = action.value ? 'enable' : 'disable'
    await adb(['shell', 'svc', 'wifi', state], 'network')
    await adb(['shell', 'svc', 'data', state], 'network')
    return
  }
  if (action.setting === 'reduceMotion') {
    for (const key of ['animator_duration_scale', 'transition_animation_scale', 'window_animation_scale']) {
      await adb(['shell', 'settings', 'put', 'global', key, action.value ? '0' : '1'], 'reduce motion')
    }
    return
  }
  throw unsupported(action, 'android')
}

async function androidPermission(ready: Ready, serial: string, action: Extract<DeviceAction, { type: 'setPermission' }>): Promise<void> {
  const permissions = ANDROID_PERMISSIONS.get(action.permission)
  if (!permissions) throw unsupported(action, 'android')
  const verb = action.decision === 'grant' ? 'grant' : 'revoke'
  const changed: string[] = []
  const failed: string[] = []
  for (const permission of permissions) {
    // An app need not declare every permission in a group.
    const result = await ready.run('adb', ['-s', serial, 'shell', 'pm', verb, action.appId, permission])
    if (result.code === 0) changed.push(permission)
    else failed.push(permission)
  }
  if (changed.length === 0) {
    throw new DeviceDomainError('command_failed', `${action.appId} does not declare any ${action.permission} permission.`)
  }
  if (failed.length > 0) {
    throw new DeviceDomainError('command_failed', `Changed ${changed.length} of ${permissions.length} ${action.permission} permissions; ${action.appId} does not declare ${failed.join(', ')}.`)
  }
}

// ─── Read back ───

export interface DeviceReadback {
  settings: DeviceSettings
  foregroundApp: DeviceForegroundApp | null
}

export async function readDeviceDetail(ready: Ready, platform: DevicePlatform, deviceId: string): Promise<DeviceReadback> {
  return platform === 'ios' ? readIos(ready, deviceId) : readAndroid(ready, deviceId)
}

const quiet = async <A>(work: () => Promise<A>): Promise<A | undefined> => {
  try {
    return await work()
  } catch {
    return undefined
  }
}

const onOffSchema = z.enum(['on', 'off']).transform((value) => value === 'on').optional().catch(undefined)

/** serve-sim-ax-settings `status`: string values per setting. Unknown or unread stays undefined. */
const axStatusSchema = z.object({
  'reduce-motion': onOffSchema,
  'reduce-transparency': onOffSchema,
  'show-borders': onOffSchema,
  voiceover: onOffSchema,
  'liquid-glass': z.enum(['clear', 'tinted']).optional().catch(undefined),
  'color-filter': z.enum(DEVICE_COLOR_FILTERS).optional().catch(undefined),
})
export type AxStatus = z.infer<typeof axStatusSchema>

export function parseAxStatus(text: string): AxStatus | null {
  try {
    const parsed = axStatusSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function applyAxStatus(settings: DeviceSettings, ax: AxStatus): void {
  if (ax['reduce-motion'] !== undefined) settings.reduceMotion = ax['reduce-motion']
  if (ax['reduce-transparency'] !== undefined) settings.reduceTransparency = ax['reduce-transparency']
  if (ax['show-borders'] !== undefined) settings.showBorders = ax['show-borders']
  if (ax.voiceover !== undefined) settings.voiceOver = ax.voiceover
  if (ax['liquid-glass']) settings.liquidGlass = ax['liquid-glass']
  if (ax['color-filter']) settings.colorFilter = ax['color-filter']
}

async function readIos(ready: Ready, udid: string): Promise<DeviceReadback> {
  const uiValue = (option: string) => quiet(async () => (await simctl(ready, udid, ['ui', option], option)).trim().toLowerCase())
  const [appearance, contentSize, contrast, ax, foreground] = await Promise.all([
    uiValue('appearance'),
    uiValue('content_size'),
    uiValue('increase_contrast'),
    quiet(async () => parseAxStatus(await axSettings(ready, udid, ['status']))),
    quiet(async () => readIosForeground(ready, udid)),
  ])
  const settings: DeviceSettings = {}
  if (appearance === 'light' || appearance === 'dark') settings.appearance = appearance
  if (contentSize) settings.textSize = textSizeFromIos(contentSize)
  if (contrast === 'enabled' || contrast === 'disabled') settings.increaseContrast = contrast === 'enabled'
  if (ax) applyAxStatus(settings, ax)
  return { settings, foregroundApp: foreground ?? null }
}

/** The frontmost app from `launchctl list` in the simulator: UIKitApplication entries with a PID. */
async function readIosForeground(ready: Ready, udid: string): Promise<DeviceForegroundApp | null> {
  const result = await ready.run('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list'], { timeoutMs: 5_000 })
  if (result.code !== 0) return null
  const running = result.stdout.split('\n')
    .map((line) => /^(\d+)\s+\S+\s+UIKitApplication:([^[\s]+)/.exec(line.trim())?.[2])
    .filter((appId): appId is string => appId !== undefined && !appId.startsWith('com.apple.'))
  const [only] = running
  return running.length === 1 && only ? { appId: only } : null
}

async function readAndroid(ready: Ready, serial: string): Promise<DeviceReadback> {
  const shell = (args: readonly string[]) =>
    quiet(async () => ok(args[0] ?? 'shell', await ready.run('adb', ['-s', serial, 'shell', ...args])).trim())
  const [night, fontScale, animator, wifi, focus] = await Promise.all([
    shell(['cmd', 'uimode', 'night']),
    shell(['settings', 'get', 'system', 'font_scale']),
    shell(['settings', 'get', 'global', 'animator_duration_scale']),
    shell(['settings', 'get', 'global', 'wifi_on']),
    // `dumpsys window windows` stopped printing the focus on API 36; the full dump still does.
    shell(['dumpsys', 'window']),
  ])
  const settings: DeviceSettings = {}
  if (night?.includes('yes')) settings.appearance = 'dark'
  else if (night?.includes('no')) settings.appearance = 'light'
  const scale = fontScale && fontScale !== 'null' ? Number(fontScale) : Number.NaN
  if (Number.isFinite(scale)) settings.textSize = textSizeFromAndroid(scale)
  if (animator !== undefined && animator !== 'null' && animator !== '') settings.reduceMotion = Number(animator) === 0
  if (wifi === '1' || wifi === '0') settings.networkEnabled = wifi === '1'
  const focused = focus?.match(/m(?:CurrentFocus|FocusedApp)=\w+\{[^ ]+ u\d+ ([^/ ]+)\//)?.[1]
  return { settings, foregroundApp: focused ? { appId: focused } : null }
}
