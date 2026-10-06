import { describe, expect, test } from 'bun:test'
import type { DeviceRun, DeviceSummary } from '@solus/contracts/device-types'
import {
  RUN_PROFILE_PRESETS,
  joinCommand,
  phoneTarget,
  profileDraft,
  profilesForDevice,
  profilesFromDrafts,
  shownRun,
  splitCommand,
} from '@solus/workspace-ui/components/devices/lib/run-profiles'

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

  test('a simulator offers to push the device profile to a connected phone, and says why when the phone cannot take it', () => {
    const profiles = RUN_PROFILE_PRESETS.map((preset) => preset.profile)
    expect(phoneTarget([simulator, phone], profiles, simulator)).toEqual({ phone, profile: profiles[1]! })
    // WHY: without a phone, or without a device profile, there is nothing to push; the button stays away.
    expect(phoneTarget([simulator], profiles, simulator)).toBeNull()
    expect(phoneTarget([simulator, phone], [profiles[0]!], simulator)).toBeNull()
    // A phone on an SSH device host cannot take a build; the phone's own toolbar never shows this button.
    expect(phoneTarget([simulator, { ...phone, deviceHostId: 'mac-mini' }], profiles, simulator)).toBeNull()
    expect(phoneTarget([simulator, phone], profiles, phone)).toBeNull()
    // A ready phone wins over a locked one; a lone locked phone keeps its reason for the button.
    const locked = { ...phone, deviceId: 'PHONE-2', unavailableReason: 'Unlock Ash iPhone.' }
    expect(phoneTarget([locked, phone], profiles, simulator)?.phone).toBe(phone)
    expect(phoneTarget([locked], profiles, simulator)?.phone.unavailableReason).toBe('Unlock Ash iPhone.')
  })

  test('the editor names the first problem and refuses two profiles with one name', () => {
    const draft = profileDraft(RUN_PROFILE_PRESETS[2]!.profile)
    expect(profilesFromDrafts([{ ...draft, commandText: '  ' }])).toEqual({ error: 'Android debug needs a command.' })
    expect(profilesFromDrafts([draft, draft])).toEqual({ error: 'Two profiles are named "Android debug". Give each its own name.' })
    const saved = profilesFromDrafts([{ ...draft, cwd: '', appId: ' com.example.app ' }])
    expect(saved).toEqual({ profiles: [{ ...RUN_PROFILE_PRESETS[2]!.profile, cwd: '.', appId: 'com.example.app' }] })
  })

  test('the toolbar shows a build in progress, or the last one when it failed', () => {
    const run = (stage: DeviceRun['stage']): DeviceRun => ({ runId: stage, profileName: 'iOS simulator', checkout: 'app', branch: 'main', deviceHostId: 'local', deviceId: 'SIM-1', deviceName: 'iPhone 17', stage, lastLine: null, error: null, buildId: null, startedAt: 1, endedAt: null })
    expect(shownRun([run('building')], simulator)?.stage).toBe('building')
    expect(shownRun([run('failed')], simulator)?.stage).toBe('failed')
    // A finished run leaves the button free for the next one.
    expect(shownRun([run('done'), run('failed')], simulator)).toBeNull()
    expect(shownRun([run('building')], phone)).toBeNull()
  })
})
