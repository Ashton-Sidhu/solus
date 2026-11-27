import { expect, mock, test } from 'bun:test'
import type { DeviceShutdownRequest, DeviceState, DeviceSummary } from '@solus/contracts/device-types'

function device(deviceId: string, props: Partial<DeviceSummary> = {}): DeviceSummary {
  return {
    deviceHostId: 'local', deviceId, platform: 'ios', name: deviceId,
    version: '18', booted: true, physical: false, ...props,
  }
}

const requests: Array<{ serverId: string; action: string; target: DeviceShutdownRequest }> = []
mock.module('@solus/workspace-ui/lib/toasts', () => ({ toasts: {} }))
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    serverIds: () => [],
    onConnectionCreated: () => {},
    onReadinessChange: () => {},
    apiFor: (serverId: string) => ({
      deviceControlAcquire: async (target: DeviceShutdownRequest) => {
        requests.push({ serverId, action: 'acquire', target })
        return { lease: { generation: 1 } }
      },
      deviceShutdown: async (target: DeviceShutdownRequest) => {
        requests.push({ serverId, action: 'shutdown', target })
        if (target.deviceHostId === 'ssh') throw new Error('The device host refused shutdown.')
      },
    }),
  },
}))
const { DevicesStore } = await import('@solus/workspace-ui/contexts/devices/devices.store.svelte')

test('Stop all tries each running virtual device, respects control, and reports partial failure', async () => {
  const store = new DevicesStore()
  const simulator = device('Simulator')
  const agentDevice = device('Agent simulator')
  const emulator = device('Emulator', { platform: 'android' })
  const remote = device('Simulator', { deviceHostId: 'ssh' })
  const phone = device('Phone', { physical: true })
  const stopped = device('Stopped simulator', { booted: false })
  const state: DeviceState = {
    revision: 1,
    settings: { enabled: true, agentAccessEnabled: true, onboardingCompleted: true, autoShowAgentDevices: true },
    hosts: [], hostStatuses: [], booting: [], builds: [], runs: [],
    devices: [simulator, agentDevice, remote, emulator, phone, stopped],
    previews: [{
      devicePreviewId: 'preview', sessionId: 'session', deviceHostId: 'local',
      deviceId: simulator.deviceId, platform: 'ios', openedAt: 1, openedBy: 'user',
    }],
    controls: [{
      deviceHostId: 'local', deviceId: agentDevice.deviceId, agentPaused: false,
      lease: {
        deviceHostId: 'local', deviceId: agentDevice.deviceId, generation: 1, expiresAt: Date.now() + 60_000,
        holder: { kind: 'agent', sessionId: 'session', label: 'Agent' },
      },
    }],
  }
  store.states.set('host-a', state)
  expect(store.runningVirtualDevices('host-a')).toEqual([simulator, agentDevice, remote, emulator])

  const stopping = store.stopFromList('host-a', state.devices)
  expect(store.isStoppingFromList('host-a')).toBe(true)
  expect(store.isStoppingFromList('host-b')).toBe(false)
  await store.stopFromList('host-a', [emulator])
  await stopping

  expect(requests.map(({ serverId, action, target }) => [serverId, action, target.deviceHostId, target.deviceId])).toEqual([
    ['host-a', 'acquire', 'local', 'Simulator'],
    ['host-a', 'shutdown', 'local', 'Simulator'],
    ['host-a', 'acquire', 'ssh', 'Simulator'],
    ['host-a', 'shutdown', 'ssh', 'Simulator'],
    ['host-a', 'acquire', 'local', 'Emulator'],
    ['host-a', 'shutdown', 'local', 'Emulator'],
  ])
  expect(store.stopFailures.get('host-a')).toEqual([
    'Agent simulator: Agent is controlling this device. Take control first.',
    'Simulator: The device host refused shutdown.',
  ])
  expect(store.stopFailures.has('host-b')).toBe(false)
  expect(store.isStoppingFromList('host-a')).toBe(false)

  requests.length = 0
  await store.stopFromList('host-a', [emulator])
  expect(requests.map(({ action, target }) => [action, target.deviceId])).toEqual([['acquire', 'Emulator'], ['shutdown', 'Emulator']])
  expect(store.stopFailures.has('host-a')).toBe(false)
})
