import { describe, expect, test } from 'bun:test'
import {
  DOT_GRID_SIZE,
  DOT_MARKS,
  LETTER_PATHS,
  patternKeyframes,
  type DotKeyframe,
  type DotMarkName,
} from '@solus/client-core/dot-marks'

const markNames = Object.keys(DOT_MARKS) as DotMarkName[]

function expectValidKeyframes(keyframes: readonly DotKeyframe[]) {
  expect(keyframes.at(0)?.offset).toBe(0)
  expect(keyframes.at(-1)?.offset).toBe(1)
  for (let i = 0; i < keyframes.length; i++) {
    expect(keyframes[i].offset).toBeGreaterThanOrEqual(0)
    expect(keyframes[i].offset).toBeLessThanOrEqual(1)
    if (i > 0) expect(keyframes[i].offset).toBeGreaterThanOrEqual(keyframes[i - 1].offset)
  }
}

// WHY: desktop, web, and mobile draw the same marks from this one table. A
// cell off the grid or a keyframe out of order breaks the mark on every surface.
describe('the dot marks', () => {
  test('every letter path stays inside the grid and uses each cell at most once', () => {
    for (const path of Object.values(LETTER_PATHS)) {
      for (const [row, col] of path) {
        expect(row).toBeGreaterThanOrEqual(0)
        expect(row).toBeLessThan(DOT_GRID_SIZE)
        expect(col).toBeGreaterThanOrEqual(0)
        expect(col).toBeLessThan(DOT_GRID_SIZE)
      }
      expect(new Set(path.map(([row, col]) => `${row},${col}`)).size).toBe(path.length)
    }
  })

  test('every mark lights each cell at most once', () => {
    for (const name of markNames) {
      const cells = DOT_MARKS[name].dots.map(({ cell }) => `${cell[0]},${cell[1]}`)
      expect(new Set(cells).size).toBe(cells.length)
    }
  })

  test('every keyframe offset is in 0..1 and does not decrease', () => {
    for (const name of markNames) {
      for (const dot of DOT_MARKS[name].dots) expectValidKeyframes(dot.keyframes)
    }
  })

  test('a still mark remains visible with reduced motion', () => {
    for (const name of markNames) {
      expect(DOT_MARKS[name].stillScale).toBeGreaterThan(0)
    }
  })
})

// WHY: every dot of a pattern shares one duration and one start, so a dot's
// phase must be in its keyframes. A wrong rotation puts dots out of step.
describe('a pattern rotated by its phase', () => {
  test('a dot with a phase is the curve that much later', () => {
    const rotated = patternKeyframes([
      { offset: 0, scale: 0 },
      { offset: 0.35, scale: 1 },
      { offset: 1, scale: 0 },
    ], 0.25)
    expectValidKeyframes(rotated)
    // The peak of the curve at .35 moves to .6.
    expect(rotated.find((key) => key.scale === 1)?.offset).toBeCloseTo(0.6)
  })

  test('a curve whose ends differ keeps its jump at the phase', () => {
    const rotated = patternKeyframes([{ offset: 0, scale: 1 }, { offset: 1, scale: 0 }], 0.5)
    expectValidKeyframes(rotated)
    const atPhase = rotated.filter((key) => key.offset === 0.5).map((key) => key.scale)
    expect(atPhase).toEqual([0, 1])
  })
})
