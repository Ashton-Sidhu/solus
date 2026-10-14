import { describe, expect, test } from 'bun:test'
import type { DeviceProjectInfo } from '@solus/contracts/device-types'
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
    expect(devicesPaneView({ ...ready, hasSession: false, showRunApp: true })).toBe('runApp')
    expect(devicesPaneView({ ...ready, hasSession: true, showRunApp: true })).toBe('runApp')
  })

  test('device tabs still need a conversation, and an unready host shows its status', () => {
    expect(devicesPaneView({ ...ready, hasSession: false, showRunApp: false })).toBe('status')
    expect(devicesPaneView({ ...ready, hasSession: true, showRunApp: false })).toBe('picker')
    expect(devicesPaneView({ ...ready, hasSession: true, showRunApp: false, hasPreview: true })).toBe('device')
    expect(devicesPaneView({ ...ready, isReady: false, hasSession: true, showRunApp: true })).toBe('status')
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
      deviceSigningTeams: async () => [{ teamId: 'F4AQ9YJ7Q3', name: 'Ashton Sidhu' }],
    }
    const fitted = await fitPresetToProject(api, '/Users/me/solus/', ios)
    expect(asked).toEqual(['detect /Users/me/solus/', 'list /Users/me/solus/apps/mobile/ios'])
    expect(fitted.command[2]).toBe('Solus.xcworkspace')
    // WHY: a phone build with no team fails to sign; the host's team is filled in, as a build setting before the action.
    expect(fitted.command.slice(-2)).toEqual(['DEVELOPMENT_TEAM=F4AQ9YJ7Q3', 'build'])
  })

  test('a host with no signing team leaves the phone build for the person to finish', async () => {
    const api = {
      deviceProjectDetect: async () => solus,
      listDirectory: async () => { throw new Error('offline') },
      deviceSigningTeams: async () => { throw new Error('older host') },
    }
    const fitted = await fitPresetToProject(api, '/Users/me/solus', ios)
    expect(fitted.command.some((word) => word.startsWith('DEVELOPMENT_TEAM='))).toBe(false)
  })
})

