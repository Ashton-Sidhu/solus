import { describe, expect, test } from 'bun:test'
import type { DeviceBuild, DeviceProjectInfo, DeviceState, DeviceSummary } from '@solus/contracts/device-types'
import { buildRunBlocker, deviceBuildTargets } from '@solus/client-core/device-builds'
import { RUN_PROFILE_PRESETS, fitPresetToProject, presetFolder, projectPreset } from '@solus/client-core/device-run-profiles'
import { conversationCheckout, devicesPaneView } from '@solus/workspace-ui/components/devices/lib/device-pane'

/**
 * Making and running a build from the Builds page (plan 016, S02). The rules:
 * Builds opens without a conversation; New build has a project to build,
 * from the conversation or chosen; a preset starts where the app is; and a
 * build that cannot run says why on the page.
 */

const ready = { isReady: true, adding: false, hasPreview: false }

describe('opening Builds', () => {
  test('Builds opens from the header, palette or project panel without a conversation', () => {
    // WHY: the pane showed "Open a conversation" over Builds, so a host's builds could not be made or run.
    expect(devicesPaneView({ ...ready, hasSession: false, showBuilds: true })).toBe('builds')
    expect(devicesPaneView({ ...ready, hasSession: true, showBuilds: true })).toBe('builds')
  })

  test('device tabs still need a conversation, and an unready host shows its status', () => {
    expect(devicesPaneView({ ...ready, hasSession: false, showBuilds: false })).toBe('status')
    expect(devicesPaneView({ ...ready, hasSession: true, showBuilds: false })).toBe('picker')
    expect(devicesPaneView({ ...ready, hasSession: true, showBuilds: false, hasPreview: true })).toBe('device')
    expect(devicesPaneView({ ...ready, isReady: false, hasSession: true, showBuilds: true })).toBe('status')
  })

  test('a conversation builds in its worktree; a chat or an unchosen folder leaves the project to be chosen', () => {
    expect(conversationCheckout({ workingDirectory: '/code/solus', gitContext: { worktreePath: '/code/.wt/feature' } })).toBe('/code/.wt/feature')
    expect(conversationCheckout({ workingDirectory: '/code/solus', gitContext: null })).toBe('/code/solus')
    expect(conversationCheckout({ workingDirectory: '~' })).toBeNull()
    expect(conversationCheckout(undefined)).toBeNull()
  })
})

describe('setting up a build', () => {
  // What detection reports for the Solus repository: an Expo app below the root.
  const solus: DeviceProjectInfo = { isMobileApp: true, platforms: ['android', 'ios'], markers: ['apps/mobile/package.json'] }
  const ios = RUN_PROFILE_PRESETS.find((preset) => preset.profile.target === 'device')!.profile

  test('a preset builds where the app is, not in ios at the checkout root', () => {
    // WHY: with cwd "ios" the build failed at once in a monorepo; the person saw nothing they could fix.
    expect(presetFolder(ios, solus)).toBe('apps/mobile/ios')
    expect(presetFolder({ platform: 'android' }, solus)).toBe('apps/mobile/android')
    expect(presetFolder(ios, { isMobileApp: true, platforms: ['ios'], markers: ['ios/App.xcworkspace'] })).toBe('ios')
    expect(presetFolder(ios, null)).toBe('ios')
  })

  test('an Xcode preset names the workspace found there and its scheme', () => {
    const fitted = projectPreset(ios, solus, ['Podfile', 'Solus.xcodeproj', 'Solus.xcworkspace'])
    expect(fitted.cwd).toBe('apps/mobile/ios')
    expect(fitted.command.slice(0, 5)).toEqual(['xcodebuild', '-workspace', 'Solus.xcworkspace', '-scheme', 'Solus'])
    expect(fitted.command).not.toContain('App')
    // Still a device build, signed by the project's team.
    expect(fitted.command).toContain('generic/platform=iOS')
    expect(fitted.command).toContain('-allowProvisioningUpdates')
    expect(fitted.artifact).toBe(ios.artifact)
  })

  test('fitting asks the host about the checkout it builds', async () => {
    const asked: string[] = []
    const api = {
      deviceProjectDetect: async (path: string) => { asked.push(`detect ${path}`); return solus },
      listDirectory: async (path: string) => {
        asked.push(`list ${path}`)
        return { entries: [{ name: 'Solus.xcworkspace', isDir: true, path: `${path}/Solus.xcworkspace` }], parentPath: null, currentPath: path, error: null }
      },
    }
    const fitted = await fitPresetToProject(api, '/Users/me/solus/', ios)
    expect(asked).toEqual(['detect /Users/me/solus/', 'list /Users/me/solus/apps/mobile/ios'])
    expect(fitted.command[2]).toBe('Solus.xcworkspace')
  })
})

describe('running a build', () => {
  const phone: DeviceSummary = { deviceHostId: 'local', deviceId: 'PHONE-1', platform: 'ios', name: 'Ash iPhone', version: 'iOS 26', booted: true, physical: true }
  const simulator: DeviceSummary = { deviceHostId: 'local', deviceId: 'SIM-1', platform: 'ios', name: 'iPhone 17', version: 'iOS 26', booted: false, physical: false }
  const build = (fields: Partial<DeviceBuild>): DeviceBuild => ({ buildId: 'b1', platform: 'ios', runsOn: 'simulator', appId: 'sh.solus.mobile', name: 'Solus.app', sessionId: '', sizeBytes: 1, createdAt: 0, assetId: null, lastInstall: null, ...fields })
  const state = (devices: DeviceSummary[], builds: DeviceBuild[] = []): DeviceState => ({ revision: 1, settings: { enabled: true, agentAccessEnabled: true, onboardingCompleted: true, autoShowAgentDevices: true }, hosts: [], hostStatuses: [], devices, previews: [], booting: [], controls: [], builds, runs: [] })

  test('a simulator build with only a phone plugged in says to make a device build', () => {
    // WHY: Run was disabled with its reason in a tooltip a disabled button never shows.
    const reason = buildRunBlocker(state([phone]), build({}))
    expect(reason).toContain('simulator build')
    expect(reason).toContain('Ash iPhone')
    expect(reason).toContain('New build')
  })

  test('a device build runs on the plugged-in phone', () => {
    const deviceBuild = build({ runsOn: 'device' })
    expect(deviceBuildTargets(state([phone, simulator]), deviceBuild).map((device) => device.deviceId)).toEqual(['PHONE-1'])
    expect(buildRunBlocker(state([phone, simulator]), deviceBuild)).toBeNull()
  })

  test('a stopped simulator is offered only where it can be started, and the reason says how', () => {
    expect(buildRunBlocker(state([simulator]), build({}), { canBoot: true })).toBeNull()
    expect(buildRunBlocker(state([simulator]), build({}))).toContain('Start iPhone 17 first')
    const notTrusted = { ...phone, unavailableReason: 'Ash iPhone does not trust this Mac. Unlock it and tap Trust.' }
    expect(buildRunBlocker(state([notTrusted]), build({ runsOn: 'device' }))).toBe(notTrusted.unavailableReason)
  })
})
