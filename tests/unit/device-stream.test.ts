import { describe, expect, test } from 'bun:test'
import type { DeviceFrameHeader } from '@solus/contracts/device-types'
import { DeviceFrameChannel } from '@solus/server/devices/device-frame-channel'
import { DeviceStreams } from '@solus/server/devices/device-streams'
import { coalesce, SLOW_CLIENT_BUFFERED_PACKETS } from '@solus/server/devices/device-link'
import type { DeviceUpstream, UpstreamSocketHandlers } from '@solus/server/devices/device-upstream'
import { MjpegSplitter } from '@solus/server/devices/device-upstream'
import { DeviceDomainError } from '@solus/server/devices/device-errors'

/**
 * The host relays hub video to watching clients (plan 016, stage 2). These
 * tests replay fixture bytes through a fake hub and encode the rules that
 * keep streams correct and cheap: joiners start decodable, slow clients skip
 * to the next keyframe instead of decoding garbage, upstream stops when the
 * last watcher leaves, and a disconnect never leaves a touch held.
 */

function envelope(tag: number, payload: number[]): Uint8Array {
  const out = new Uint8Array(5 + payload.length)
  new DataView(out.buffer).setUint32(0, payload.length + 1, false)
  out[4] = tag
  out.set(payload, 5)
  return out
}

const DESCRIPTION = envelope(1, [1, 0x64, 0x00, 0x33])
const KEY = envelope(2, [0, 0, 0, 1, 0x65])
const DELTA = envelope(3, [0, 0, 0, 1, 0x41])

class FakeHub implements DeviceUpstream {
  bodies: { url: string; push: (chunk: Uint8Array) => void; end: () => void; aborted: boolean }[] = []
  sockets: { url: string; sent: (string | Uint8Array)[]; handlers: UpstreamSocketHandlers; closed: boolean }[] = []
  readBody(url: string, signal: AbortSignal, onChunk: (chunk: Uint8Array) => void): Promise<void> {
    return new Promise((resolve) => {
      const body = { url, push: onChunk, end: () => resolve(), aborted: false }
      this.bodies.push(body)
      signal.addEventListener('abort', () => { body.aborted = true; resolve() })
    })
  }

  openSocket(url: string, handlers: UpstreamSocketHandlers) {
    const socket = { url, sent: [] as (string | Uint8Array)[], handlers, closed: false }
    this.sockets.push(socket)
    queueMicrotask(() => handlers.onOpen())
    return { send: (data: string | Uint8Array) => socket.sent.push(data), close: () => { socket.closed = true } }
  }

  body(fragment: string) {
    return this.bodies.findLast((body) => body.url.includes(fragment) && !body.aborted)
  }

  /** serve-sim capture starts after one MJPEG read; answer the prime. */
  async prime() {
    await flush()
    this.bodies.find((body) => body.url.endsWith('stream.mjpeg') && !body.aborted)?.push(new Uint8Array([0]))
    await flush()
    await flush()
  }
}

function harness(platform: 'ios' | 'android' = 'ios') {
  const channel = new DeviceFrameChannel()
  const hub = new FakeHub()
  const streams = new DeviceStreams(channel, hub, () => 1_000)
  const received = new Map<string, DeviceFrameHeader[]>()
  const pressure = new Map<string, number>()
  const register = (clientId: string) => {
    received.set(clientId, [])
    channel.register(clientId, {
      send: (header) => received.get(clientId)!.push(header),
      buffered: () => pressure.get(clientId) ?? 0,
    })
  }
  const target = { deviceHostId: 'local', deviceId: platform === 'ios' ? 'SIM-1' : 'emulator-5554', platform, hubOrigin: 'http://127.0.0.1:9' }
  const kinds = (clientId: string) => received.get(clientId)!.map((header) => header.kind)
  return { channel, hub, streams, register, received, pressure, target, kinds }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('device streams', () => {
  test('arbitrary chunk splits reach the client as whole packets', async () => {
    const { hub, streams, register, target, kinds, received } = harness()
    register('a')
    streams.subscribe('a', target, 'h264')
    await flush()
    const bytes = new Uint8Array([...DESCRIPTION, ...KEY, ...DELTA])
    const body = hub.body('stream.avcc')!
    for (let i = 0; i < bytes.length; i += 3) body.push(bytes.subarray(i, i + 3))
    expect(kinds('a').filter((kind) => kind !== 'screen')).toEqual(['config', 'key', 'delta'])
    const config = received.get('a')!.find((header) => header.kind === 'config')!
    expect(config.codec).toBe('avc1.640033')
    expect(config.format).toBe('avcc')
  })

  test('a mid-stream joiner gets config and the keyframe group, never a bare delta', async () => {
    const { hub, streams, register, target, kinds } = harness()
    register('a')
    register('b')
    streams.subscribe('a', target, 'h264')
    await flush()
    const body = hub.body('stream.avcc')!
    body.push(DESCRIPTION)
    body.push(KEY)
    body.push(DELTA)
    streams.subscribe('b', target, 'h264')
    body.push(DELTA)
    expect(kinds('b').filter((kind) => kind !== 'screen')).toEqual(['config', 'key', 'delta', 'delta'])
  })

  test('a slow client skips deltas until the next keyframe', async () => {
    // WHY: one dropped delta corrupts every later frame until a keyframe.
    const { hub, streams, register, target, kinds, pressure } = harness()
    register('a')
    streams.subscribe('a', target, 'h264')
    await flush()
    const body = hub.body('stream.avcc')!
    body.push(DESCRIPTION)
    body.push(KEY)
    pressure.set('a', SLOW_CLIENT_BUFFERED_PACKETS + 1)
    body.push(DELTA)
    pressure.set('a', 0)
    body.push(DELTA)
    body.push(KEY)
    body.push(DELTA)
    expect(kinds('a').filter((kind) => kind !== 'screen')).toEqual(['config', 'key', 'key', 'delta'])
  })

  test('H.264 and MJPEG clients share a device without breaking each other', async () => {
    const { hub, streams, register, target, kinds } = harness()
    register('desktop')
    register('phone')
    streams.subscribe('desktop', target, 'h264')
    await hub.prime()
    streams.subscribe('phone', target, 'jpeg')
    await flush()
    hub.body('stream.avcc')!.push(new Uint8Array([...DESCRIPTION, ...KEY]))
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9])
    hub.body('/helper/SIM-1/stream.mjpeg')!.push(new Uint8Array([...new TextEncoder().encode('--frame\r\nContent-Type: image/jpeg\r\n\r\n'), ...jpeg]))
    expect(kinds('desktop').filter((kind) => kind !== 'screen')).toEqual(['config', 'key'])
    expect(kinds('phone').filter((kind) => kind !== 'screen')).toEqual(['jpeg'])
  })

  test('the last watcher leaving stops upstream video', async () => {
    // WHY: an unwatched simulator must cost no capture, network or decode.
    const { hub, streams, register, target } = harness()
    register('a')
    streams.subscribe('a', target, 'h264')
    await flush()
    const body = hub.body('stream.avcc')!
    streams.unsubscribe('a', target)
    expect(body.aborted).toBe(true)
    expect(streams.get(target)).toBeUndefined()
  })

  test('an expired client stops receiving and its held touch is released', async () => {
    const { hub, streams, register, target } = harness()
    register('a')
    register('b')
    streams.subscribe('a', target, 'h264')
    streams.subscribe('b', target, 'h264')
    await hub.prime()
    const socket = hub.sockets.find((entry) => entry.url.includes('/helper/ws'))!
    await streams.input('a', target, [{ kind: 'pointer', phase: 'down', x: 0.5, y: 0.5 }], 0)
    await streams.dropClient('a')
    const last = socket.sent.at(-1) as Uint8Array
    expect(JSON.parse(new TextDecoder().decode(last.subarray(1)))).toMatchObject({ type: 'end' })
    expect(streams.watchers(target)).toEqual(['b'])
  })

  test('pointer input from an old screen is refused', async () => {
    const { hub, streams, register, target } = harness()
    register('a')
    streams.subscribe('a', target, 'h264')
    await hub.prime()
    const socket = hub.sockets.find((entry) => entry.url.includes('/helper/ws'))!
    const config = new TextEncoder().encode(JSON.stringify({ width: 100, height: 200, orientation: 'portrait' }))
    socket.handlers.onMessage(new Uint8Array([0x82, ...config]))
    expect(streams.screenGeneration(target)).toBe(1)
    const error = await streams.input('a', target, [{ kind: 'pointer', phase: 'down', x: 0.1, y: 0.1 }], 0).catch((caught) => caught)
    expect(error).toBeInstanceOf(DeviceDomainError)
    expect((error as DeviceDomainError).code).toBe('stale_generation')
  })

  test('a refused touch tells that client the current screen, so the next one lands', async () => {
    // WHY: a client that missed the screen change would otherwise fail every
    // touch with "The device screen changed" until it reopens the device.
    const { hub, streams, register, target, received } = harness()
    register('a')
    streams.subscribe('a', target, 'h264')
    await hub.prime()
    const socket = hub.sockets.find((entry) => entry.url.includes('/helper/ws'))!
    const config = new TextEncoder().encode(JSON.stringify({ width: 100, height: 200, orientation: 'portrait' }))
    socket.handlers.onMessage(new Uint8Array([0x82, ...config]))
    received.get('a')!.length = 0
    await streams.input('a', target, [{ kind: 'pointer', phase: 'down', x: 0.1, y: 0.1 }], 0).catch(() => {})
    const resent = received.get('a')!.filter((header) => header.kind === 'screen')
    expect(resent.map((header) => header.screenGeneration)).toEqual([1])
    await streams.input('a', target, [{ kind: 'pointer', phase: 'down', x: 0.1, y: 0.1 }], resent[0]!.screenGeneration!)
  })

  test('Android SEMU video is configured from its SPS and rotation restarts the decoder', async () => {
    const { hub, streams, register, target, kinds, received } = harness('android')
    register('a')
    streams.subscribe('a', target, 'h264')
    const socket = hub.sockets[0]!
    socket.handlers.onMessage(new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1e, 0, 0, 1, 0x65, 0x88]))
    socket.handlers.onMessage(new Uint8Array([0, 0, 1, 0x41, 0x9a]))
    socket.handlers.onMessage(JSON.stringify({ type: 'video-session' }))
    expect(kinds('a')).toEqual(['screen', 'config', 'key', 'delta', 'screen'])
    expect(received.get('a')!.find((header) => header.kind === 'config')?.format).toBe('annexb')
    expect(socket.sent.some((message) => typeof message === 'string' && message.includes('reset-video'))).toBe(true)
  })

  test('Android cannot be watched as MJPEG', () => {
    const { streams, register, target } = harness('android')
    register('a')
    expect(() => streams.subscribe('a', target, 'jpeg')).toThrow(DeviceDomainError)
  })

  test('a recorder keeps upstream video alive with no visible client', async () => {
    const { hub, streams, register, target } = harness()
    register('a')
    const packets: string[] = []
    const sink = { onPacket: (header: DeviceFrameHeader) => packets.push(header.kind) }
    streams.subscribe('a', target, 'h264')
    streams.addSink(target, sink)
    await flush()
    streams.unsubscribe('a', target)
    const body = hub.body('stream.avcc')!
    expect(body.aborted).toBe(false)
    body.push(new Uint8Array([...DESCRIPTION, ...KEY]))
    expect(packets.filter((kind) => kind !== 'screen')).toEqual(['config', 'key'])
    streams.removeSink(target, sink)
    expect(body.aborted).toBe(true)
  })

  test('ending a device tells every watcher why', async () => {
    const { streams, register, target, received } = harness()
    register('a')
    streams.subscribe('a', target, 'h264')
    streams.end(() => true, 'The device was shut down.')
    expect(received.get('a')!.at(-1)).toMatchObject({ kind: 'ended', detail: 'The device was shut down.' })
  })
})

describe('input coalescing', () => {
  test('moves collapse to the last; down and up are never dropped', () => {
    const result = coalesce([
      { kind: 'pointer', phase: 'down', x: 0, y: 0 },
      { kind: 'pointer', phase: 'move', x: 0.1, y: 0 },
      { kind: 'pointer', phase: 'move', x: 0.2, y: 0 },
      { kind: 'pointer', phase: 'up', x: 0.2, y: 0 },
    ])
    expect(result.map((input) => (input.kind === 'pointer' ? `${input.phase}:${input.x}` : input.kind))).toEqual(['down:0', 'move:0.2', 'up:0.2'])
  })
})

describe('MJPEG splitter', () => {
  test('parts split across chunks become whole images', () => {
    const part = (bytes: number[]) => new Uint8Array([...new TextEncoder().encode(`--b\r\nContent-Type: image/jpeg\r\nContent-Length: ${bytes.length}\r\n\r\n`), ...bytes, 13, 10])
    const stream = new Uint8Array([...part([0xff, 0xd8, 0xff, 0xd9, 7, 0xff, 0xd9]), ...part([0xff, 0xd8, 9, 0xff, 0xd9])])
    for (let split = 1; split < stream.length; split += 5) {
      const splitter = new MjpegSplitter()
      const images = [...splitter.push(stream.subarray(0, split)), ...splitter.push(stream.subarray(split))]
      // The Content-Length wins over an embedded end marker.
      expect(images.map((image) => image.length)).toEqual([7, 5])
    }
  })
})
