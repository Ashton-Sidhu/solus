import { describe, expect, test } from 'bun:test'
import { resampleLinear, StreamingLinearResampler } from '../../src/renderer/lib/audio-utils'

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

function join(blocks: Float32Array[]): Float32Array {
  const output = new Float32Array(blocks.reduce((length, block) => length + block.length, 0))
  let offset = 0
  for (const block of blocks) {
    output.set(block, offset)
    offset += block.length
  }
  return output
}
