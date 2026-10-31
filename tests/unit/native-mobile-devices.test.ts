import { expect, test } from 'bun:test'
import type { DeviceState, DeviceHostConfig } from '@solus/contracts/device-types'
import { NativeDevices } from '../../apps/mobile/src/features/devices/native-devices'
import { createHostWorld, FakeApi, flushPromises, healthFetch } from './helpers/native-mobile-fakes'

const snapshot = (revision: number): DeviceState => ({ revision, settings: { enabled: true, agentAccessEnabled: true, onboardingCompleted: true, autoShowAgentDevices: true }, hosts: [], hostStatuses: [], devices: [], previews: [], booting: [], controls: [], builds: [], runs: [] })
async function setup() {
  let state = snapshot(5)
  const api = new FakeApi().on('deviceState', () => state).on('deviceList', () => state)
  const world = createHostWorld({ fetch: healthFetch({ 'https://host.test': 'inst-a' }), api: () => api })
  await world.registry.load()
  await world.registry.savePaired({ id: 'inst-a', label: 'Host', url: 'https://host.test' }, 'host-token')
  const devices = new NativeDevices((hostId) => world.connections.connection(hostId))
  await devices.load('inst-a')
  return { ...world, api, devices, setState: (value: DeviceState) => { state = value } }
}

test('native cloud device settings use the selected host, and older events cannot replace its state', async () => {
  const { devices, api, transports } = await setup()
  const config: DeviceHostConfig = { kind: 'simlock', id: 'pool', label: 'Pool', gatewayUrl: 'https://pool.test', agentToken: 'new-token', maxLeases: 2, maxLeaseMinutes: 60 }
  api.on('deviceHostSave', () => snapshot(6))
  await devices.save('inst-a', config)
  expect(api.callsOf('deviceHostSave')).toEqual([[config]])
  transports[0]!.emit('device.stateChanged', { state: snapshot(7) })
  transports[0]!.emit('device.stateChanged', { state: snapshot(4) })
  expect(devices.stateOf('inst-a')?.revision).toBe(7)
  devices.forgetHost('inst-a')
  transports[0]!.emit('device.stateChanged', { state: snapshot(9) })
  expect(devices.stateOf('inst-a')).toBeUndefined()
})

test('a restarted host can replace a native device snapshot with a lower revision', async () => {
  const { devices, transports, setState } = await setup()
  await transports[0]!.accept()
  await flushPromises()
  setState(snapshot(0))
  await transports[0]!.accept()
  await flushPromises()
  expect(devices.stateOf('inst-a')?.revision).toBe(0)
  devices.forgetHost('inst-a')
})

test('native device streams use the connected host origin', async () => {
  const { devices, api } = await setup()
  api.on('deviceStreamUrl', () => ({ path: '/api/device-hub/signed', platform: 'ios', cloud: true }))
  expect(await devices.streamUrl('inst-a', { deviceHostId: 'expo', deviceId: 'session-1' })).toBe('https://host.test/api/device-hub/signed')
  devices.forgetHost('inst-a')
})
