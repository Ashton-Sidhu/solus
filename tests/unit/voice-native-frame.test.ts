import { expect, test } from 'bun:test'
import { nativeFrame } from '@solus/desktop-main/transcription/native-worker'

test('hinted starts and retries encode UTF-8 terms before audio without changing legacy frames', () => {
  const frame = nativeFrame('batch', 42, Float32Array.of(0.25), ['Café'])
  expect(frame.readUInt32LE(0)).toBe(7)
  expect(frame.readUInt32LE(4)).toBe(42)
  expect(frame.readUInt32LE(8)).toBe(1)
  expect(frame.readUInt32LE(12)).toBe(1)
  const length = frame.readUInt32LE(16)
  expect(frame.subarray(20, 20 + length).toString('utf8')).toBe('Café')
  expect(frame.readFloatLE(20 + length)).toBe(0.25)
  expect(nativeFrame('begin', 1, undefined, ['Solus']).readUInt32LE(0)).toBe(6)
  expect(nativeFrame('begin', 1).length).toBe(12)
  expect(nativeFrame('feed', 1, Float32Array.of(0.5)).readFloatLE(12)).toBe(0.5)
})
