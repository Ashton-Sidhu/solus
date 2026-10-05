import { expect, mock, test } from 'bun:test'
import { DeviceFrameSubscriber } from '@solus/client-core/device-frame-subscriber'
import { deviceBuildTargets } from '@solus/client-core/device-builds'
import type { DeviceBuild, DeviceState, DeviceSummary } from '@solus/contracts/device-types'

/**
 * One click from a build to the app on a device the person can see
 * (plan 016, S02). A stopped emulator boots and opens beside the
 * conversation, the build goes onto the device that actually booted, and the
 * pane shows that device rather than the build list.
 */

const calls: string[] = []
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    apiFor: () => ({
      // An AVD boots under a new id: its emulator serial.
      deviceOpen: async (request: { deviceId: string }) => {
        calls.push(`open ${request.deviceId}`)
        return { devicePreviewId: 'devp_1', sessionId: 's1', deviceHostId: 'local', deviceId: 'emulator-5554', platform: 'android', openedAt: 1, openedBy: 'user' }
      },
      deviceControlAcquire: async (target: { deviceId: string }) => {
        calls.push(`acquire ${target.deviceId}`)
        return { status: 'granted', lease: { deviceHostId: 'local', deviceId: target.deviceId, holder: { kind: 'user', clientId: 'c', label: 'Me' }, generation: 4, expiresAt: 0 }, control: { deviceHostId: 'local', deviceId: target.deviceId, lease: null, agentPaused: false } }
      },
      deviceInstall: async (request: { deviceId: string; controlGeneration: number }) => { calls.push(`install ${request.deviceId} @${request.controlGeneration}`) },
      deviceControlRelease: async (target: { deviceId: string }) => { calls.push(`release ${target.deviceId}`) },
    }),
    deviceFramesFor: () => new DeviceFrameSubscriber(),
    onStatusChange: () => () => {},
  },
}))
const { runDeviceBuild } = await import('@solus/workspace-ui/components/devices/lib/run-build')
const { deviceViewState } = await import('@solus/workspace-ui/components/devices/lib/device-view-state.svelte')

const apk: DeviceBuild = { buildId: 'b1', platform: 'android', runsOn: 'any', appId: 'dev.solus.demo', name: 'app-debug.apk', sessionId: 's1', sizeBytes: 1, createdAt: 0, assetId: 'a.apk', lastInstall: null }
const avd: DeviceSummary = { deviceHostId: 'local', deviceId: 'Pixel_9', platform: 'android', name: 'Pixel_9', version: 'Android', booted: false, physical: false }

test('a stopped emulator is offered only where the client can start it', () => {
  const state: DeviceState = { revision: 1, settings: { enabled: true, agentAccessEnabled: true, onboardingCompleted: true, autoShowAgentDevices: true }, hosts: [], hostStatuses: [], devices: [avd], previews: [], booting: [], controls: [], builds: [apk] }
  expect(deviceBuildTargets(state, apk, { canBoot: true }).map((device) => device.deviceId)).toEqual(['Pixel_9'])
  // The mobile app shows no simulators, so it cannot start one for the person to see.
  expect(deviceBuildTargets(state, apk)).toEqual([])
})

test('run boots the emulator, installs on the device that booted, and shows it', async () => {
  deviceViewState.showBuilds('host-a', true)
  const shown: [string | undefined, string | undefined][] = []
  await runDeviceBuild({ openDevices: (sessionId?: string, serverId?: string) => shown.push([sessionId, serverId]) }, 'host-a', 's1', apk, avd)
  expect(calls).toEqual(['open Pixel_9', 'acquire emulator-5554', 'install emulator-5554 @4', 'release emulator-5554'])
  expect(deviceViewState.selected('host-a', 's1')).toBe('devp_1')
  // WHY: the point of the click is to see the app, not the build list.
  expect(deviceViewState.isShowingBuilds('host-a')).toBe(false)
  expect(shown).toEqual([['s1', 'host-a']])
})
