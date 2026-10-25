import type { z } from 'zod'
import { joinHostPath } from '@solus/contracts/host-path'
import { MAX_DEVICE_RUN_PROFILES, deviceRunProfileSchema, type DeviceProjectInfo, type DeviceRunProfile, type DeviceSigningTeam } from '@solus/contracts/device-types'
import type { HostApi } from './host-api'
import { profileTargetLabel } from './device-builds'

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

/**
 * The three starting points, one for each place a build runs. Detection fits
 * the folder, the Xcode workspace and its scheme to the project. Each starts
 * as a Debug build; Release is one choice away (`withConfiguration`). An Expo
 * or React Native Debug build loads its JavaScript from Metro.
 */
export const RUN_PROFILE_PRESETS: RunProfilePreset[] = [
  {
    label: 'iOS Simulator',
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
    label: 'iPhone or iPad',
    profile: {
      name: 'iOS device',
      platform: 'ios',
      target: 'device',
      cwd: 'ios',
      command: ['xcodebuild', '-scheme', 'App', '-configuration', 'Debug', '-destination', 'generic/platform=iOS', '-derivedDataPath', 'build', '-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration', 'build'],
      artifact: 'build/Build/Products/Debug-iphoneos/*.app',
    },
  },
  {
    label: 'Android',
    profile: {
      name: 'Android',
      platform: 'android',
      target: 'any',
      cwd: 'android',
      command: ['./gradlew', 'assembleDebug'],
      artifact: 'app/build/outputs/apk/debug/*.apk',
    },
  },
]

/** The preset for what a profile builds for. */
export function presetFor(draft: Pick<RunProfileDraft, 'platform' | 'target'>): RunProfilePreset {
  const preset = RUN_PROFILE_PRESETS.find((candidate) => candidate.profile.platform === draft.platform && (draft.platform === 'android' || candidate.profile.target === draft.target))
  return preset ?? RUN_PROFILE_PRESETS[0]!
}

export type BuildConfiguration = 'Debug' | 'Release'

/** Whether a profile builds Debug or Release, read from its command; null for a command Solus does not know. */
export function draftConfiguration(draft: Pick<RunProfileDraft, 'commandText'>): BuildConfiguration | null {
  const words = splitCommand(draft.commandText)
  if (words[0] === 'xcodebuild') {
    const value = words[words.indexOf('-configuration') + 1]
    return words.includes('-configuration') && (value === 'Debug' || value === 'Release') ? value : null
  }
  const task = words.find((word) => /^assemble(Debug|Release)$/.test(word))
  return task ? (task.endsWith('Release') ? 'Release' : 'Debug') : null
}

/** The command and output for the other configuration. The output path follows the command. */
export function withConfiguration(draft: Pick<RunProfileDraft, 'commandText' | 'artifact'>, configuration: BuildConfiguration): Pick<RunProfileDraft, 'commandText' | 'artifact'> {
  const words = splitCommand(draft.commandText)
  if (words[0] === 'xcodebuild') {
    const at = words.indexOf('-configuration')
    if (at >= 0) words[at + 1] = configuration
    else words.splice(words.at(-1) === 'build' ? words.length - 1 : words.length, 0, '-configuration', configuration)
    return { commandText: joinCommand(words), artifact: draft.artifact.replace(/(^|\/)(Debug|Release)-(iphoneos|iphonesimulator)\//, `$1${configuration}-$3/`) }
  }
  return {
    commandText: joinCommand(words.map((word) => (/^assemble(Debug|Release)$/.test(word) ? `assemble${configuration}` : word))),
    artifact: draft.artifact.replace(/(^|\/)apk\/(debug|release)\//, `$1apk/${configuration.toLowerCase()}/`),
  }
}

/**
 * The profile changed to build for something else: the preset for it, fitted
 * to the project, keeping the person's name (unless it was a preset's),
 * configuration and app id. A command for one platform never builds another.
 */
export async function draftForPreset(
  api: Parameters<typeof fitPresetToProject>[0],
  checkoutPath: string,
  draft: RunProfileDraft,
  preset: RunProfilePreset,
): Promise<RunProfileDraft> {
  const fitted = profileDraft(await fitPresetToProject(api, checkoutPath, preset.profile))
  const hasOwnName = draft.name.trim() !== '' && !RUN_PROFILE_PRESETS.some((candidate) => candidate.profile.name === draft.name)
  const next = { ...fitted, name: hasOwnName ? draft.name : fitted.name, appId: draft.appId }
  const configuration = draftConfiguration(draft)
  return configuration ? { ...next, ...withConfiguration(next, configuration) } : next
}

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
  const rest = profile.command.slice(1).filter((word, index, words) => !['-scheme', '-project', '-workspace'].includes(word) && !['-scheme', '-project', '-workspace'].includes(words[index - 1] ?? ''))
  return { ...profile, cwd, command: ['xcodebuild', flag, container, '-scheme', scheme, ...rest] }
}

/**
 * Fit a preset to a checkout on its host: detect where the app is, and for
 * Xcode find the workspace in that folder. A phone build is signed for the
 * host's first signing team. A host that cannot answer leaves the preset's
 * own folder and no team, which the person edits.
 */
export async function fitPresetToProject(
  api: Pick<HostApi, 'deviceProjectDetect' | 'listDirectory' | 'deviceSigningTeams'>,
  checkoutPath: string,
  profile: DeviceRunProfile,
): Promise<DeviceRunProfile> {
  const info = await api.deviceProjectDetect(checkoutPath).catch(() => null)
  if (profile.platform !== 'ios') return projectPreset(profile, info)
  const folder = presetFolder(profile, info)
  const [listing, teams] = await Promise.all([
    api.listDirectory(joinHostPath(checkoutPath, folder)).catch(() => null),
    profile.target === 'device' ? api.deviceSigningTeams().catch(() => []) : [],
  ])
  const fitted = projectPreset(profile, info, listing?.entries.map((entry) => entry.name) ?? [])
  const team = teams[0]
  return team ? { ...fitted, command: splitCommand(withSigningTeam(joinCommand(fitted.command), team.teamId)) } : fitted
}

const TEAM_SETTING = /(^|\s)DEVELOPMENT_TEAM=(\S*)/

/** The signing team an xcodebuild command names with `DEVELOPMENT_TEAM=`, or ''. */
export function commandSigningTeam(commandText: string): string {
  return TEAM_SETTING.exec(commandText)?.[2] ?? ''
}

/**
 * The command with its signing team set, before the final build action so
 * it reads as a build setting. An empty team removes the setting.
 */
export function withSigningTeam(commandText: string, teamId: string): string {
  const team = teamId.trim()
  const without = commandText.replace(TEAM_SETTING, '').trim()
  if (!team) return without
  if (TEAM_SETTING.test(commandText)) return commandText.replace(TEAM_SETTING, `$1DEVELOPMENT_TEAM=${team}`)
  const words = splitCommand(without)
  const at = words.at(-1) === 'build' ? words.length - 1 : words.length
  return joinCommand([...words.slice(0, at), `DEVELOPMENT_TEAM=${team}`, ...words.slice(at)])
}

/** Whether a profile's build is signed by xcodebuild: an iPhone or iPad build made with xcodebuild. */
export function needsSigningTeam(draft: Pick<RunProfileDraft, 'platform' | 'target' | 'commandText'>): boolean {
  return draft.platform === 'ios' && draft.target === 'device' && splitCommand(draft.commandText)[0] === 'xcodebuild'
}

/** The teams a host can sign for, with the help a person needs when it has none. */
export function signingTeamHint(teams: readonly DeviceSigningTeam[]): string {
  return teams.length
    ? 'Every app on an iPhone or iPad is signed. xcodebuild signs it for this team.'
    : 'Every app on an iPhone or iPad is signed. This Mac has no Apple certificate yet: add your Apple account in Xcode → Settings → Accounts, or enter your team id.'
}

/**
 * One line that says what a profile is, for its row in the editor: what it
 * builds for, where, and who signs it. A phone build with no team says so,
 * because xcodebuild cannot sign it.
 */
export function profileSummary(draft: RunProfileDraft, teams: readonly DeviceSigningTeam[]): string {
  const parts = [profileTargetLabel(draft), draft.cwd.trim() || '.']
  if (needsSigningTeam(draft)) {
    const teamId = commandSigningTeam(draft.commandText)
    parts.push(teamId ? `signed by ${teams.find((team) => team.teamId === teamId)?.name ?? teamId}` : 'needs a signing team')
  }
  return parts.join(' · ')
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
