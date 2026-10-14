import { describe, expect, test } from 'bun:test'
import type { DeviceProjectInfo, DeviceSummary } from '@solus/contracts/device-types'
import { profilesForDevice } from '@solus/client-core/device-builds'
import { RUN_PROFILE_PRESETS, commandSigningTeam, draftConfiguration, draftForPreset, joinCommand, needsSigningTeam, presetFor, projectPreset, profileDraft, profileSummary, profilesFromDrafts, saveRunProfiles, splitCommand, withConfiguration, withSigningTeam } from '@solus/client-core/device-run-profiles'
import { profileTargetLabel } from '@solus/client-core/device-builds'

/**
 * The Build & run editor and toolbar (plan 016, S02). The command a person
 * types is the command the host runs, word for word; the toolbar offers only
 * profiles that build for the device on screen.
 */

const simulator: DeviceSummary = { deviceHostId: 'local', deviceId: 'SIM-1', platform: 'ios', name: 'iPhone 17', version: 'iOS 26', booted: true, physical: false }
const phone: DeviceSummary = { ...simulator, deviceId: 'PHONE-1', name: 'Ash iPhone', physical: true }

describe('run profiles', () => {
  test('a command line splits on spaces, keeps quoted words whole, and reads back the same', () => {
    expect(splitCommand(`xcodebuild -destination 'generic/platform=iOS Simulator' -scheme "My App"`))
      .toEqual(['xcodebuild', '-destination', 'generic/platform=iOS Simulator', '-scheme', 'My App'])
    // WHY: nothing is expanded; a person's $HOME or pipe stays a literal word, as the host runs it.
    expect(splitCommand('echo $HOME | tee')).toEqual(['echo', '$HOME', '|', 'tee'])
    for (const preset of RUN_PROFILE_PRESETS) expect(splitCommand(joinCommand(preset.profile.command))).toEqual(preset.profile.command)
    expect(splitCommand(joinCommand(["it's", ''] ))).toEqual(["it's", ''])
  })

  test('the toolbar offers only profiles that build for the device on screen', () => {
    const profiles = RUN_PROFILE_PRESETS.map((preset) => preset.profile)
    expect(profilesForDevice(profiles, simulator).map((profile) => profile.name)).toEqual(['iOS simulator'])
    expect(profilesForDevice(profiles, phone).map((profile) => profile.name)).toEqual(['iOS device'])
  })

  test('there is one starting point for each place a build runs, and each fits an Expo app below the root', () => {
    // WHY: six presets with near-identical commands made people guess; the choice that matters is where the build runs.
    expect(RUN_PROFILE_PRESETS.map((preset) => preset.label)).toEqual(['iOS Simulator', 'iPhone or iPad', 'Android'])
    const expo: DeviceProjectInfo = { isMobileApp: true, platforms: ['android', 'ios'], markers: ['apps/mobile/package.json'], usesExpo: true }
    const [simulatorBuild, phoneBuild] = RUN_PROFILE_PRESETS.map((preset) => projectPreset(preset.profile, expo, ['Solus.xcworkspace', 'Podfile']))
    expect(simulatorBuild).toMatchObject({ cwd: 'apps/mobile/ios', target: 'simulator', artifact: 'build/Build/Products/Debug-iphonesimulator/*.app' })
    expect(simulatorBuild!.command.slice(0, 7)).toEqual(['xcodebuild', '-workspace', 'Solus.xcworkspace', '-scheme', 'Solus', '-configuration', 'Debug'])
    // WHY: a build a person puts on their own phone must be one xcodebuild may sign and register the phone for.
    expect(phoneBuild!.target).toBe('device')
    expect(phoneBuild!.command).toEqual(expect.arrayContaining(['generic/platform=iOS', '-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration']))
    expect(presetFor({ platform: 'ios', target: 'device' }).label).toBe('iPhone or iPad')
    expect(presetFor({ platform: 'android', target: 'any' }).label).toBe('Android')
  })

  test('Release is one choice: the command and the output path change together', () => {
    // WHY: a Release command with a Debug output path builds, then finds nothing to add.
    const phoneBuild = profileDraft(RUN_PROFILE_PRESETS[1]!.profile)
    expect(draftConfiguration(phoneBuild)).toBe('Debug')
    const release = withConfiguration(phoneBuild, 'Release')
    expect(draftConfiguration(release)).toBe('Release')
    expect(release.artifact).toBe('build/Build/Products/Release-iphoneos/*.app')
    expect(withConfiguration(release, 'Debug')).toEqual({ commandText: phoneBuild.commandText, artifact: phoneBuild.artifact })
    const android = withConfiguration(profileDraft(RUN_PROFILE_PRESETS[2]!.profile), 'Release')
    expect(android).toEqual({ commandText: './gradlew assembleRelease', artifact: 'app/build/outputs/apk/release/*.apk' })
    // A command Solus does not know offers no choice.
    expect(draftConfiguration({ commandText: 'npx expo run:ios' })).toBeNull()
  })

  test('building for something else replaces the command, and keeps the name, configuration and app id', async () => {
    // WHY: switching an Xcode profile to Android used to keep xcodebuild, which can never make an APK.
    // A host that cannot answer: each preset keeps its own folder.
    const api = {
      deviceProjectDetect: async () => { throw new Error('offline') },
      listDirectory: async () => { throw new Error('offline') },
      deviceSigningTeams: async () => { throw new Error('offline') },
    }
    const mine = { ...profileDraft(RUN_PROFILE_PRESETS[0]!.profile), name: 'Staging', appId: 'com.example.app' }
    const released = { ...mine, ...withConfiguration(mine, 'Release') }
    const android = await draftForPreset(api, '/code/app', released, RUN_PROFILE_PRESETS[2]!)
    expect(android).toMatchObject({ name: 'Staging', platform: 'android', appId: 'com.example.app', commandText: './gradlew assembleRelease' })
    // A preset's own name follows the new preset.
    expect((await draftForPreset(api, '/code/app', profileDraft(RUN_PROFILE_PRESETS[0]!.profile), RUN_PROFILE_PRESETS[1]!)).name).toBe('iOS device')
  })

  test('the signing team is read from and written to the command, as one build setting', () => {
    const command = 'xcodebuild -scheme Solus -destination generic/platform=iOS -allowProvisioningUpdates build'
    expect(commandSigningTeam(command)).toBe('')
    const signed = withSigningTeam(command, 'F4AQ9YJ7Q3')
    expect(signed).toBe('xcodebuild -scheme Solus -destination generic/platform=iOS -allowProvisioningUpdates DEVELOPMENT_TEAM=F4AQ9YJ7Q3 build')
    expect(commandSigningTeam(signed)).toBe('F4AQ9YJ7Q3')
    // Changing it replaces the one setting; clearing it removes it.
    expect(withSigningTeam(signed, 'ZZZZZZZZZZ').match(/DEVELOPMENT_TEAM=/g)).toHaveLength(1)
    expect(withSigningTeam(signed, '')).toBe(command)
    // Only an iPhone or iPad build made with xcodebuild is signed by it.
    expect(needsSigningTeam({ platform: 'ios', target: 'device', commandText: command })).toBe(true)
    expect(needsSigningTeam({ platform: 'ios', target: 'simulator', commandText: command })).toBe(false)
    expect(needsSigningTeam({ platform: 'ios', target: 'device', commandText: 'npx expo run:ios --device' })).toBe(false)
  })

  test('a profile row says what it builds for, where, and who signs it, and warns when a phone build has no team', () => {
    const phoneBuild = profileDraft({ ...RUN_PROFILE_PRESETS[1]!.profile, cwd: 'apps/mobile/ios' })
    expect(profileSummary(phoneBuild, [])).toBe('iPhone or iPad · apps/mobile/ios · needs a signing team')
    const signed = { ...phoneBuild, commandText: withSigningTeam(phoneBuild.commandText, 'F4AQ9YJ7Q3') }
    expect(profileSummary(signed, [{ teamId: 'F4AQ9YJ7Q3', name: 'Ashton Sidhu' }])).toBe('iPhone or iPad · apps/mobile/ios · signed by Ashton Sidhu')
    expect(profileSummary(signed, [])).toBe('iPhone or iPad · apps/mobile/ios · signed by F4AQ9YJ7Q3')
    expect(profileSummary(profileDraft(RUN_PROFILE_PRESETS[2]!.profile), [])).toBe('Android · android')
  })

  test('the editor names the first problem and refuses two profiles with one name', () => {
    const draft = profileDraft(RUN_PROFILE_PRESETS[2]!.profile)
    expect(profilesFromDrafts([{ ...draft, commandText: '  ' }])).toEqual({ error: 'Android needs a command.' })
    expect(profilesFromDrafts([draft, draft])).toEqual({ error: 'Two profiles are named "Android". Give each its own name.' })
    const saved = profilesFromDrafts([{ ...draft, cwd: '', appId: ' com.example.app ' }])
    expect(saved).toEqual({ profiles: [{ ...RUN_PROFILE_PRESETS[2]!.profile, cwd: '.', appId: 'com.example.app' }] })
  })

})

describe('saving build profiles', () => {
  test('saving replaces the profiles and keeps the rest of the project config', async () => {
    // WHY: desktop and mobile both save here; the project's other settings must survive either.
    let written: unknown = null
    const api = {
      projectConfigLoad: async () => ({ version: 1 as const, tasksAutoPushComments: true, deviceRuns: [] }),
      projectConfigSave: async (_path: string, config: { deviceRuns?: unknown }) => { written = config; return config as never },
    }
    const profile = RUN_PROFILE_PRESETS[1]!.profile
    expect(await saveRunProfiles(api as never, '/code/app', [profile])).toEqual([profile])
    expect(written).toEqual({ version: 1, tasksAutoPushComments: true, deviceRuns: [profile] })
  })
})

describe('device target configuration', () => {
  test('profiles name what they build for, so a phone build is not mistaken for a simulator one', () => {
    // WHY: a simulator build cannot go on a phone; the menu must say which is which.
    expect(profileTargetLabel({ platform: 'ios', target: 'device' })).toBe('iPhone or iPad')
    expect(profileTargetLabel({ platform: 'ios', target: 'simulator' })).toBe('iOS Simulator')
    expect(profileTargetLabel({ platform: 'android', target: 'any' })).toBe('Android')
  })

})
