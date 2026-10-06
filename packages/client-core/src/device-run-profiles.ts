import type { z } from 'zod'
import { MAX_DEVICE_RUN_PROFILES, deviceRunProfileSchema, type DeviceRunProfile } from '@solus/contracts/device-types'
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
