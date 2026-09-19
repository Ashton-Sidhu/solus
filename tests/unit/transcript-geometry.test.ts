import { expect, test } from 'bun:test'
import { TranscriptGeometry } from '@solus/workspace-ui/components/conversation/lib/transcript-geometry'

test('a long transcript mounts only the viewport and overscan, including deep history', () => {
  const geometry = new TranscriptGeometry()
  geometry.setKeys(Array.from({ length: 10000 }, (_, index) => `turn-${index}`))
  const range = geometry.range(1200000, 800)
  expect(range.end - range.start).toBeLessThan(12)
  expect(range.start).toBeGreaterThan(4900)
  expect(range.before + geometry.offsets[range.end] - geometry.offsets[range.start] + range.after).toBe(geometry.total)
})

test('heights and row identity survive prepend, recycling and removal', () => {
  const geometry = new TranscriptGeometry()
  geometry.setKeys(['a', 'b'])
  geometry.measure('a', 700)
  geometry.measure('b', 120)
  geometry.rebuild()
  expect(geometry.top('b')).toBe(700)
  geometry.setKeys(['older', 'a', 'b'])
  expect(geometry.top('b')).toBe(940)
  expect(geometry.total).toBe(1060)
  geometry.setKeys(['b'])
  expect(geometry.total).toBe(120)
  expect(geometry.top('a')).toBeUndefined()
})

test('a focused offscreen card adds one mounted row, not all intervening history', () => {
  const geometry = new TranscriptGeometry()
  geometry.setKeys(Array.from({ length: 10000 }, (_, index) => `turn-${index}`))
  const range = geometry.range(2000000, 800)
  const slots = geometry.slots(range, ['turn-1'])
  expect(slots.length).toBe(range.end - range.start + 1)
  expect(slots[0].key).toBe('turn-1')
  expect(slots[1].space).toBeGreaterThan(1000000)
})

test('empty and oversized rows produce valid ranges', () => {
  const geometry = new TranscriptGeometry()
  expect(geometry.range(0, 800)).toEqual({ start: 0, end: 0, before: 0, after: 0 })
  geometry.setKeys(['large', 'small'])
  geometry.measure('large', 20000)
  geometry.rebuild()
  expect(geometry.range(10000, 800)).toMatchObject({ start: 0, end: 1 })
})
