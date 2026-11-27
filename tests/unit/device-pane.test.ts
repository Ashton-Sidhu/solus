import { afterAll, describe, expect, test } from 'bun:test'
import type { DeviceControlState, DevicePreview, DeviceState } from '@solus/contracts/device-types'
import { controlLabel, deviceLiveState, pickerDevices, previewGroups, selectedPreview, unavailablePlatforms } from '@solus/workspace-ui/components/devices/lib/device-pane'
// These tests verify stored choices, without a mounted Svelte renderer.
const stateDescriptor = Object.getOwnPropertyDescriptor(globalThis, '$state')
Object.defineProperty(globalThis, '$state', { configurable: true, value: <T>(value: T) => value })
const { DeviceViewState } = await import('@solus/workspace-ui/components/devices/lib/device-view-state.svelte')
afterAll(() => {
  if (stateDescriptor) Object.defineProperty(globalThis, '$state', stateDescriptor)
  else Reflect.deleteProperty(globalThis, '$state')
})

/**
 * The Devices pane's derivations (P04): tabs come from the host's previews,
 * a remembered selection that was closed falls back instead of reopening it,
 * and control is stated honestly.
 */

const preview = (devicePreviewId: string, deviceId: string): DevicePreview => ({
  devicePreviewId, sessionId: 's1', deviceHostId: 'local', deviceId, platform: 'ios', openedAt: 1, openedBy: 'user',
})

const state: DeviceState = {
  revision: 3,
  settings: { enabled: true, agentAccessEnabled: false, onboardingCompleted: true, autoShowAgentDevices: true },
  hosts: [
    { deviceHostId: 'local', kind: 'local', label: 'This machine', platforms: [{ platform: 'ios', available: true }, { platform: 'android', available: false, reason: 'No SDK' }], hubInstalled: true, agentDeviceInstalled: false },
  ],
  hostStatuses: [{ deviceHostId: 'local', status: 'ready' }],
  devices: [
    { deviceHostId: 'local', deviceId: 'A', platform: 'ios', name: 'iPhone 16', version: 'iOS 18', booted: true, physical: false },
    { deviceHostId: 'local', deviceId: 'B', platform: 'ios', name: 'iPad Air', version: 'iOS 18', booted: false, physical: false },
    { deviceHostId: 'local', deviceId: 'PHONE', platform: 'ios', name: 'Ash iPhone', version: 'iOS 26', booted: true, physical: true },
  ],
  previews: [preview('p1', 'A')],
  booting: [],
  controls: [],
  builds: [],
}

describe('device pane', () => {
  test('a remembered tab that was closed falls back to the newest open one', () => {
    const previews = [preview('p1', 'A'), preview('p2', 'B')]
    expect(selectedPreview(previews, 'p1')?.devicePreviewId).toBe('p1')
    expect(selectedPreview(previews, 'closed')?.devicePreviewId).toBe('p2')
    expect(selectedPreview([], 'p1')).toBeNull()
  })

  test('the picker lists every simulator, and one already open in the session links to its tab', () => {
    // An open device stays in the list, so the picker never looks empty while a simulator exists.
    // A connected phone is never offered: nothing can stream its screen. It takes builds instead.
    const rows = (sessionId: string) => pickerDevices(state, sessionId).map((group) => group.devices.map((entry) => [entry.device.deviceId, entry.devicePreviewId]))
    expect(rows('s1')).toEqual([[['A', 'p1'], ['B', null]]])
    expect(rows('other')).toEqual([[['A', null], ['B', null]]])
  })

  test('device tabs group under their host in opening order, like browser pages under their branch', () => {
    // A host that left the snapshot still shows its tabs, under its id, so a tab never disappears from the strip.
    const remote: DevicePreview = { ...preview('p3', 'C'), deviceHostId: 'studio' }
    const groups = previewGroups(state, [preview('p1', 'A'), remote, preview('p2', 'B')])
    expect(groups.map((group) => [group.label, group.previews.map((entry) => entry.devicePreviewId)])).toEqual([
      ['This machine', ['p1', 'p2']],
      ['studio', ['p3']],
    ])
  })

  test('a platform no host can run is explained', () => {
    expect(unavailablePlatforms(state)).toEqual([{ platform: 'Android', reason: 'No SDK' }])
  })

  test('live state and control are stated honestly', () => {
    expect(deviceLiveState(state.devices[1], false, { deviceHostId: 'local', status: 'ready' })).toBe('stopped')
    expect(deviceLiveState(state.devices[0], true, undefined)).toBe('booting')
    expect(deviceLiveState(state.devices[0], false, { deviceHostId: 'local', status: 'failed' })).toBe('offline')
    const agent: DeviceControlState = {
      deviceHostId: 'local', deviceId: 'A', agentPaused: false,
      lease: { deviceHostId: 'local', deviceId: 'A', holder: { kind: 'agent', sessionId: 's1', label: 'Claude agent' }, generation: 7, expiresAt: 10 },
    }
    expect(controlLabel(agent, false)).toBe('Claude agent has control')
    expect(controlLabel({ ...agent, lease: null, agentPaused: true }, false)).toBe('Agent actions paused')
  })

  test('a rename changes the tab label only and survives selection changes', () => {
    const view = new DeviceViewState()
    view.rename('host', 's1', 'p1', '  Checkout flow  ')
    view.select('host', 's1', 'p2')
    expect(view.name('host', 's1', 'p1')).toBe('Checkout flow')
    expect(view.selected('host', 's1')).toBe('p2')
    view.rename('host', 's1', 'p1', '')
    expect(view.name('host', 's1', 'p1')).toBeUndefined()
  })
})
