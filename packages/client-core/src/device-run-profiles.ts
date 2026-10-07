import type { z } from 'zod'
import { MAX_DEVICE_RUN_PROFILES, deviceRunProfileSchema, type DeviceProjectInfo, type DeviceRunProfile } from '@solus/contracts/device-types'
import type { HostApi } from './host-api'

/**
 * Build profiles as a person edits them (plan 016, S02), shared by the
 * workspace and the native mobile app: starting points, the command as one
 * editable line, the checks a draft must pass, and saving them into the
 * project's `.solus/config.json`.
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

/**
 * The folder a preset builds in, from what project detection found: a
 * monorepo's app lives below the checkout root (`apps/mobile/package.json`
 * makes `apps/mobile/ios`), not in `ios` at the root.
 */
export function presetFolder(profile: Pick<DeviceRunProfile, 'platform'>, info: DeviceProjectInfo | null | undefined): string {
  const native = profile.platform === 'ios' ? 'ios' : 'android'
  for (const marker of info?.markers ?? []) {
    if (profile.platform === 'ios' && /\.(xcworkspace|xcodeproj)$/.test(marker)) return marker.split('/').slice(0, -1).join('/') || '.'
    if (profile.platform === 'android' && (marker === 'android' || marker.endsWith('/android'))) return marker
  }
  const marker = info?.markers.find((candidate) => /(^|\/)(package\.json|pubspec\.yaml|capacitor\.config)$/.test(candidate))
  const app = marker ? marker.split('/').slice(0, -1).join('/') : ''
  return app ? `${app}/${native}` : native
}

/**
 * A preset fitted to the project: its folder from detection, and for Xcode
 * the workspace or project found there, named in the command with its scheme
 * (the scheme is guessed from the name and stays editable).
 */
export function projectPreset(profile: DeviceRunProfile, info: DeviceProjectInfo | null | undefined, folderEntries: readonly string[] = []): DeviceRunProfile {
  const cwd = presetFolder(profile, info)
  if (profile.platform !== 'ios') return { ...profile, cwd }
  const container = folderEntries.find((name) => name.endsWith('.xcworkspace')) ?? folderEntries.find((name) => name.endsWith('.xcodeproj'))
  if (!container) return { ...profile, cwd }
  const scheme = container.replace(/\.(xcworkspace|xcodeproj)$/, '')
  const flag = container.endsWith('.xcworkspace') ? '-workspace' : '-project'
  const rest = profile.command.slice(1).filter((word, index, words) => word !== '-scheme' && words[index - 1] !== '-scheme')
  return { ...profile, cwd, command: ['xcodebuild', flag, container, '-scheme', scheme, ...rest] }
}

/**
 * Fit a preset to a checkout on its host: detect where the app is, and for
 * Xcode find the workspace in that folder. A host that cannot answer leaves
 * the preset's own folder, which the person edits.
 */
export async function fitPresetToProject(
  api: Pick<HostApi, 'deviceProjectDetect' | 'listDirectory'>,
  checkoutPath: string,
  profile: DeviceRunProfile,
): Promise<DeviceRunProfile> {
  const info = await api.deviceProjectDetect(checkoutPath).catch(() => null)
  if (profile.platform !== 'ios') return projectPreset(profile, info)
  const folder = presetFolder(profile, info)
  const listing = await api.listDirectory(`${checkoutPath.replace(/\/+$/, '')}/${folder}`).catch(() => null)
  return projectPreset(profile, info, listing?.entries.map((entry) => entry.name) ?? [])
}

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

/** What a field needs, named for the person fixing it. */
function fieldNeed(field: string): string {
  switch (field) {
    case 'name': return 'a name'
    case 'command': return 'a command'
    case 'artifact': return 'an output path'
    case 'appId': return 'an app id of letters, digits, dots, dashes and underscores'
    case 'cwd': return 'a shorter folder'
    default: return `a valid ${field}`
  }
}

/** Check every draft; the first problem is named so the person can fix it. */
export function profilesFromDrafts(drafts: readonly RunProfileDraft[]): { profiles: DeviceRunProfile[] } | { error: string } {
  const profiles: DeviceRunProfile[] = []
  for (const draft of drafts) {
    const label = draft.name.trim() || 'A profile'
    const input: z.input<typeof deviceRunProfileSchema> = {
      name: draft.name,
      platform: draft.platform,
      target: draft.platform === 'android' ? 'any' : draft.target,
      cwd: draft.cwd.trim() || '.',
      command: splitCommand(draft.commandText),
      artifact: draft.artifact,
    }
    if (draft.appId.trim()) input.appId = draft.appId.trim()
    const parsed = deviceRunProfileSchema.safeParse(input)
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? 'profile')
      return { error: `${label} needs ${fieldNeed(field)}.` }
    }
    if (profiles.some((profile) => profile.name === parsed.data.name)) return { error: `Two profiles are named "${parsed.data.name}". Give each its own name.` }
    profiles.push(parsed.data)
  }
  if (profiles.length > MAX_DEVICE_RUN_PROFILES) return { error: `A project can keep up to ${MAX_DEVICE_RUN_PROFILES} build profiles.` }
  return { profiles }
}

/** Replace the project's build profiles. The rest of its config is kept. Returns what the host saved. */
export async function saveRunProfiles(api: Pick<HostApi, 'projectConfigLoad' | 'projectConfigSave'>, checkoutPath: string, profiles: DeviceRunProfile[]): Promise<DeviceRunProfile[] | null> {
  const config = (await api.projectConfigLoad(checkoutPath)) ?? { version: 1 as const }
  const saved = await api.projectConfigSave(checkoutPath, { ...config, deviceRuns: profiles })
  return saved.deviceRuns ?? null
}
