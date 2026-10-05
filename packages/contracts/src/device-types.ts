import { z } from 'zod'

/**
 * Native device previews: iOS Simulators and Android Emulators on a Solus host
 * or on an SSH device host that the Solus host reaches
 * (docs/plans/native-devices.md, plans/016-device-preview-parity.md).
 *
 * Identity: `serverId` is the Solus host connection (client side only);
 * `deviceHostId` is `local` or a configured SSH device host on that Solus
 * host; `deviceId` is a simulator UDID, an emulator serial, or an AVD name
 * while it is not running. A device id is unique only inside its device host.
 */

export const LOCAL_DEVICE_HOST_ID = 'local'
export const DEVICE_HUB_VERSION = '0.12.0'
export const AGENT_DEVICE_VERSION = '0.21.12'

export const DEVICE_PLATFORMS = ['ios', 'android'] as const
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number]

const deviceHostIdSchema = z.string().trim().min(1).max(128)
const deviceIdSchema = z.string().trim().min(1).max(256)

export const sshDeviceHostConfigSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).refine((id) => id !== LOCAL_DEVICE_HOST_ID, {
    message: 'The local device host id is reserved.',
  }),
  label: z.string().trim().min(1).max(80),
  /** An SSH alias or `user@host`. Never starts with `-`: it is an argument, not an option. */
  target: z.string().trim().min(1).max(255).regex(/^[^\s-][^\s]*$/),
  identityFile: z.string().trim().min(1).max(1024).optional(),
  port: z.number().int().min(1).max(65535).optional(),
})
export type SshDeviceHostConfig = z.infer<typeof sshDeviceHostConfigSchema>
/** A host config before validation, as a form builds it. */
export type SshDeviceHostConfigInput = z.input<typeof sshDeviceHostConfigSchema>

export const sshDeviceHostConfigsSchema = z.array(sshDeviceHostConfigSchema).max(16).refine(
  (hosts) => new Set(hosts.map((host) => host.id)).size === hosts.length,
  { message: 'Device host ids must be unique.' },
)

/** Host settings that own the device feature. Secrets are never in here. */
export interface DeviceSettingsState {
  /** Device support (the hub) is on. Off stops owned helpers, never devices. */
  enabled: boolean
  /** Agents may drive devices through the bound CLI. Off leaves manual viewing. */
  agentAccessEnabled: boolean
  onboardingCompleted: boolean
  /** Reveal an agent-opened device beside its conversation. */
  autoShowAgentDevices: boolean
  sshHosts: SshDeviceHostConfig[]
}

export interface DeviceSummary {
  deviceHostId: string
  deviceId: string
  platform: DevicePlatform
  name: string
  /** OS label such as "iOS 18.0" or "Android 15.0". */
  version: string
  booted: boolean
  physical: boolean
  /** Why a physical device cannot take an install now: locked, not trusted,
   *  Developer Mode off. Absent when it can. */
  unavailableReason?: string
}

export interface DevicePlatformAvailability {
  platform: DevicePlatform
  available: boolean
  reason?: string
}

export interface DeviceToolVersion {
  requiredVersion: string
  installedVersions: string[]
  runningVersion: string | null
}

export interface DeviceToolVersions {
  hub: DeviceToolVersion
  agent: DeviceToolVersion
}

export interface DeviceHostSummary {
  deviceHostId: string
  kind: 'local' | 'ssh'
  label: string
  platforms: DevicePlatformAvailability[]
  tools?: DeviceToolVersions
  toolInspectionError?: string
  hubInstalled: boolean
  agentDeviceInstalled: boolean
}

export type DeviceHostStatus = 'disabled' | 'idle' | 'installing' | 'starting' | 'ready' | 'failed'

export interface DeviceHostStatusEntry {
  deviceHostId: string
  status: DeviceHostStatus
  detail?: string
}

/** A session looking at a device. One per (session, device host, device). The
 *  stream is the whole simulator screen: other sessions can show it too. */
export interface DevicePreview {
  devicePreviewId: string
  sessionId: string
  deviceHostId: string
  deviceId: string
  platform: DevicePlatform
  openedAt: number
  openedBy: 'user' | 'agent'
}

export interface DeviceBooting {
  deviceHostId: string
  deviceId: string
  sessionId: string
}

/** Who may mutate a device through Solus right now (plan 016, S01). */
export type DeviceControlHolder =
  | { kind: 'user'; clientId: string; userId?: string; label: string }
  | { kind: 'agent'; sessionId: string; label: string }

export interface DeviceControlLease {
  deviceHostId: string
  deviceId: string
  holder: DeviceControlHolder
  /** Increases on every grant. A command naming an older generation is refused. */
  generation: number
  expiresAt: number
}

/** Control of one device: the lease, if any, and whether agent actions are paused. */
export interface DeviceControlState {
  deviceHostId: string
  deviceId: string
  lease: DeviceControlLease | null
  /** Agent device actions stay paused until someone resumes them. */
  agentPaused: boolean
  /** A takeover is waiting for an in-flight agent mutation to finish. */
  pendingTakeover?: { clientId: string; label: string }
}

/** The revisioned device snapshot every authorized client renders from. */
export interface DeviceState {
  revision: number
  settings: Omit<DeviceSettingsState, 'sshHosts'>
  hosts: DeviceHostSummary[]
  hostStatuses: DeviceHostStatusEntry[]
  devices: DeviceSummary[]
  previews: DevicePreview[]
  booting: DeviceBooting[]
  controls: DeviceControlState[]
  /** Recent app builds an agent handed to Solus, newest first. */
  builds: DeviceBuild[]
}

/**
 * An app build that can be installed on a device. iOS builds refer to the
 * build output on the host; a newer build at the same path replaces the entry.
 * An APK is copied into the host's assets, so a phone can download it.
 */
export interface DeviceBuild {
  buildId: string
  platform: DevicePlatform
  /** Which iOS devices the build runs on. Android builds run on both. */
  runsOn: 'simulator' | 'device' | 'any'
  /** Bundle id or package name; null when it could not be read. */
  appId: string | null
  /** File name of the build, e.g. `MyApp.app`. */
  name: string
  sessionId: string
  sizeBytes: number
  createdAt: number
  /** The stored APK, downloadable through `assetCreateUrl`. Null for iOS. */
  assetId: string | null
  lastInstall: { deviceHostId: string; deviceId: string; deviceName: string; installedAt: number } | null
}

/** What the conversation keeps about a build. The card reads the live build
 *  from the device state by id; this is what it shows when that build is gone. */
export interface DeviceBuildRef {
  buildId: string
  name: string
  platform: DevicePlatform
  appId: string | null
  /** The device the agent installed it on in the same call, if any. */
  installedOn: string | null
}

/** Can this build go on this device? Answers with the reason it cannot. */
export function deviceBuildFits(build: DeviceBuild, device: DeviceSummary): { fits: true } | { fits: false; reason: string } {
  if (build.platform !== device.platform) return { fits: false, reason: `This is an ${build.platform === 'ios' ? 'iOS' : 'Android'} build.` }
  if (device.deviceHostId !== LOCAL_DEVICE_HOST_ID) return { fits: false, reason: 'Builds install only on devices connected to the Solus host itself.' }
  if (device.unavailableReason) return { fits: false, reason: device.unavailableReason }
  if (build.runsOn === 'simulator' && device.physical) return { fits: false, reason: 'This is a simulator build. Build for a device (generic/platform=iOS) to install it on an iPhone or iPad.' }
  if (build.runsOn === 'device' && !device.physical) return { fits: false, reason: 'This is a device build. Build for the simulator to install it there.' }
  if (!device.booted) return { fits: false, reason: `${device.name} is not running. Open it first.` }
  return { fits: true }
}

/** Older hosts do not have the device domain; clients show unavailable. */
export const DEVICE_CAPABILITY = 'devices'

// ─── Requests ───

export const deviceTargetSchema = z.object({
  deviceHostId: deviceHostIdSchema.default(LOCAL_DEVICE_HOST_ID),
  deviceId: deviceIdSchema,
})
export type DeviceTarget = z.input<typeof deviceTargetSchema>

export const deviceConfigureRequestSchema = z.object({
  enabled: z.boolean().optional(),
  agentAccessEnabled: z.boolean().optional(),
  onboardingCompleted: z.boolean().optional(),
  autoShowAgentDevices: z.boolean().optional(),
})
export type DeviceConfigureRequest = z.infer<typeof deviceConfigureRequestSchema>

export const deviceOpenRequestSchema = deviceTargetSchema.extend({
  sessionId: z.string().min(1).max(200),
  platform: z.enum(DEVICE_PLATFORMS),
  /** Boot a stopped device. Defaults to true. */
  boot: z.boolean().optional(),
})
export type DeviceOpenRequest = z.input<typeof deviceOpenRequestSchema>

export const deviceCloseRequestSchema = z.object({
  sessionId: z.string().min(1).max(200),
  deviceHostId: deviceHostIdSchema.optional(),
  /** Omit to close every preview of the session. */
  deviceId: deviceIdSchema.optional(),
})
export type DeviceCloseRequest = z.infer<typeof deviceCloseRequestSchema>

export const deviceShutdownRequestSchema = deviceTargetSchema.extend({
  platform: z.enum(DEVICE_PLATFORMS),
  controlGeneration: z.number().int().nonnegative(),
})
export type DeviceShutdownRequest = z.input<typeof deviceShutdownRequestSchema>

export const deviceToolUpdateRequestSchema = z.object({
  deviceHostId: deviceHostIdSchema.default(LOCAL_DEVICE_HOST_ID),
  tool: z.enum(['hub', 'agent']),
})
export type DeviceToolUpdateRequest = z.input<typeof deviceToolUpdateRequestSchema>

export interface DeviceHostTestResult {
  ok: boolean
  /** The alias resolves to this Solus host; it is skipped as a duplicate. */
  isLocal: boolean
  summary?: DeviceHostSummary
  checks: { name: 'ssh' | 'node' | 'npm' | 'xcode' | 'android'; ok: boolean; detail?: string }[]
}

// ─── Control ───

export const deviceControlRequestSchema = deviceTargetSchema.extend({
  /** The session whose device surface the user is acting from. */
  sessionId: z.string().min(1).max(200).optional(),
})
export type DeviceControlRequest = z.input<typeof deviceControlRequestSchema>

export type DeviceControlResult =
  | { status: 'granted'; lease: DeviceControlLease; control: DeviceControlState }
  /** Someone else took control while this request waited. */
  | { status: 'superseded'; control: DeviceControlState }

// ─── Input ───

export const DEVICE_BUTTONS = ['home', 'back', 'recents', 'power', 'appSwitcher'] as const
export type DeviceButton = (typeof DEVICE_BUTTONS)[number]

export const DEVICE_ORIENTATIONS = ['portrait', 'landscape_left', 'portrait_upside_down', 'landscape_right'] as const
export type DeviceOrientation = (typeof DEVICE_ORIENTATIONS)[number]

const unit = z.number().min(0).max(1)

export const deviceInputSchema = z.discriminatedUnion('kind', [
  /** Normalized 0..1 in the displayed screen of `screenGeneration`. */
  z.object({ kind: z.literal('pointer'), phase: z.enum(['down', 'move', 'up', 'cancel']), x: unit, y: unit }),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(2000) }),
  z.object({
    kind: z.literal('key'),
    phase: z.enum(['down', 'up']),
    /** `KeyboardEvent.code` (iOS HID). */
    code: z.string().max(32),
    /** `KeyboardEvent.key` (Android). */
    key: z.string().max(32),
    hasModifier: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('scroll'), x: unit, y: unit, deltaX: z.number().min(-1).max(1), deltaY: z.number().min(-1).max(1) }),
  z.object({ kind: z.literal('button'), button: z.enum(DEVICE_BUTTONS) }),
  z.object({ kind: z.literal('rotate') }),
])
export type DeviceInput = z.infer<typeof deviceInputSchema>

export const deviceInputRequestSchema = deviceTargetSchema.extend({
  controlGeneration: z.number().int().nonnegative(),
  /** Pointer coordinates are only valid against the screen they were made on. */
  screenGeneration: z.number().int().nonnegative(),
  inputs: z.array(deviceInputSchema).min(1).max(64),
})
export type DeviceInputRequest = z.input<typeof deviceInputRequestSchema>

// ─── Stream ───

export const deviceSubscribeRequestSchema = deviceTargetSchema.extend({
  /** `jpeg` when this client cannot decode H.264 (iOS only). */
  format: z.enum(['h264', 'jpeg']),
})
export type DeviceSubscribeRequest = z.input<typeof deviceSubscribeRequestSchema>

export interface DeviceScreenConfig {
  width: number
  height: number
  orientation: DeviceOrientation
  screenId?: number
}

/**
 * One packet on the binary `device-frame` channel. The header rides beside the
 * bytes; video is never base64'd into a typed event.
 *
 * - `config`: decoder configuration. `format: 'avcc'` carries the avcC record
 *   as bytes; `annexb` carries no bytes (parameter sets ride in keyframes).
 * - `key` / `delta`: one encoded access unit.
 * - `jpeg`: one whole image (MJPEG fallback and iOS seed frames).
 * - `screen`: no bytes; the device screen changed and input generation moved.
 * - `ended`: no bytes; the upstream stream stopped (reason in `detail`).
 */
export type DeviceFramePacketKind = 'config' | 'key' | 'delta' | 'jpeg' | 'screen' | 'ended'

export interface DeviceFrameHeader {
  deviceHostId: string
  deviceId: string
  /** Increases whenever the upstream stream restarts. */
  streamGeneration: number
  seq: number
  kind: DeviceFramePacketKind
  codec?: string
  format?: 'avcc' | 'annexb'
  /** Microseconds, when the source provides them. */
  timestamp?: number
  screen?: DeviceScreenConfig
  screenGeneration?: number
  detail?: string
}

export const MAX_DEVICE_FRAME_BYTES = 8 * 1024 * 1024

// ─── Settings and actions (P10–P13) ───

export const DEVICE_TEXT_SIZES = ['small', 'default', 'large', 'extra-large'] as const
export type DeviceTextSize = (typeof DEVICE_TEXT_SIZES)[number]
export const DEVICE_COLOR_FILTERS = ['none', 'grayscale', 'red-green', 'green-red', 'blue-yellow'] as const
export type DeviceColorFilter = (typeof DEVICE_COLOR_FILTERS)[number]
export const DEVICE_TOGGLES = ['reduceMotion', 'increaseContrast', 'reduceTransparency', 'showBorders', 'voiceOver', 'networkEnabled'] as const
export type DeviceToggle = (typeof DEVICE_TOGGLES)[number]
export const DEVICE_PERMISSIONS = [
  'camera', 'microphone', 'photos', 'contacts', 'calendar', 'reminders', 'location', 'notifications', 'motion', 'media-library', 'faceid',
] as const
export type DevicePermission = (typeof DEVICE_PERMISSIONS)[number]

/** Values read back from the device. A missing field is unsupported or unread, never false. */
export interface DeviceSettings {
  appearance?: 'light' | 'dark'
  textSize?: DeviceTextSize
  reduceMotion?: boolean
  increaseContrast?: boolean
  reduceTransparency?: boolean
  showBorders?: boolean
  voiceOver?: boolean
  liquidGlass?: 'clear' | 'tinted'
  colorFilter?: DeviceColorFilter
  networkEnabled?: boolean
}

export interface DeviceForegroundApp {
  appId: string
  name?: string
  version?: string
}

export interface DeviceDetail {
  deviceHostId: string
  deviceId: string
  settings: DeviceSettings
  foregroundApp: DeviceForegroundApp | null
  readAt: number
}

const appIdSchema = z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9._-]+$/)

/** Normalized push fields. Arbitrary APNs JSON is a bounded string, parsed on the host. */
export const devicePushPayloadSchema = z.union([
  z.object({ kind: z.literal('text'), body: z.string().min(1).max(1000) }),
  z.object({ kind: z.literal('json'), json: z.string().min(2).max(4096) }),
])

export const deviceActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('setAppearance'), value: z.enum(['light', 'dark']) }),
  z.object({ type: z.literal('setTextSize'), value: z.enum(DEVICE_TEXT_SIZES) }),
  z.object({ type: z.literal('setToggle'), setting: z.enum(DEVICE_TOGGLES), value: z.boolean() }),
  z.object({ type: z.literal('setLiquidGlass'), value: z.enum(['clear', 'tinted']) }),
  z.object({ type: z.literal('setColorFilter'), value: z.enum(DEVICE_COLOR_FILTERS) }),
  z.object({ type: z.literal('setOrientation'), value: z.enum(DEVICE_ORIENTATIONS) }),
  z.object({ type: z.literal('setLocation'), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
  z.object({ type: z.literal('clearLocation') }),
  z.object({
    type: z.literal('setPermission'),
    appId: appIdSchema,
    permission: z.enum(DEVICE_PERMISSIONS),
    decision: z.enum(['grant', 'revoke', 'reset']),
  }),
  z.object({ type: z.literal('openUrl'), url: z.string().trim().min(1).max(2048).regex(/^[a-zA-Z][a-zA-Z0-9+.-]*:/) }),
  z.object({ type: z.literal('launchApp'), appId: appIdSchema }),
  z.object({ type: z.literal('terminateApp'), appId: appIdSchema }),
  z.object({ type: z.literal('sendPush'), appId: appIdSchema, payload: devicePushPayloadSchema }),
])
export type DeviceAction = z.infer<typeof deviceActionSchema>
export type DeviceActionType = DeviceAction['type']

export const deviceActionRequestSchema = deviceTargetSchema.extend({
  controlGeneration: z.number().int().nonnegative(),
  action: deviceActionSchema,
})
export type DeviceActionRequest = z.input<typeof deviceActionRequestSchema>

/** Which actions each platform's helpers can perform (T3 DeviceActions matrix). */
const IOS_ACTIONS: readonly DeviceActionType[] = [
  'setAppearance', 'setTextSize', 'setToggle', 'setLiquidGlass', 'setColorFilter', 'setLocation',
  'clearLocation', 'setPermission', 'openUrl', 'launchApp', 'terminateApp', 'sendPush',
]
/** Android emulators cannot clear a location fix, so `clearLocation` is not offered. */
const ANDROID_ACTIONS: readonly DeviceActionType[] = [
  'setAppearance', 'setTextSize', 'setToggle', 'setOrientation', 'setLocation',
  'setPermission', 'openUrl', 'launchApp', 'terminateApp',
]
const IOS_TOGGLES: readonly DeviceToggle[] = ['reduceMotion', 'increaseContrast', 'reduceTransparency', 'showBorders', 'voiceOver']
const ANDROID_TOGGLES: readonly DeviceToggle[] = ['reduceMotion', 'networkEnabled']
const IOS_PERMISSIONS: readonly DevicePermission[] = DEVICE_PERMISSIONS
const ANDROID_PERMISSIONS: readonly DevicePermission[] = ['camera', 'microphone', 'photos', 'contacts', 'calendar', 'location', 'notifications', 'motion']

export function deviceSupportsAction(platform: DevicePlatform, action: DeviceAction): boolean {
  if (!(platform === 'ios' ? IOS_ACTIONS : ANDROID_ACTIONS).includes(action.type)) return false
  if (action.type === 'setToggle') return (platform === 'ios' ? IOS_TOGGLES : ANDROID_TOGGLES).includes(action.setting)
  if (action.type === 'setPermission') {
    if (platform === 'android' && action.decision === 'reset') return false
    return (platform === 'ios' ? IOS_PERMISSIONS : ANDROID_PERMISSIONS).includes(action.permission)
  }
  return true
}

export function deviceSupportedToggles(platform: DevicePlatform): readonly DeviceToggle[] {
  return platform === 'ios' ? IOS_TOGGLES : ANDROID_TOGGLES
}

export function deviceSupportedPermissions(platform: DevicePlatform): readonly DevicePermission[] {
  return platform === 'ios' ? IOS_PERMISSIONS : ANDROID_PERMISSIONS
}

/** Hardware buttons each platform accepts. */
export function deviceSupportsButton(platform: DevicePlatform, button: DeviceButton): boolean {
  if (platform === 'ios') return button === 'home' || button === 'appSwitcher' || button === 'power'
  return true
}

// ─── Builds ───

export const deviceInstallRequestSchema = deviceTargetSchema.extend({
  buildId: z.string().trim().min(1).max(128),
  controlGeneration: z.number().int().nonnegative(),
  /** Open the app after it installs. Defaults to true. */
  launch: z.boolean().optional(),
})
export type DeviceInstallRequest = z.input<typeof deviceInstallRequestSchema>

// ─── Projects ───

/** Whether a project builds a mobile app, at its root or in a subfolder. */
export interface DeviceProjectInfo {
  isMobileApp: boolean
  platforms: DevicePlatform[]
  /** Up to five project-relative paths that showed it, for a tooltip. */
  markers: string[]
}

// ─── Screenshot ───

export const deviceScreenshotRequestSchema = deviceTargetSchema.extend({
  sessionId: z.string().min(1).max(200).optional(),
})
export type DeviceScreenshotRequest = z.input<typeof deviceScreenshotRequestSchema>

export interface DeviceScreenshotResult {
  device: DeviceSummary
  /** Host asset; fetch it through `assetCreateUrl`. Never a host file path. */
  assetId: string
  width: number
  height: number
  capturedAt: number
}

// ─── Errors ───

export const DEVICE_ERROR_CODES = [
  'feature_disabled', 'host_unavailable', 'platform_unavailable', 'device_not_found', 'boot_failed',
  'command_failed', 'request_failed', 'action_unsupported', 'helper_missing', 'control_required',
  'control_stale', 'control_busy', 'agent_paused', 'session_forbidden', 'stale_generation', 'invalid_request',
] as const
export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[number]

/** The domain error as a client sees it: the code is stable, the message is prose. */
export const DEVICE_ERROR_PREFIX = 'device_error:'

export function formatDeviceError(code: DeviceErrorCode, message: string): string {
  return `${DEVICE_ERROR_PREFIX}${code}: ${message}`
}

export interface ParsedDeviceError {
  code: DeviceErrorCode
  message: string
}

export function parseDeviceError(message: string): ParsedDeviceError | null {
  const index = message.indexOf(DEVICE_ERROR_PREFIX)
  if (index < 0) return null
  const rest = message.slice(index + DEVICE_ERROR_PREFIX.length)
  const colon = rest.indexOf(': ')
  if (colon < 0) return null
  const name = rest.slice(0, colon)
  const code = DEVICE_ERROR_CODES.find((candidate) => candidate === name)
  return code ? { code, message: rest.slice(colon + 2) } : null
}

export function deviceToolInstallMessage(name: string, tool: DeviceToolVersion | undefined): string {
  if (!tool) return `Installing ${name}…`
  const previous = tool.runningVersion
    ?? [...tool.installedVersions].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1)
  return previous && !tool.installedVersions.includes(tool.requiredVersion)
    ? `Updating ${name} from ${previous} to ${tool.requiredVersion}…`
    : `Installing ${name} ${tool.requiredVersion}…`
}
