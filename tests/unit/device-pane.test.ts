import { describe, expect, test } from 'bun:test'
import type { DeviceControlState, DevicePreview, DeviceState } from '@solus/contracts/device-types'
import { addableDevices, controlLabel, deviceLiveState, selectedPreview, unavailablePlatformReasons } from '@solus/workspace-ui/components/devices/lib/device-pane'
import { DeviceViewState } from '@solus/workspace-ui/components/devices/lib/device-view-state.svelte'

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

  test('the picker offers only devices not already open in the session', () => {
    // A connected phone is never offered: nothing can stream its screen. It takes builds instead.
    const groups = addableDevices(state, 's1')
    expect(groups.map((group) => group.devices.map((device) => device.deviceId))).toEqual([['B']])
    expect(addableDevices(state, 'other')[0]!.devices.map((device) => device.deviceId)).toEqual(['A', 'B'])
  })

  test('a platform no host can run is explained', () => {
    expect(unavailablePlatformReasons(state)).toEqual(['Android: No SDK'])
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
    expect(controlLabel({ ...agent, pendingTakeover: { clientId: 'c', label: 'Alice' } }, false)).toContain("agent's current action")
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
