import { describe, expect, test } from 'bun:test'
import {
  DOT_GRID_SIZE,
  DOT_MARKS,
  LETTER_PATHS,
  PATTERNS,
  patternKeyframes,
  type DotKeyframe,
  type DotMarkName,
} from '@solus/client-core/dot-marks'

const markNames = Object.keys(DOT_MARKS) as DotMarkName[]
const writeMarks: DotMarkName[] = ['thinking', 'editing']
const runMarks: DotMarkName[] = ['starting', 'reading', 'running']

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

  test('a write-motion letter is empty at the end of its cycle', () => {
    for (const name of writeMarks) {
      for (const dot of DOT_MARKS[name].dots) {
        const last = dot.keyframes.at(-1)!
        const beforeLast = dot.keyframes.at(-2)!
        expect(last.scale).toBe(0)
        // Empty for some frames, not only at the last instant.
        expect(beforeLast.scale).toBe(0)
        expect(beforeLast.offset).toBeLessThan(1)
      }
    }
  })

  test('a run-motion letter never drops below half size, and its head reaches full size', () => {
    for (const name of runMarks) {
      for (const dot of DOT_MARKS[name].dots) {
        expect(Math.min(...dot.keyframes.map((key) => key.scale))).toBe(0.5)
        expect(Math.max(...dot.keyframes.map((key) => key.scale))).toBe(1)
      }
    }
  })

  test('Starting runs the S backward, from [2,0]', () => {
    expect(DOT_MARKS.starting.dots[0].cell).toEqual([2, 0])
    expect(DOT_MARKS.running.dots[0].cell).toEqual([0, 2])
    expect(DOT_MARKS.starting.dots.map(({ cell }) => cell)).toEqual([...LETTER_PATHS.S].reverse())
  })

  test('the S·O·L·U·S steps draw their letters', () => {
    expect(DOT_MARKS.thinking.dots.map(({ cell }) => cell)).toEqual([...LETTER_PATHS.O])
    expect(DOT_MARKS.reading.dots.map(({ cell }) => cell)).toEqual([...LETTER_PATHS.L])
    expect(DOT_MARKS.editing.dots.map(({ cell }) => cell)).toEqual([...LETTER_PATHS.U])
  })

  test('the orbit leaves the centre off', () => {
    expect(DOT_MARKS.delegating.dots).toHaveLength(8)
    expect(DOT_MARKS.delegating.dots.some(({ cell }) => cell[0] === 1 && cell[1] === 1)).toBe(false)
  })

  test('reduced motion: letters show at full size, patterns at three quarters', () => {
    for (const name of markNames) {
      expect(DOT_MARKS[name].stillScale).toBe(DOT_MARKS[name].family === 'letter' ? 1 : 0.75)
    }
  })
})

// WHY: every dot of a pattern shares one duration and one start, so a dot's
// phase must be in its keyframes. A wrong rotation puts dots out of step.
describe('a pattern rotated by its phase', () => {
  test('a dot with a phase is the curve that much later', () => {
    const rotated = patternKeyframes(PATTERNS.scan.curve, 0.25)
    expectValidKeyframes(rotated)
    // The peak of the curve at .35 moves to .6.
    expect(rotated.find((key) => key.scale === 1)?.offset).toBeCloseTo(0.6)
  })

  test('a curve whose ends differ keeps its jump at the phase', () => {
    const rotated = patternKeyframes(PATTERNS.orbit.curve, 0.5)
    expectValidKeyframes(rotated)
    const atPhase = rotated.filter((key) => key.offset === 0.5).map((key) => key.scale)
    expect(atPhase).toEqual([0, 1])
  })
})
