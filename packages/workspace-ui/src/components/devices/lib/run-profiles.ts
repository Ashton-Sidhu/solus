import { LOCAL_DEVICE_HOST_ID, MAX_DEVICE_RUN_PROFILES, deviceRunProfileSchema, isDeviceRunActive, type DeviceRun, type DeviceRunProfile, type DeviceSummary } from '@solus/contracts/device-types'

/**
 * Build-and-run profiles for the Devices pane (plan 016, S02): starting
 * points, the command as one editable line, and which profiles and runs
 * belong to the device on screen.
 */

export interface RunProfilePreset {
  label: string
  profile: DeviceRunProfile
}

/** Common native builds. The scheme and folders are guesses the person edits. */
export const RUN_PROFILE_PRESETS: RunProfilePreset[] = [
  {
    label: 'Xcode — simulator',
    profile: {
      name: 'iOS simulator',
      platform: 'ios',
      target: 'simulator',
      cwd: 'ios',
      command: ['xcodebuild', '-scheme', 'App', '-configuration', 'Debug', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', 'build', 'build'],
      artifact: 'build/Build/Products/Debug-iphonesimulator/*.app',
    },
  },
  {
    label: 'Xcode — iPhone or iPad',
    profile: {
      name: 'iOS device',
      platform: 'ios',
      target: 'device',
      cwd: 'ios',
      command: ['xcodebuild', '-scheme', 'App', '-configuration', 'Debug', '-destination', 'generic/platform=iOS', '-derivedDataPath', 'build', '-allowProvisioningUpdates', 'build'],
      artifact: 'build/Build/Products/Debug-iphoneos/*.app',
    },
  },
  {
    label: 'Gradle — debug APK',
    profile: {
      name: 'Android debug',
      platform: 'android',
      target: 'any',
      cwd: 'android',
      command: ['./gradlew', 'assembleDebug'],
      artifact: 'app/build/outputs/apk/debug/*.apk',
    },
  },
]

/** Split a command line into arguments. Quotes group words; nothing is expanded. */
export function splitCommand(text: string): string[] {
  const words: string[] = []
  let word = ''
  let quote: '"' | "'" | null = null
  let inWord = false
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      inWord = true
    } else if (/\s/.test(char)) {
      if (inWord) words.push(word)
      word = ''
      inWord = false
    } else {
      word += char
      inWord = true
    }
  }
  if (inWord) words.push(word)
  return words
}

/** The arguments as one line that `splitCommand` reads back the same. */
export function joinCommand(command: readonly string[]): string {
  return command.map((word) => (word !== '' && /^[^\s"']+$/.test(word) ? word : word.includes("'") ? `"${word}"` : `'${word}'`)).join(' ')
}

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
    installing: `Installing on ${run.deviceName}…`,
    done: `Running on ${run.deviceName}`,
    failed: 'Build and run failed',
    cancelled: 'Cancelled',
  }[run.stage]
}

/** A profile as the editor holds it: the command is one line of text. */
export interface RunProfileDraft {
  name: string
  platform: DeviceRunProfile['platform']
  target: DeviceRunProfile['target']
  cwd: string
  commandText: string
  artifact: string
  appId: string
}

export function profileDraft(profile: DeviceRunProfile): RunProfileDraft {
  return { name: profile.name, platform: profile.platform, target: profile.target, cwd: profile.cwd, commandText: joinCommand(profile.command), artifact: profile.artifact, appId: profile.appId ?? '' }
}

/** Check every draft; the first problem is named so the person can fix it. */
export function profilesFromDrafts(drafts: readonly RunProfileDraft[]): { profiles: DeviceRunProfile[] } | { error: string } {
  const profiles: DeviceRunProfile[] = []
  for (const draft of drafts) {
    const label = draft.name.trim() || 'A profile'
    const parsed = deviceRunProfileSchema.safeParse({
      name: draft.name,
      platform: draft.platform,
      target: draft.platform === 'android' ? 'any' : draft.target,
      cwd: draft.cwd.trim() || '.',
      command: splitCommand(draft.commandText),
      artifact: draft.artifact,
      ...(draft.appId.trim() ? { appId: draft.appId.trim() } : {}),
    })
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? 'profile')
      const names: { [key: string]: string } = { name: 'a name', command: 'a command', artifact: 'an output path', appId: 'an app id of letters, digits, dots, dashes and underscores', cwd: 'a shorter folder' }
      return { error: `${label} needs ${names[field] ?? `a valid ${field}`}.` }
    }
    if (profiles.some((profile) => profile.name === parsed.data.name)) return { error: `Two profiles are named "${parsed.data.name}". Give each its own name.` }
    profiles.push(parsed.data)
  }
  if (profiles.length > MAX_DEVICE_RUN_PROFILES) return { error: `A project can keep up to ${MAX_DEVICE_RUN_PROFILES} build profiles.` }
  return { profiles }
}
