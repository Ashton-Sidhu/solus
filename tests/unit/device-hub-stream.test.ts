import { describe, expect, test } from 'bun:test'
import { coalesce, DeviceHubStream, DeviceStreamEnded, type DeviceVideoPacket } from '@solus/client-core/device-hub-stream'
import { MjpegSplitter, type DeviceUpstream, type UpstreamSocketHandlers } from '@solus/client-core/device-upstream'

/**
 * A client reads a device straight from the hub, through the host's signed
 * proxy (docs/plans/native-devices.md, D2). These tests replay fixture bytes
 * through a fake hub and encode the rules that keep a stream correct: whole
 * packets reach the decoder, every touch lands against the newest screen, a
 * screen change never leaves a finger pressed, and a refusal from the host
 * stops the stream with its reason.
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
const BASE = 'http://host/api/device-hub/token'

class FakeHub implements DeviceUpstream {
  bodies: { url: string; push: (chunk: Uint8Array) => void; aborted: boolean }[] = []
  sockets: { url: string; sent: (string | Uint8Array)[]; handlers: UpstreamSocketHandlers; closed: boolean }[] = []

  readBody(url: string, signal: AbortSignal, onChunk: (chunk: Uint8Array) => void): Promise<void> {
    return new Promise((resolve) => {
      const body = { url, push: onChunk, aborted: false }
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

  body(route: string) {
    return this.bodies.findLast((body) => body.url.endsWith(route) && !body.aborted)
  }

  /** serve-sim capture starts after one MJPEG read; answer the prime. */
  async prime() {
    await flush()
    this.body('video.mjpeg')?.push(new Uint8Array([0]))
    await flush()
    await flush()
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness(options: { platform?: 'ios' | 'android'; format?: 'h264' | 'jpeg'; openUrl?: () => Promise<string> } = {}) {
  const hub = new FakeHub()
  // Timers run when the test says so, never by a clock.
  const timers: { callback: () => void; cancelled: boolean }[] = []
  const elapse = () => {
    for (const timer of timers.splice(0)) if (!timer.cancelled) timer.callback()
  }
  const packets: DeviceVideoPacket[] = []
  let retries = 0
  const stream = new DeviceHubStream({
    platform: options.platform ?? 'ios',
    format: options.format ?? 'h264',
    openUrl: options.openUrl ?? (async () => BASE),
    onPacket: (packet) => packets.push(packet),
    upstream: hub,
    // A retry waits for the test, never for a clock.
    delay: () => { retries++; return new Promise(() => {}) },
    setTimer: (callback) => {
      const timer = { callback, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
  })
  stream.start()
  const kinds = () => packets.map((packet) => packet.kind)
  const touches = (socket: FakeHub['sockets'][number]) => socket.sent
    .filter((message): message is Uint8Array => message instanceof Uint8Array)
    .map((message) => JSON.parse(new TextDecoder().decode(message.subarray(1))) as { type?: string; x?: number; y?: number })
    .filter((message) => message.type === 'begin' || message.type === 'move' || message.type === 'end')
  return { hub, stream, packets, kinds, touches, elapse, retries: () => retries }
}

const screenConfig = (config: { width: number; height: number; orientation: string }) =>
  new Uint8Array([0x82, ...new TextEncoder().encode(JSON.stringify(config))])

describe('device hub stream', () => {
  test('arbitrary chunk splits reach the decoder as whole packets', async () => {
    const { hub, kinds, packets } = harness()
    await flush()
    const bytes = new Uint8Array([...DESCRIPTION, ...KEY, ...DELTA])
    const body = hub.body('video.avcc')!
    for (let i = 0; i < bytes.length; i += 3) body.push(bytes.subarray(i, i + 3))
    expect(kinds()).toEqual(['config', 'key', 'delta'])
    expect(packets[0]).toMatchObject({ codec: 'avc1.640033', format: 'avcc' })
  })

  test('a client without WebCodecs reads MJPEG', async () => {
    const { hub, kinds } = harness({ format: 'jpeg' })
    await hub.prime()
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9])
    hub.body('video.mjpeg')!.push(new Uint8Array([...new TextEncoder().encode('--frame\r\nContent-Type: image/jpeg\r\n\r\n'), ...jpeg]))
    expect(hub.body('video.avcc')).toBeUndefined()
    expect(kinds()).toEqual(['jpeg'])
  })

  test('a screen report during a tap does not break that tap', async () => {
    // WHY: serve-sim often reports its screen only after the first touch
    // starts capture. A first click must still reach the device as one tap.
    const { hub, stream, touches } = harness()
    await hub.prime()
    const socket = hub.sockets[0]!
    await stream.send([{ kind: 'pointer', phase: 'down', x: 0.5, y: 0.5 }])
    socket.handlers.onMessage(screenConfig({ width: 100, height: 200, orientation: 'portrait' }))
    await stream.send([{ kind: 'pointer', phase: 'up', x: 0.5, y: 0.5 }])
    expect(touches(socket).map((touch) => touch.type)).toEqual(['begin', 'end'])
  })

  test('a touch lands against the newest screen, never refused', async () => {
    // WHY: a rotated simulator streams its raw framebuffer; a touch on the
    // rotated picture must be mapped into that raw space.
    const { hub, stream, touches } = harness()
    await hub.prime()
    const socket = hub.sockets[0]!
    socket.handlers.onMessage(screenConfig({ width: 100, height: 200, orientation: 'landscape_left' }))
    await stream.send([{ kind: 'pointer', phase: 'down', x: 0.25, y: 0.75 }])
    expect(touches(socket)[0]).toMatchObject({ type: 'begin', x: 0.75, y: 0.75 })
  })

  test('a screen change releases a held touch on the device', async () => {
    // WHY: a touch held across a rotation cannot be mapped any more. Without
    // an end, the simulator keeps the finger pressed.
    const { hub, stream, touches } = harness()
    await hub.prime()
    const socket = hub.sockets[0]!
    await stream.send([{ kind: 'pointer', phase: 'down', x: 0.5, y: 0.5 }])
    socket.handlers.onMessage(screenConfig({ width: 200, height: 100, orientation: 'landscape_left' }))
    expect(touches(socket).map((touch) => touch.type)).toEqual(['begin', 'end'])
    // The finger's later moves belong to a gesture that already ended.
    await stream.send([{ kind: 'pointer', phase: 'move', x: 0.6, y: 0.6 }])
    expect(touches(socket).map((touch) => touch.type)).toEqual(['begin', 'end'])
  })

  test('Android SEMU video is configured from its SPS and rotation restarts the decoder', async () => {
    const { hub, kinds, packets } = harness({ platform: 'android' })
    await flush()
    const socket = hub.sockets[0]!
    expect(socket.url).toBe('ws://host/api/device-hub/token/socket')
    socket.handlers.onMessage(new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1e, 0, 0, 1, 0x65, 0x88]))
    socket.handlers.onMessage(new Uint8Array([0, 0, 1, 0x41, 0x9a]))
    socket.handlers.onMessage(JSON.stringify({ type: 'video-session' }))
    expect(kinds()).toEqual(['config', 'key', 'delta', 'screen'])
    expect(packets[0]?.format).toBe('annexb')
    expect(socket.sent.some((message) => typeof message === 'string' && message.includes('reset-video'))).toBe(true)
  })

  test('a refusal from the host ends the stream with its reason', async () => {
    const { hub, packets, retries } = harness({ platform: 'android', openUrl: async () => { throw new DeviceStreamEnded('The device was not found.') } })
    await flush()
    expect(packets.at(-1)).toMatchObject({ kind: 'ended', detail: 'The device was not found.' })
    expect(hub.sockets).toHaveLength(0)
    expect(retries()).toBe(0)
  })

  test('a lost connection to the host is retried', async () => {
    const { packets, retries } = harness({ platform: 'android', openUrl: async () => { throw new Error('disconnected') } })
    await flush()
    expect(packets).toHaveLength(0)
    expect(retries()).toBe(1)
  })

  test('closing stops every hub connection', async () => {
    const { hub, stream } = harness()
    await hub.prime()
    stream.close()
    expect(hub.bodies.every((body) => body.aborted)).toBe(true)
    expect(hub.sockets.every((socket) => socket.closed)).toBe(true)
  })
})

describe('keyframe requests', () => {
  test('an iOS keyframe request reads the AVCC stream again at once, at most once per interval', async () => {
    // WHY: serve-sim sends iOS keyframes only when the AVCC stream starts
    // (measured: two at the start, none after), so a new read is the way to get one.
    const { hub, stream, retries } = harness()
    await flush()
    const first = hub.body('video.avcc')!
    stream.requestKeyframe()
    await flush()
    expect(first.aborted).toBe(true)
    const second = hub.body('video.avcc')
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    // Not the reconnect delay: the harness delay never resolves.
    expect(retries()).toBe(0)
    stream.requestKeyframe()
    await flush()
    expect(second!.aborted).toBe(false)
  })

  test('the new read starts a new stream generation, so the decoder waits for its keyframe', async () => {
    const { hub, stream, packets } = harness()
    await flush()
    hub.body('video.avcc')!.push(new Uint8Array([...DESCRIPTION, ...KEY]))
    stream.requestKeyframe()
    await flush()
    hub.body('video.avcc')!.push(new Uint8Array([...DESCRIPTION, ...KEY]))
    expect(packets.map((packet) => `${packet.kind}:${packet.streamGeneration}`)).toEqual(['config:0', 'key:0', 'config:1', 'key:1'])
  })
})

describe('wheel scrolling', () => {
  const scroll = (deltaY: number) => ({ kind: 'scroll' as const, x: 0.5, y: 0.5, deltaX: 0, deltaY })

  test('a wheel burst is one finger drag, lifted when the wheel stops', async () => {
    // WHY: a down and up for each wheel event reached iOS as quick taps at one
    // spot. Repeated taps select text, and the moves then drag the selection.
    const { hub, stream, touches, elapse } = harness()
    await hub.prime()
    const socket = hub.sockets[0]!
    for (let i = 0; i < 5; i++) await stream.send([scroll(0.05)])
    expect(touches(socket).map((touch) => touch.type)).toEqual(['begin', 'move', 'move', 'move', 'move', 'move'])
    elapse()
    const types = touches(socket).map((touch) => touch.type)
    expect(types.filter((type) => type === 'begin')).toHaveLength(1)
    expect(types.at(-1)).toBe('end')
    expect(touches(socket).at(-1)!.y).toBeCloseTo(0.25)
  })

  test('a tiny wheel nudge never reaches the device as a tap', async () => {
    const { hub, stream, touches, elapse } = harness()
    await hub.prime()
    await stream.send([scroll(0.005)])
    elapse()
    expect(touches(hub.sockets[0]!)).toEqual([])
  })

  test('a click during a wheel drag lifts the wheel finger first', async () => {
    const { hub, stream, touches } = harness()
    await hub.prime()
    await stream.send([scroll(0.1)])
    await stream.send([{ kind: 'pointer', phase: 'down', x: 0.2, y: 0.2 }, { kind: 'pointer', phase: 'up', x: 0.2, y: 0.2 }])
    expect(touches(hub.sockets[0]!).map((touch) => touch.type)).toEqual(['begin', 'move', 'end', 'begin', 'end'])
  })

  test('a drag that reaches the screen edge lifts, and the next wheel starts a new one', async () => {
    const { hub, stream, touches } = harness()
    await hub.prime()
    await stream.send([scroll(0.8)])
    await stream.send([scroll(0.1)])
    expect(touches(hub.sockets[0]!).map((touch) => touch.type)).toEqual(['begin', 'move', 'end', 'begin', 'move'])
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
