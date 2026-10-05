import { expect, mock, test } from 'bun:test'
import { DeviceFrameSubscriber } from '@solus/client-core/device-frame-subscriber'
import type { DeviceFrameHeader } from '@solus/contracts/device-types'

/**
 * One host subscription serves every surface on this client that shows a
 * device. The host sends the screen and its input generation once, at
 * subscribe; a surface that joins later must still learn it, or each of its
 * taps is refused with "The device screen changed".
 */

const frames = new DeviceFrameSubscriber()
const subscribes: string[] = []
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    apiFor: () => ({
      deviceSubscribeFrames: async (request: { format: string }) => { subscribes.push(request.format) },
      deviceUnsubscribeFrames: async () => {},
    }),
    deviceFramesFor: () => frames,
    onStatusChange: () => () => {},
  },
}))
const { DevicesStore } = await import('@solus/workspace-ui/contexts/devices/devices.store.svelte')

test('a surface that joins a running watch gets the current screen generation', () => {
  const store = new DevicesStore()
  const target = { deviceHostId: 'local', deviceId: 'SIM-1' }
  const first: DeviceFrameHeader[] = []
  const stopFirst = store.watchFrames('host-a', target, 'jpeg', (header) => first.push(header), () => {})
  frames.receive({ deviceHostId: 'local', deviceId: 'SIM-1', streamGeneration: 1, seq: 1, kind: 'screen', screenGeneration: 2, screen: { width: 10, height: 20, orientation: 'portrait' } }, new Uint8Array())

  const second: DeviceFrameHeader[] = []
  const stopSecond = store.watchFrames('host-a', target, 'jpeg', (header) => second.push(header), () => {})
  expect(subscribes).toEqual(['jpeg'])
  expect(second.map((header) => [header.kind, header.screenGeneration])).toEqual([['screen', 2]])
  expect(first).toHaveLength(1)
  stopFirst()
  stopSecond()
})
