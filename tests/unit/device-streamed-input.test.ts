import { describe, expect, test } from 'bun:test'
import type { DeviceInput } from '@solus/contracts/device-types'
import type { DeviceVideoPacket } from '@solus/client-core/device-hub-stream'
import { DeviceInputBatcher, clampedPoint, containedRect, normalizedPoint, scrollDelta } from '@solus/workspace-ui/components/devices/lib/device-input'
import { DeviceVideoDecoder, type VideoCodecs, type VideoFrameLike, type ImageBitmapLike } from '@solus/workspace-ui/components/devices/lib/device-video'

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
    expect(scrollDelta(0, 100, 0, picture)).toEqual({ deltaX: 0, deltaY: 0.25 })
  })

  test('a wheel that reports lines scrolls as far as one that reports pixels', () => {
    // WHY: Firefox reports a mouse wheel notch as 3 lines. Read as 3 pixels, it barely moves the screen.
    const picture = { x: 0, y: 0, width: 200, height: 400 }
    expect(scrollDelta(0, 3, 1, picture).deltaY).toBeCloseTo(48 / 400)
    expect(scrollDelta(0, 1, 2, picture).deltaY).toBe(1)
  })
})

describe('input batching', () => {
  test('drag movement reaches the device before the next display frame and stays in order', async () => {
    const sent: DeviceInput[][] = []
    const firstMovement = Promise.withResolvers<void>()
    const movement = Promise.withResolvers<void>()
    let scheduled = 0
    const batcher = new DeviceInputBatcher(async (inputs) => {
      sent.push(inputs)
      if (sent.length === 2) firstMovement.resolve()
      if (sent.length === 3) movement.resolve()
    }, () => { scheduled++ }, () => {})
    batcher.push({ kind: 'pointer', phase: 'down', x: 0, y: 0 })
    await batcher.drained()
    batcher.push({ kind: 'pointer', phase: 'move', x: 0.1, y: 0 })
    await firstMovement.promise
    batcher.push({ kind: 'pointer', phase: 'move', x: 0.2, y: 0 })
    // Observe delivery without advancing a display frame or flushing the batcher.
    await movement.promise
    expect(sent.flat()).toHaveLength(3)
    expect(scheduled).toBe(0)
    batcher.push({ kind: 'pointer', phase: 'move', x: 0.3, y: 0 })
    batcher.push({ kind: 'pointer', phase: 'up', x: 0.3, y: 0 })
    await batcher.drained()
    const phases = sent.flat().map((input) => (input.kind === 'pointer' ? `${input.phase}:${input.x}` : input.kind))
    expect(phases).toEqual(['down:0', 'move:0.1', 'move:0.2', 'move:0.3', 'up:0.3'])
  })

  test('a blocked send keeps the current drag position instead of replaying old movement', async () => {
    const sent: DeviceInput[][] = []
    const blocked = Promise.withResolvers<void>()
    const batcher = new DeviceInputBatcher(async (inputs) => {
      sent.push(inputs)
      if (sent.length === 1) await blocked.promise
    }, () => { throw new Error('A drag must not wait for a display frame') }, () => {})
    batcher.push({ kind: 'pointer', phase: 'down', x: 0, y: 0 })
    for (let i = 1; i <= 100; i++) batcher.push({ kind: 'pointer', phase: 'move', x: i / 100, y: 0 })
    batcher.push({ kind: 'pointer', phase: 'up', x: 1, y: 0 })
    blocked.resolve()
    await batcher.drained()
    expect(sent.flat()).toEqual([
      { kind: 'pointer', phase: 'down', x: 0, y: 0 },
      { kind: 'pointer', phase: 'move', x: 1, y: 0 },
      { kind: 'pointer', phase: 'up', x: 1, y: 0 },
    ])
  })

  test('a blocked send never merges movement across a release and the next press', async () => {
    const sent: DeviceInput[][] = []
    const blocked = Promise.withResolvers<void>()
    const batcher = new DeviceInputBatcher(async (inputs) => {
      sent.push(inputs)
      if (sent.length === 1) await blocked.promise
    }, () => {}, () => {})
    batcher.push({ kind: 'pointer', phase: 'down', x: 0, y: 0 })
    batcher.push({ kind: 'pointer', phase: 'move', x: 0.1, y: 0 })
    batcher.push({ kind: 'pointer', phase: 'cancel', x: 0.1, y: 0 })
    batcher.push({ kind: 'pointer', phase: 'down', x: 0.2, y: 0 })
    batcher.push({ kind: 'pointer', phase: 'move', x: 0.3, y: 0 })
    batcher.push({ kind: 'pointer', phase: 'up', x: 0.3, y: 0 })
    blocked.resolve()
    await batcher.drained()
    expect(sent.flat().map((input) => input.kind === 'pointer' ? `${input.phase}:${input.x}` : input.kind)).toEqual([
      'down:0', 'move:0.1', 'cancel:0.1', 'down:0.2', 'move:0.3', 'up:0.3',
    ])
  })

  test('an input failure does not leave later input blocked', async () => {
    const sent: DeviceInput[][] = []
    const errors: string[] = []
    const batcher = new DeviceInputBatcher(async (inputs) => {
      sent.push(inputs)
      if (sent.length === 1) throw new Error('disconnected')
    }, () => {}, (error) => { errors.push(String(error)) })
    batcher.push({ kind: 'button', button: 'home' })
    batcher.push({ kind: 'button', button: 'recents' })
    await batcher.drained()
    expect(sent.flat()).toHaveLength(2)
    expect(errors).toEqual(['Error: disconnected'])
  })

  test('a fast wheel sends one scroll a frame with the deltas added up', async () => {
    // WHY: a wheel fires many events a frame. One send each queued input behind the device and felt slow.
    const sent: DeviceInput[][] = []
    let frame: (() => void) | null = null
    const batcher = new DeviceInputBatcher(async (inputs) => { sent.push(inputs) }, (flush) => { frame = flush }, () => {})
    for (let i = 0; i < 10; i++) batcher.push({ kind: 'scroll', x: 0.5, y: 0.5, deltaX: 0, deltaY: 0.01 })
    expect(sent).toEqual([])
    frame!()
    await batcher.drained()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toHaveLength(1)
    expect(sent[0]![0]).toMatchObject({ kind: 'scroll', deltaY: expect.closeTo(0.1) })
  })

  test('wheel input stays combined across display frames while a send is blocked', async () => {
    const sent: DeviceInput[][] = []
    const blocked = Promise.withResolvers<void>()
    const frames: (() => void)[] = []
    const batcher = new DeviceInputBatcher(async (inputs) => {
      sent.push(inputs)
      if (sent.length === 1) await blocked.promise
    }, (flush) => frames.push(flush), () => {})
    batcher.push({ kind: 'button', button: 'home' })
    for (let frame = 0; frame < 10; frame++) {
      batcher.push({ kind: 'scroll', x: 0.5, y: 0.5, deltaX: 0, deltaY: 0.01 })
      frames[frame]!()
    }
    blocked.resolve()
    await batcher.drained()
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual([{ kind: 'scroll', x: 0.5, y: 0.5, deltaX: 0, deltaY: expect.closeTo(0.1) }])
  })
})

class FakeDecoder {
  static instances: FakeDecoder[] = []
  state = 'unconfigured'
  decodeQueueSize = 0
  decoded: string[] = []
  closed = false
  failDecode = false
  constructor(readonly init: { output: (frame: VideoFrameLike) => void; error: (error: Error) => void }) {
    FakeDecoder.instances.push(this)
  }

  static async isConfigSupported(config: { codec: string }) {
    return { supported: config.codec !== 'avc1.640034' }
  }

  configure() { this.state = 'configured' }
  decode(chunk: { type: string }) {
    if (this.failDecode) throw new Error('decode failed')
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

function header(kind: DeviceVideoPacket['kind'], extra: Partial<DeviceVideoPacket> = {}): DeviceVideoPacket {
  return { streamGeneration: 1, kind, ...extra }
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
      needsKeyframe: () => {},
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
    const video = new DeviceVideoDecoder({ present: () => {}, status: (status) => statuses.push(status.kind), screen: () => {}, needsKeyframe: () => {} }, codecs, async () => { throw new Error('unused') })
    video.push(header('config', { codec: 'avc1.640034', format: 'avcc' }), new Uint8Array([1]))
    await video.settled()
    expect(statuses.at(-1)).toBe('unsupported')
  })

  test('no WebCodecs is an explicit unsupported state, not a blank surface', () => {
    const statuses: string[] = []
    const video = new DeviceVideoDecoder({ present: () => {}, status: (status) => statuses.push(status.kind), screen: () => {}, needsKeyframe: () => {} }, null, async () => { throw new Error('unused') })
    video.push(header('config', { codec: 'avc1.42e01e', format: 'annexb' }), new Uint8Array())
    expect(statuses.at(-1)).toBe('unsupported')
  })

  test('a new stream generation waits for a keyframe again', async () => {
    FakeDecoder.instances = []
    const video = new DeviceVideoDecoder({ present: () => {}, status: () => {}, screen: () => {}, needsKeyframe: () => {} }, codecs, async () => { throw new Error('unused') })
    video.push(header('config', { codec: 'avc1.640033', format: 'avcc' }), new Uint8Array([1]))
    await video.settled()
    video.push(header('key'), new Uint8Array([1]))
    video.push(header('delta', { streamGeneration: 2 }), new Uint8Array([1]))
    expect(FakeDecoder.instances[0]!.decoded).toEqual(['key'])
  })

  test('a decoder that drops frames for a keyframe asks for one', async () => {
    // WHY: measured on serve-sim, iOS sends keyframes only when its stream
    // starts. Waiting for the next one froze the picture with no end.
    FakeDecoder.instances = []
    let asked = 0
    const video = new DeviceVideoDecoder({ present: () => {}, status: () => {}, screen: () => {}, needsKeyframe: () => { asked++ } }, codecs, async () => { throw new Error('unused') })
    video.push(header('config', { codec: 'avc1.640033', format: 'avcc' }), new Uint8Array([1]))
    await video.settled()
    video.push(header('key'), new Uint8Array([1]))
    expect(asked).toBe(0)
    // Behind by more than the soft queue: skip ahead and ask.
    FakeDecoder.instances[0]!.decodeQueueSize = 9
    video.push(header('delta'), new Uint8Array([1]))
    expect(asked).toBe(1)
    await video.settled()
    video.push(header('delta'), new Uint8Array([1]))
    expect(asked).toBe(2)
    video.push(header('key'), new Uint8Array([1]))
    video.push(header('delta'), new Uint8Array([1]))
    expect(asked).toBe(2)
    expect(FakeDecoder.instances[0]!.closed).toBe(true)
    expect(FakeDecoder.instances[1]!.decoded).toEqual(['key', 'delta'])
  })

  test('a keyframe and deltas received during codec setup decode without a stream restart', async () => {
    FakeDecoder.instances = []
    let asked = 0
    const video = new DeviceVideoDecoder({ present: () => {}, status: () => {}, screen: () => {}, needsKeyframe: () => { asked++ } }, codecs, async () => { throw new Error('unused') })
    video.push(header('config', { format: 'avcc' }), new Uint8Array([1]))
    video.push(header('key'), new Uint8Array([2]))
    video.push(header('delta'), new Uint8Array([3]))
    await video.settled()
    expect(FakeDecoder.instances[0]!.decoded).toEqual(['key', 'delta'])
    expect(asked).toBe(0)
    video.close()
  })

  test('codec setup buffers are bounded and request a fresh keyframe after overflow', async () => {
    FakeDecoder.instances = []
    let asked = 0
    const video = new DeviceVideoDecoder({ present: () => {}, status: () => {}, screen: () => {}, needsKeyframe: () => { asked++ } }, codecs, async () => { throw new Error('unused') })
    video.push(header('config'), new Uint8Array())
    video.push(header('key'), new Uint8Array([1]))
    for (let i = 0; i < 100; i++) video.push(header('delta'), new Uint8Array([1]))
    await video.settled()
    expect(FakeDecoder.instances[0]!.decoded).toEqual([])
    expect(asked).toBe(1)
    video.push(header('key'), new Uint8Array([1]))
    expect(FakeDecoder.instances[0]!.decoded).toEqual(['key'])
    video.close()
  })

  test.each(['sync', 'async'] as const)('%s decode errors recover without a repeated Android codec config', async (failure) => {
    FakeDecoder.instances = []
    let asked = 0
    const statuses: string[] = []
    const video = new DeviceVideoDecoder({ present: () => {}, status: (status) => statuses.push(status.kind), screen: () => {}, needsKeyframe: () => { asked++ } }, codecs, async () => { throw new Error('unused') })
    video.push(header('config', { format: 'annexb' }), new Uint8Array())
    video.push(header('key'), new Uint8Array([1]))
    await video.settled()
    const first = FakeDecoder.instances[0]!
    if (failure === 'sync') {
      first.failDecode = true
      video.push(header('delta'), new Uint8Array([1]))
    } else first.init.error(new Error('decoder failed'))
    expect(first.closed).toBe(true)
    expect(asked).toBe(1)
    expect(statuses.at(-1)).toBe('connecting')
    video.push(header('key'), new Uint8Array([1]))
    video.push(header('delta'), new Uint8Array([1]))
    await video.settled()
    expect(FakeDecoder.instances[1]!.decoded).toEqual(['key', 'delta'])
    expect(statuses.at(-1)).toBe('streaming')
    video.close()
  })

  test.each(['close', 'end', 'replace'] as const)('%s invalidates frames waiting for codec setup', async (action) => {
    FakeDecoder.instances = []
    const video = new DeviceVideoDecoder({ present: () => {}, status: () => {}, screen: () => {}, needsKeyframe: () => {} }, codecs, async () => { throw new Error('unused') })
    video.push(header('config'), new Uint8Array())
    video.push(header('key'), new Uint8Array([1]))
    const pending = video.settled()
    if (action === 'close') video.close()
    else if (action === 'end') video.push(header('ended'), new Uint8Array())
    else {
      video.push(header('config', { streamGeneration: 2 }), new Uint8Array())
      video.push(header('key', { streamGeneration: 2 }), new Uint8Array([2]))
    }
    await pending
    await video.settled()
    expect(FakeDecoder.instances.flatMap((decoder) => decoder.decoded)).toEqual(action === 'replace' ? ['key'] : [])
    video.close()
  })

  test('JPEG frames paint and their bitmaps are closed', async () => {
    let closed = 0
    const painted: number[] = []
    const video = new DeviceVideoDecoder({ present: (_source, width) => painted.push(width), status: () => {}, screen: () => {}, needsKeyframe: () => {} }, null,
      async () => ({ width: 7, height: 9, close: () => { closed++ } }))
    video.push(header('jpeg'), new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(painted).toEqual([7])
    expect(closed).toBe(1)
  })

  test('a delayed bootstrap JPEG cannot overwrite a newer live video frame', async () => {
    const painted: number[] = []
    let finishImage: (image: ImageBitmapLike) => void = () => {}
    let closed = 0
    const video = new DeviceVideoDecoder({ present: (_source, width) => painted.push(width), status: () => {}, screen: () => {}, needsKeyframe: () => {} }, codecs,
      () => new Promise((resolve) => { finishImage = resolve }))
    video.push(header('seed'), new Uint8Array([1]))
    video.push(header('config', { format: 'annexb' }), new Uint8Array())
    await video.settled()
    video.push(header('key'), new Uint8Array([1]))
    expect(painted).toEqual([10])
    finishImage({ width: 99, height: 99, close: () => { closed++ } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(painted).toEqual([10])
    expect(closed).toBe(1)
    video.close()
  })

  test('a bootstrap JPEG still paints while no live frame has arrived', async () => {
    const painted: number[] = []
    const video = new DeviceVideoDecoder({ present: (_source, width) => painted.push(width), status: () => {}, screen: () => {}, needsKeyframe: () => {} }, codecs,
      async () => ({ width: 99, height: 99, close: () => {} }))
    video.push(header('seed'), new Uint8Array([1]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(painted).toEqual([99])
    video.close()
  })

  test.each(['seed', 'jpeg'] as const)('an old %s decode cannot paint into a new stream generation', async (kind) => {
    const painted: number[] = []
    const finishes: ((image: ImageBitmapLike) => void)[] = []
    let closed = 0
    const video = new DeviceVideoDecoder({ present: (_source, width) => painted.push(width), status: () => {}, screen: () => {}, needsKeyframe: () => {} }, null,
      () => new Promise((resolve) => { finishes.push(resolve) }))
    video.push(header(kind), new Uint8Array([1]))
    video.push(header('jpeg', { streamGeneration: 2 }), new Uint8Array([2]))
    expect(finishes).toHaveLength(2)
    finishes[1]!({ width: 22, height: 22, close: () => { closed++ } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    finishes[0]!({ width: 11, height: 11, close: () => { closed++ } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(painted).toEqual([22])
    expect(closed).toBe(2)
    video.close()
  })

  test('screen changes and stream end are surfaced', () => {
    const screens: (number | undefined)[] = []
    const statuses: string[] = []
    const video = new DeviceVideoDecoder({ present: () => {}, status: (status) => statuses.push(status.kind), screen: (screen) => screens.push(screen?.height), needsKeyframe: () => {} }, null, async () => { throw new Error('unused') })
    video.push(header('screen', { screen: { width: 1, height: 2, orientation: 'portrait' } }), new Uint8Array())
    video.push(header('ended', { detail: 'The device was shut down.' }), new Uint8Array())
    expect(screens).toEqual([2])
    expect(statuses.at(-1)).toBe('ended')
  })
})
