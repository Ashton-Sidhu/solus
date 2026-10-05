import { describe, expect, test } from 'bun:test'
import { DeviceFrameSubscriber } from '@solus/client-core/device-frame-subscriber'
import { MAX_DEVICE_FRAME_BYTES } from '@solus/contracts/device-types'

/**
 * The client half of the device-frame channel: packets reach only the surface
 * showing that device on that device host, and malformed or oversized wire
 * input never reaches a decoder.
 */

const header = { deviceHostId: 'local', deviceId: 'SIM-1', streamGeneration: 1, seq: 1, kind: 'key' as const }

describe('device frame subscriber', () => {
  test('packets route by device host and device, not device id alone', () => {
    // WHY: device ids are unique only inside one device host.
    const subscriber = new DeviceFrameSubscriber()
    const local: number[] = []
    const remote: number[] = []
    subscriber.subscribe('local', 'SIM-1', (_header, data) => local.push(data.byteLength))
    subscriber.subscribe('studio', 'SIM-1', (_header, data) => remote.push(data.byteLength))
    subscriber.receive(header, new Uint8Array([1, 2]))
    expect(local).toEqual([2])
    expect(remote).toEqual([])
  })

  test('malformed headers and oversized packets are dropped', () => {
    const subscriber = new DeviceFrameSubscriber()
    const seen: string[] = []
    subscriber.subscribe('local', 'SIM-1', (value) => seen.push(value.kind))
    subscriber.receive({ ...header, kind: 'exec' as unknown as 'key' }, new Uint8Array([1]))
    subscriber.receive(header, new Uint8Array(MAX_DEVICE_FRAME_BYTES + 1))
    expect(seen).toEqual([])
  })

  test('a node Buffer view is copied to its exact bytes', () => {
    const subscriber = new DeviceFrameSubscriber()
    let received: number[] = []
    subscriber.subscribe('local', 'SIM-1', (_header, data) => { received = Array.from(data) })
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9])
    subscriber.receive(header, backing.subarray(2, 5))
    expect(received).toEqual([1, 2, 3])
  })

  test('unsubscribing the last listener stops delivery', () => {
    const subscriber = new DeviceFrameSubscriber()
    let count = 0
    const stop = subscriber.subscribe('local', 'SIM-1', () => { count++ })
    stop()
    subscriber.receive(header, new Uint8Array([1]))
    expect(count).toBe(0)
  })
})
