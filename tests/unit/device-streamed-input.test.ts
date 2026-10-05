import { describe, expect, test } from 'bun:test'
import type { DeviceFrameHeader, DeviceInput } from '@solus/contracts/device-types'
import { DeviceInputBatcher, clampedPoint, containedRect, normalizedPoint, scrollDelta } from '@solus/workspace-ui/components/devices/lib/device-input'
import { DeviceVideoDecoder, type VideoCodecs, type VideoFrameLike } from '@solus/workspace-ui/components/devices/lib/device-video'

/**
 * The client half of a device stream (P05, P07, P08): touch coordinates map
 * to the screen as drawn, the final pointer-up is never coalesced away, and
 * the decoder never starts on a delta or keeps frames alive.
 */

describe('touch coordinate mapping', () => {
  test('a letterboxed portrait screen maps against the picture, not the element', () => {
    const picture = containedRect({ x: 0, y: 0, width: 400, height: 400 }, 1000, 2000)
    expect(picture).toEqual({ x: 100, y: 0, width: 200, height: 400 })
    expect(normalizedPoint(200, 200, picture)).toEqual({ x: 0.5, y: 0.5 })
    // A click in the letterbox is not a tap on the device.
    expect(normalizedPoint(50, 200, picture)).toBeNull()
    expect(clampedPoint(50, 200, picture)).toEqual({ x: 0, y: 0.5 })
    expect(scrollDelta(0, 100, picture)).toEqual({ deltaX: 0, deltaY: 0.25 })
  })
})

describe('input batching', () => {
  test('moves collapse per frame; down and up flush at once and in order', async () => {
    const sent: DeviceInput[][] = []
    let frame: (() => void) | null = null
    const batcher = new DeviceInputBatcher(async (inputs) => { sent.push(inputs) }, (flush) => { frame = flush }, () => {})
    batcher.push({ kind: 'pointer', phase: 'down', x: 0, y: 0 })
    batcher.push({ kind: 'pointer', phase: 'move', x: 0.1, y: 0 })
    batcher.push({ kind: 'pointer', phase: 'move', x: 0.2, y: 0 })
    frame!()
    batcher.push({ kind: 'pointer', phase: 'move', x: 0.3, y: 0 })
    batcher.push({ kind: 'pointer', phase: 'up', x: 0.3, y: 0 })
    await batcher.drained()
    const phases = sent.flat().map((input) => (input.kind === 'pointer' ? `${input.phase}:${input.x}` : input.kind))
    expect(phases).toEqual(['down:0', 'move:0.2', 'move:0.3', 'up:0.3'])
  })
})

class FakeDecoder {
  static instances: FakeDecoder[] = []
  state = 'unconfigured'
  decodeQueueSize = 0
  decoded: string[] = []
  closed = false
  constructor(readonly init: { output: (frame: VideoFrameLike) => void; error: (error: Error) => void }) {
    FakeDecoder.instances.push(this)
  }

  static async isConfigSupported(config: { codec: string }) {
    return { supported: config.codec !== 'avc1.640034' }
  }

  configure() { this.state = 'configured' }
  decode(chunk: { type: string }) {
    this.decoded.push(chunk.type)
    let frameClosed = false
    this.init.output({ displayWidth: 10, displayHeight: 20, close: () => { frameClosed = true } })
    if (!frameClosed) throw new Error('frame leaked')
  }

  close() { this.closed = true; this.state = 'closed' }
}

const codecs: VideoCodecs = {
  createDecoder: (init) => new FakeDecoder(init),
  isConfigSupported: (config) => FakeDecoder.isConfigSupported(config),
  createChunk: (init) => ({ type: init.type }),
}

function header(kind: DeviceFrameHeader['kind'], extra: Partial<DeviceFrameHeader> = {}): DeviceFrameHeader {
  return { deviceHostId: 'local', deviceId: 'SIM-1', streamGeneration: 1, seq: 0, kind, ...extra }
}

describe('device video decoder', () => {
  test('waits for a keyframe after configuration and closes every frame', async () => {
    FakeDecoder.instances = []
    const painted: string[] = []
    const statuses: string[] = []
    const video = new DeviceVideoDecoder({
      present: (_source, width, height) => painted.push(`${width}x${height}`),
      status: (status) => statuses.push(status.kind),
      screen: () => {},
    }, codecs, async () => { throw new Error('unused') })
    video.push(header('config', { codec: 'avc1.640033', format: 'avcc' }), new Uint8Array([1, 0x64, 0, 0x33]))
    await video.settled()
    video.push(header('delta'), new Uint8Array([1]))
    video.push(header('key'), new Uint8Array([1]))
    video.push(header('delta'), new Uint8Array([1]))
    expect(FakeDecoder.instances[0]!.decoded).toEqual(['key', 'delta'])
    expect(painted).toEqual(['10x20', '10x20'])
    expect(statuses).toEqual(['connecting', 'streaming'])
    video.close()
    expect(FakeDecoder.instances[0]!.closed).toBe(true)
  })

  test('an unsupported profile reports unsupported so iOS can fall back to JPEG', async () => {
    const statuses: string[] = []
    const video = new DeviceVideoDecoder({ present: () => {}, status: (status) => statuses.push(status.kind), screen: () => {} }, codecs, async () => { throw new Error('unused') })
    video.push(header('config', { codec: 'avc1.640034', format: 'avcc' }), new Uint8Array([1]))
    await video.settled()
    expect(statuses.at(-1)).toBe('unsupported')
  })

  test('no WebCodecs is an explicit unsupported state, not a blank surface', () => {
    const statuses: string[] = []
    const video = new DeviceVideoDecoder({ present: () => {}, status: (status) => statuses.push(status.kind), screen: () => {} }, null, async () => { throw new Error('unused') })
    video.push(header('config', { codec: 'avc1.42e01e', format: 'annexb' }), new Uint8Array())
    expect(statuses.at(-1)).toBe('unsupported')
  })

  test('a new stream generation waits for a keyframe again', async () => {
    FakeDecoder.instances = []
    const video = new DeviceVideoDecoder({ present: () => {}, status: () => {}, screen: () => {} }, codecs, async () => { throw new Error('unused') })
    video.push(header('config', { codec: 'avc1.640033', format: 'avcc' }), new Uint8Array([1]))
    await video.settled()
    video.push(header('key'), new Uint8Array([1]))
    video.push(header('delta', { streamGeneration: 2 }), new Uint8Array([1]))
    expect(FakeDecoder.instances[0]!.decoded).toEqual(['key'])
  })

  test('JPEG frames paint and their bitmaps are closed', async () => {
    let closed = 0
    const painted: number[] = []
    const video = new DeviceVideoDecoder({ present: (_source, width) => painted.push(width), status: () => {}, screen: () => {} }, null,
      async () => ({ width: 7, height: 9, close: () => { closed++ } }))
    video.push(header('jpeg'), new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(painted).toEqual([7])
    expect(closed).toBe(1)
  })

  test('screen changes and stream end are surfaced', () => {
    const screens: number[] = []
    const statuses: string[] = []
    const video = new DeviceVideoDecoder({ present: () => {}, status: (status) => statuses.push(status.kind), screen: (_screen, generation) => screens.push(generation) }, null, async () => { throw new Error('unused') })
    video.push(header('screen', { screenGeneration: 3, screen: { width: 1, height: 2, orientation: 'portrait' } }), new Uint8Array())
    video.push(header('ended', { detail: 'The device was shut down.' }), new Uint8Array())
    expect(screens).toEqual([3])
    expect(statuses.at(-1)).toBe('ended')
  })
})
