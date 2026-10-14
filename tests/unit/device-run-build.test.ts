import { afterAll, expect, mock, test } from 'bun:test'
// The view state is read without a mounted Svelte renderer.
const stateDescriptor = Object.getOwnPropertyDescriptor(globalThis, '$state')
Object.defineProperty(globalThis, '$state', { configurable: true, value: <T>(value: T) => value })
afterAll(() => {
  if (stateDescriptor) Object.defineProperty(globalThis, '$state', stateDescriptor)
  else Reflect.deleteProperty(globalThis, '$state')
})
import type { DeviceBuild, DeviceSummary } from '@solus/contracts/device-types'

/**
 * One click from a build to the app on a device the person can see
 * (plan 016, S02). A stopped emulator boots and opens beside the
 * conversation, the build goes onto the device that actually booted, and the
 * pane shows that device.
 */

const calls: string[] = []
// The devices store reports finished builds with toasts; this test only installs.
mock.module('@solus/workspace-ui/lib/toasts', () => ({ toasts: { show: () => {}, error: () => {}, success: () => {} } }))
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
        return { lease: { deviceHostId: 'local', deviceId: target.deviceId, holder: { kind: 'user', clientId: 'c', label: 'Me' }, generation: 4, expiresAt: 0 }, control: { deviceHostId: 'local', deviceId: target.deviceId, lease: null, agentPaused: false } }
      },
      deviceInstall: async (request: { deviceId: string }) => { calls.push(`install ${request.deviceId}`) },
      deviceControlRelease: async (target: { deviceId: string }) => { calls.push(`release ${target.deviceId}`) },
    }),
    onStatusChange: () => () => {},
  },
}))
const { runDeviceBuild } = await import('@solus/workspace-ui/components/devices/lib/run-build')
const { deviceViewState } = await import('@solus/workspace-ui/components/devices/lib/device-view-state.svelte')

const apk: DeviceBuild = { buildId: 'b1', platform: 'android', runsOn: 'any', appId: 'dev.solus.demo', name: 'app-debug.apk', sessionId: 's1', sizeBytes: 1, createdAt: 0, assetId: 'a.apk', lastInstall: null }
const avd: DeviceSummary = { deviceHostId: 'local', deviceId: 'Pixel_9', platform: 'android', name: 'Pixel_9', version: 'Android', booted: false, physical: false }

test('run boots the emulator, installs on the device that booted, and shows it', async () => {
  const shown: [string | undefined, string | undefined][] = []
  await runDeviceBuild({ openDevices: (sessionId?: string, serverId?: string) => shown.push([sessionId, serverId]) }, 'host-a', 's1', apk, avd)
  expect(calls).toEqual(['open Pixel_9', 'acquire emulator-5554', 'install emulator-5554', 'release emulator-5554'])
  expect(deviceViewState.selected('host-a', 's1')).toBe('devp_1')
  expect(shown).toEqual([['s1', 'host-a']])
})
