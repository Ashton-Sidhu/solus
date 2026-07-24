import { afterAll, describe, expect, test } from 'bun:test'
import { resampleLinear, StreamingLinearResampler } from '../../src/renderer/lib/audio-utils'
import { disposePcmCaptureResources, PcmCapture } from '../../src/renderer/lib/pcm-capture'

describe('voice audio resampling', () => {
  test('preserves sample timing across AudioWorklet-sized input blocks', () => {
    for (const inputRate of [44_100, 48_000]) {
      const input = Float32Array.from(
        { length: inputRate },
        (_, index) => Math.sin(index / 17),
      )
      const resampler = new StreamingLinearResampler(inputRate, 16_000)
      const blocks: Float32Array[] = []

      for (let offset = 0; offset < input.length; offset += 128) {
        blocks.push(resampler.push(input.subarray(offset, offset + 128)))
      }
      blocks.push(resampler.flush())

      const actual = join(blocks)
      const expected = resampleLinear(input, inputRate, 16_000)
      expect(actual.length).toBe(16_000)
      let maxError = 0
      for (let i = 0; i < actual.length; i++) {
        maxError = Math.max(maxError, Math.abs(actual[i] - expected[i]))
      }
      expect(maxError).toBeLessThan(1e-6)
    }
  })
})

describe('voice capture lifecycle', () => {
  const originalAudioContext = globalThis.AudioContext
  const originalAudioWorkletNode = globalThis.AudioWorkletNode
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL

  afterAll(() => {
    globalThis.AudioContext = originalAudioContext
    globalThis.AudioWorkletNode = originalAudioWorkletNode
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
  })

  test('reuses one context and worklet until renderer disposal', async () => {
    let contextsCreated = 0
    let modulesLoaded = 0
    let contextsClosed = 0

    class FakeNode {
      port = { onmessage: null }
      connect() {}
      disconnect() {}
    }
    class FakeAudioContext {
      state = 'running'
      sampleRate = 48_000
      destination = {}
      audioWorklet = { addModule: async () => { modulesLoaded++ } }
      constructor() { contextsCreated++ }
      createMediaStreamSource() { return new FakeNode() }
      createGain() { return Object.assign(new FakeNode(), { gain: { value: 1 } }) }
      async resume() { this.state = 'running' }
      async close() { this.state = 'closed'; contextsClosed++ }
    }

    globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext
    globalThis.AudioWorkletNode = FakeNode as unknown as typeof AudioWorkletNode
    URL.createObjectURL = () => 'blob:voice-worklet'
    URL.revokeObjectURL = () => {}

    const stream = () => ({ getTracks: () => [{ stop() {} }] }) as unknown as MediaStream
    const first = new PcmCapture(stream(), () => {})
    const second = new PcmCapture(stream(), () => {})

    await first.start()
    first.stop()
    await second.start()
    second.stop()

    expect(contextsCreated).toBe(1)
    expect(modulesLoaded).toBe(1)
    expect(contextsClosed).toBe(0)

    await disposePcmCaptureResources()
    expect(contextsClosed).toBe(1)

    const afterReload = new PcmCapture(stream(), () => {})
    await afterReload.start()
    afterReload.stop()
    expect(contextsCreated).toBe(2)
    expect(modulesLoaded).toBe(2)
    await disposePcmCaptureResources()
  })
})

function join(blocks: Float32Array[]): Float32Array {
  const output = new Float32Array(blocks.reduce((length, block) => length + block.length, 0))
  let offset = 0
  for (const block of blocks) {
    output.set(block, offset)
    offset += block.length
  }
  return output
}
