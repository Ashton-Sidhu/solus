import { afterAll, describe, expect, test } from 'bun:test'
import { resampleLinear, StreamingLinearResampler } from '@solus/workspace-ui/lib/audio-utils'
import { disposePcmCaptureResources, PcmCapture } from '@solus/workspace-ui/lib/pcm-capture'
import { encodePcm16Wav } from '@solus/contracts/voice-audio'
import { readWav } from '@solus/server/transcription/wav'

describe('voice audio resampling', () => {
  test('encodes transport audio as 16 kHz mono 16-bit WAV', () => {
    const samples = Float32Array.from([-1, -0.5, 0, 0.5, 1])
    const wav = encodePcm16Wav(samples)
    const decoded = readWav(Buffer.from(wav))

    expect(wav.byteLength).toBe(44 + samples.length * 2)
    expect(decoded.length).toBe(samples.length)
    for (let i = 0; i < samples.length; i++) {
      expect(Math.abs(decoded[i] - samples[i])).toBeLessThan(1 / 0x7fff)
    }
  })

  test('rejects forged or truncated WAV chunks before allocating samples', () => {
    const encoded = encodePcm16Wav(Float32Array.of(0))

    const oversized = Buffer.from(encoded.slice(0))
    new DataView(oversized.buffer, oversized.byteOffset, oversized.byteLength)
      .setUint32(40, 0xffff_fffe, true)
    expect(() => readWav(oversized)).toThrow('WAV chunk exceeds the uploaded file')

    const oddLength = Buffer.from(encoded.slice(0))
    new DataView(oddLength.buffer, oddLength.byteOffset, oddLength.byteLength)
      .setUint32(40, 1, true)
    expect(() => readWav(oddLength)).toThrow('empty or truncated')

    expect(() => readWav(Buffer.from(encoded).subarray(0, 30)))
      .toThrow('WAV chunk exceeds the uploaded file')
  })

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

  test('meter levels arrive every 32 ms without changing 250 ms audio packets', async () => {
    let onAudio: ((event: MessageEvent<Float32Array>) => void) | null = null
    class FakeNode {
      port = {
        get onmessage() { return onAudio },
        set onmessage(value: typeof onAudio) { onAudio = value },
      }
      connect() {}
      disconnect() {}
    }
    class FakeAudioContext {
      state = 'running'
      sampleRate = 16_000
      destination = {}
      audioWorklet = { addModule: async () => {} }
      createMediaStreamSource() { return new FakeNode() }
      createGain() { return Object.assign(new FakeNode(), { gain: { value: 1 } }) }
      async close() { this.state = 'closed' }
    }
    globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext
    globalThis.AudioWorkletNode = FakeNode as unknown as typeof AudioWorkletNode
    URL.createObjectURL = () => 'blob:voice-meter'
    URL.revokeObjectURL = () => {}
    const levels: number[] = []
    const packets: Float32Array[] = []
    const stream = { getTracks: () => [{ stop() {} }] } as unknown as MediaStream
    const capture = new PcmCapture(stream, chunk => packets.push(chunk.samples), level => levels.push(level))
    try {
      await capture.start()
      const send = (samples: Float32Array) => onAudio?.(new MessageEvent('message', { data: samples }))
      send(new Float32Array(511).fill(0.25))
      expect(levels).toEqual([])
      send(Float32Array.of(0.25))
      expect(levels).toEqual([0.25])
      expect(packets).toEqual([])
      // Irregular worklet block sizes must not move either audio clock.
      for (let sent = 512; sent < 16_000;) {
        const count = Math.min(127, 16_000 - sent)
        send(new Float32Array(count).fill(0.25))
        sent += count
      }
      expect(levels).toHaveLength(31)
      expect(levels.every(level => level === 0.25)).toBe(true)
      expect(packets.map(samples => samples.length)).toEqual([4000, 4000, 4000, 4000])
      send(new Float32Array(384))
      expect(levels.at(-1)).toBeCloseTo(0.125)
      capture.stop()
      expect(levels.at(-1)).toBe(0)
      expect(packets.at(-1)?.length).toBe(384)
    } finally {
      capture.stop()
      await disposePcmCaptureResources()
    }
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
