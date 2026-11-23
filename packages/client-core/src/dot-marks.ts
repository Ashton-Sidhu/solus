import type { AgentActivity } from '@solus/contracts/agent-activity'

/**
 * The dot marks: letters and patterns drawn on a 3×3 dot grid
 * (docs/plans/session-state-marks.md). Pure data. The Svelte `DotMatrix` runs
 * each dot's keyframes with the Web Animations API and the mobile app with
 * Reanimated; both animate only the dot's scale.
 */

/** `[row, col]`, 0-based, row 0 at the top. */
export type DotCell = readonly [row: number, col: number]

/** One keyframe of one dot. `easing` runs from this keyframe to the next;
 *  without it the segment is linear. */
export interface DotKeyframe {
  offset: number
  scale: number
  easing?: string
}

export interface DotMarkDot {
  cell: DotCell
  keyframes: readonly DotKeyframe[]
}

export interface DotMarkDefinition {
  family: 'letter' | 'pattern'
  /** One cycle. Every dot of a mark shares it and starts at the timeline origin. */
  durationMs: number
  /** The dots that show. A cell not listed is off. */
  dots: readonly DotMarkDot[]
  /** The scale of every dot, still, when the person asks for reduced motion. */
  stillScale: number
}

export const DOT_GRID_SIZE = 3
/** The row size: a 13px box, the box of the line glyphs. */
export const DOT_SIZE_PX = 3
export const DOT_GAP_PX = 2

const FRAME_MS = 1000 / 60
const WRITE_CYCLE_FRAMES = 64
const RUN_CYCLE_FRAMES = 42
export const WRITE_MOTION_MS = WRITE_CYCLE_FRAMES * FRAME_MS
export const RUN_MOTION_MS = RUN_CYCLE_FRAMES * FRAME_MS
export const WRITE_MOTION_EASING = 'cubic-bezier(.3,0,.2,1)'

export type LetterName = 'S' | 'O' | 'L' | 'U'

/** Each letter's cells in pen order. */
export const LETTER_PATHS = {
  S: [[0, 2], [0, 1], [1, 0], [1, 1], [1, 2], [2, 1], [2, 0]],
  O: [[0, 1], [0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2]],
  L: [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]],
  U: [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2]],
} as const satisfies Record<LetterName, readonly DotCell[]>

/**
 * Write motion (O, U): the pen draws the letter, then erases it in the same
 * order, and the grid is empty for the last frames of the cycle. Dot `k` of
 * `n` grows over 6 frames at frame `k * 24/n` and shrinks over 6 frames at
 * frame `40 + k * 16/n`.
 */
export function writeMotionKeyframes(index: number, count: number): DotKeyframe[] {
  const at = (frame: number) => frame / WRITE_CYCLE_FRAMES
  const grow = (index * 24) / count
  const shrink = 24 + 16 + (index * 16) / count
  const keyframes: DotKeyframe[] = []
  if (grow > 0) keyframes.push({ offset: 0, scale: 0 })
  keyframes.push(
    { offset: at(grow), scale: 0, easing: WRITE_MOTION_EASING },
    { offset: at(grow + 6), scale: 1 },
    { offset: at(shrink), scale: 1, easing: WRITE_MOTION_EASING },
    { offset: at(shrink + 6), scale: 0 },
    { offset: 1, scale: 0 },
  )
  return keyframes
}

/** The run motion of the dot the head is on at the cycle start. Every dot
 *  rests at 0.5; the head is at 1, and the two dots behind it at 0.8 and
 *  0.62. The rise to the head takes one frame, so the head reads as a jump. */
function runMotionCurve(count: number): DotKeyframe[] {
  const step = 1 / count
  const rise = 1 / RUN_CYCLE_FRAMES
  return [
    { offset: 0, scale: 1 },
    { offset: step, scale: 0.8 },
    { offset: 2 * step, scale: 0.62 },
    { offset: 3 * step, scale: 0.5 },
    { offset: 1 - rise, scale: 0.5 },
    { offset: 1, scale: 1 },
  ]
}

/**
 * Run motion (S, L): every dot of the letter stays lit, and a bright head runs
 * along the path without a stop. Dot `k` of `n` peaks at `k / n` of the cycle.
 */
export function runMotionKeyframes(index: number, count: number): DotKeyframe[] {
  return patternKeyframes(runMotionCurve(count), index / count)
}

/** The linear value of a curve at `offset`. */
function curveScaleAt(curve: readonly DotKeyframe[], offset: number): number {
  let before: DotKeyframe | undefined
  for (const after of curve) {
    if (before && offset <= after.offset) {
      const span = after.offset - before.offset
      return span === 0 ? after.scale : before.scale + ((after.scale - before.scale) * (offset - before.offset)) / span
    }
    before = after
  }
  return before?.scale ?? 0
}

/**
 * One cycle of `curve` (offsets 0..1, linear) for a dot that runs `phase` of
 * a cycle behind the dot with phase 0. All dots of a mark then share one
 * duration and one start time. A curve whose two ends differ (orbit) keeps its
 * jump: two keyframes share the offset `phase`.
 */
export function patternKeyframes(curve: readonly DotKeyframe[], phase: number): DotKeyframe[] {
  const shift = ((phase % 1) + 1) % 1
  if (shift === 0) return curve.map(({ offset, scale }) => ({ offset, scale }))
  const edge = curveScaleAt(curve, 1 - shift)
  const wrapped = curve.filter((key) => key.offset >= 1 - shift).map((key) => ({ offset: key.offset + shift - 1, scale: key.scale }))
  const shifted = curve.filter((key) => key.offset < 1 - shift).map((key) => ({ offset: key.offset + shift, scale: key.scale }))
  const keyframes: DotKeyframe[] = []
  for (const key of [{ offset: 0, scale: edge }, ...wrapped, ...shifted, { offset: 1, scale: edge }]) {
    const last = keyframes.at(-1)
    if (last?.offset !== key.offset || last.scale !== key.scale) keyframes.push(key)
  }
  return keyframes
}

export type PatternName = 'sweep' | 'scan' | 'type' | 'checker' | 'ripple' | 'orbit'

export interface PatternDefinition {
  curve: readonly DotKeyframe[]
  durationMs: number
  /** The phase of a cell; null for a cell that is off. */
  phase(cell: DotCell): number | null
}

const curve = (...points: Array<[offset: number, scale: number]>): DotKeyframe[] => points.map(([offset, scale]) => ({ offset, scale }))

/** The ring in clockwise order from `[0,0]`; the orbit leaves the centre off. */
const PERIMETER: readonly DotCell[] = [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2], [2, 1], [2, 0], [1, 0]]

export const PATTERNS = {
  sweep: { curve: curve([0, 1], [0.18, 0], [0.5, 0], [0.68, 1], [1, 1]), durationMs: 1600, phase: ([, c]) => c * 0.1 },
  scan: { curve: curve([0, 0], [0.35, 1], [0.72, 0], [1, 0]), durationMs: 1600, phase: ([r]) => r * 0.14 },
  type: { curve: curve([0, 0], [0.12, 1], [0.55, 1], [0.67, 0], [1, 0]), durationMs: 2000, phase: ([r, c]) => (r * 3 + c) * 0.045 },
  checker: { curve: curve([0, 1], [0.5, 0.25], [1, 1]), durationMs: 2400, phase: ([r, c]) => ((r + c) % 2) * 0.5 },
  ripple: { curve: curve([0, 0], [0.35, 1], [0.72, 0], [1, 0]), durationMs: 2000, phase: ([r, c]) => Math.hypot(r - 1, c - 1) * 0.14 },
  orbit: {
    curve: curve([0, 1], [0.22, 0.45], [0.38, 0], [1, 0]),
    durationMs: 1200,
    phase: ([r, c]) => {
      const index = PERIMETER.findIndex(([pr, pc]) => pr === r && pc === c)
      return index === -1 ? null : index / PERIMETER.length
    },
  },
} as const satisfies Record<PatternName, PatternDefinition>

const GRID_CELLS: readonly DotCell[] = Array.from({ length: DOT_GRID_SIZE * DOT_GRID_SIZE }, (_, i) => [Math.floor(i / DOT_GRID_SIZE), i % DOT_GRID_SIZE] as const)

function letterMark(path: readonly DotCell[], motion: 'write' | 'run'): DotMarkDefinition {
  const keyframesOf = motion === 'write' ? writeMotionKeyframes : runMotionKeyframes
  return {
    family: 'letter',
    durationMs: motion === 'write' ? WRITE_MOTION_MS : RUN_MOTION_MS,
    dots: path.map((cell, index) => ({ cell, keyframes: keyframesOf(index, path.length) })),
    stillScale: 1,
  }
}

function patternMark(name: PatternName): DotMarkDefinition {
  const pattern = PATTERNS[name]
  const dots: DotMarkDot[] = []
  for (const cell of GRID_CELLS) {
    const phase = pattern.phase(cell)
    if (phase !== null) dots.push({ cell, keyframes: patternKeyframes(pattern.curve, phase) })
  }
  return { family: 'pattern', durationMs: pattern.durationMs, dots, stillScale: 0.75 }
}

export type DotMarkName =
  | 'starting'
  | 'thinking'
  | 'reading'
  | 'editing'
  | 'running'
  | 'searching'
  | 'writing'
  | 'working'
  | 'background'
  | 'offline'
  | 'delegating'

/** Each dot mark, built once. The five core steps of a turn spell S·O·L·U·S. */
export const DOT_MARKS = {
  // The head runs backward, from the tail of the S to its start.
  starting: letterMark([...LETTER_PATHS.S].reverse(), 'run'),
  thinking: letterMark(LETTER_PATHS.O, 'write'),
  reading: letterMark(LETTER_PATHS.L, 'run'),
  editing: letterMark(LETTER_PATHS.U, 'write'),
  running: letterMark(LETTER_PATHS.S, 'run'),
  searching: patternMark('scan'),
  writing: patternMark('type'),
  working: patternMark('sweep'),
  background: patternMark('checker'),
  offline: patternMark('ripple'),
  // An agent that waits on the agents it started.
  delegating: patternMark('orbit'),
} as const satisfies Record<DotMarkName, DotMarkDefinition>

/** The dot mark of each agent activity. A running turn with no known activity shows `working`. */
export const DOT_MARK_FOR_ACTIVITY = {
  think: 'thinking',
  read: 'reading',
  edit: 'editing',
  run: 'running',
  search: 'searching',
  reply: 'writing',
  other: 'working',
} as const satisfies Record<AgentActivity, DotMarkName>
