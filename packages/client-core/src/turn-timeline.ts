import { formatElapsed } from './elapsed-time'

/**
 * The timeline at the top of the Artifacts surface
 * (docs/plans/session-artifacts.md): a session as its tool calls over time,
 * cut into turns. Desktop, web, and the phone draw the same bars from this
 * model.
 *
 * The line is working time, not clock time. A turn takes the bars its work
 * took; the wait before the next prompt takes one bar, however long it was.
 * A session that someone left for a night and came back to would otherwise be
 * one long empty line with its turns pressed into the ends. A wait of an hour
 * or more is a break: it takes a few bars, so the line has room to say how
 * long the person was away.
 */

/** One turn: from its prompt to the last thing the agent did in it. */
export interface TimelineTurn {
  /** The prompt's message id. A scope names its turn by this, so it holds when earlier history loads. */
  id: string
  startedAt: number
  /** The turn's last activity; the present moment while the turn still runs. */
  endedAt: number
  prompt: string
}

/** What one bar stands for. Always a round span, so the legend can say it in words. */
export interface BarSpan {
  seconds: number
  label: string
}

export const BAR_SPANS: readonly BarSpan[] = [
  { seconds: 15, label: '15 seconds' },
  { seconds: 30, label: '30 seconds' },
  { seconds: 60, label: 'minute' },
  { seconds: 120, label: '2 minutes' },
  { seconds: 300, label: '5 minutes' },
  { seconds: 600, label: '10 minutes' },
  { seconds: 1800, label: '30 minutes' },
  { seconds: 3600, label: 'hour' },
]

/** A turn is never thinner than this, so a short one can still be pointed at. */
const MIN_TURN_BARS = 2

/** A bar is never full height with fewer calls than this. */
const MIN_FULL_HEIGHT_CALLS = 10

/** A wait this long is a break: the person left and came back. */
const BREAK_MS = 60 * 60 * 1000
/** The bars a break takes: room for its length in words. */
const BREAK_BARS = 6

export interface TimelineBar {
  /** The turn the bar is in. Null on the wait between two turns. */
  turn: number | null
  startedAt: number
  /** Tool calls that started in the bar's span. Zero on a wait. */
  calls: number
  /** How long the wait was, on a wait bar. */
  waitMs: number
}

/** The bars of one turn: the first, and the one after the last. */
export interface TurnRange {
  from: number
  to: number
}

/** The wait between two turns, as the bars it takes. */
export interface TimelineGap {
  from: number
  to: number
  waitMs: number
  /** An hour or more: the line says how long it was. */
  isBreak: boolean
}

export interface TimelineLayout {
  span: BarSpan
  bars: TimelineBar[]
  /** One per turn, in order. The wait after a turn is outside its range. */
  ranges: TurnRange[]
  /** One per pair of turns that follow each other, in order. */
  gaps: TimelineGap[]
  /**
   * The count at which a bar is full height. It is the count that 19 bars in
   * 20 stay under, and never less than `MIN_FULL_HEIGHT_CALLS`: one burst
   * would otherwise press every other bar flat, and a quiet session's single
   * calls would otherwise all stand at full height.
   */
  fullHeightCalls: number
}

function turnBarCount(turn: TimelineTurn, span: BarSpan): number {
  return Math.max(MIN_TURN_BARS, Math.ceil((turn.endedAt - turn.startedAt) / (span.seconds * 1000)))
}

function waitMsAfter(turns: readonly TimelineTurn[], index: number): number {
  return Math.max(0, turns[index + 1]!.startedAt - turns[index]!.endedAt)
}

function gapBarCount(waitMs: number): number {
  return waitMs >= BREAK_MS ? BREAK_BARS : 1
}

function barTotal(turns: readonly TimelineTurn[], span: BarSpan): number {
  let total = 0
  turns.forEach((turn, index) => {
    total += turnBarCount(turn, span)
    if (index < turns.length - 1) total += gapBarCount(waitMsAfter(turns, index))
  })
  return total
}

/** The last turn that had started at `time`, or -1 before the first prompt. */
export function turnIndexAt(turns: readonly TimelineTurn[], time: number): number {
  let low = 0
  let high = turns.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (turns[middle]!.startedAt <= time) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

/**
 * The bars for a session. The span is the finest whose bars fit in `maxBars`;
 * when even the coarsest does not fit (very many turns), the layout keeps the
 * coarsest and the caller scrolls.
 */
export function timelineLayout(turns: readonly TimelineTurn[], toolCallTimes: readonly number[], maxBars: number): TimelineLayout {
  const span = BAR_SPANS.find((candidate) => barTotal(turns, candidate) <= maxBars) ?? BAR_SPANS[BAR_SPANS.length - 1]!
  const spanMs = span.seconds * 1000
  const bars: TimelineBar[] = []
  const ranges: TurnRange[] = []
  const gaps: TimelineGap[] = []
  turns.forEach((turn, index) => {
    const from = bars.length
    const count = turnBarCount(turn, span)
    for (let offset = 0; offset < count; offset++) {
      bars.push({ turn: index, startedAt: turn.startedAt + offset * spanMs, calls: 0, waitMs: 0 })
    }
    ranges.push({ from, to: bars.length })
    if (index === turns.length - 1) return
    const waitMs = waitMsAfter(turns, index)
    const gapFrom = bars.length
    for (let offset = 0; offset < gapBarCount(waitMs); offset++) bars.push({ turn: null, startedAt: turn.endedAt, calls: 0, waitMs })
    gaps.push({ from: gapFrom, to: bars.length, waitMs, isBreak: waitMs >= BREAK_MS })
  })
  for (const time of toolCallTimes) {
    const index = turnIndexAt(turns, time)
    if (index === -1) continue
    const range = ranges[index]!
    // A call that lands past the turn's last bar (a clock a little ahead) counts in the last one.
    bars[Math.min(range.to - 1, range.from + Math.floor((time - turns[index]!.startedAt) / spanMs))]!.calls += 1
  }
  const counts = bars.flatMap((bar) => (bar.calls > 0 ? [bar.calls] : [])).sort((a, b) => a - b)
  const fullHeightCalls = Math.max(MIN_FULL_HEIGHT_CALLS, counts[Math.floor(counts.length * 0.95)] ?? 0)
  return { span, bars, ranges, gaps, fullHeightCalls }
}

/** How tall a bar is, 0..1 of the plot. */
export function barHeightShare(calls: number, fullHeightCalls: number): number {
  return Math.min(1, calls / fullHeightCalls)
}

/** A break's length in the fewest characters: `3h`, `2d`. */
export function breakLabel(waitMs: number): string {
  const hours = waitMs / (60 * 60 * 1000)
  return hours < 24 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`
}

/**
 * The turns whose start time has room for its label under the line: each at
 * least `labelWidth` after the one before it, and clear of the line's end,
 * where "now" is written.
 */
export function timelineLabels(ranges: readonly TurnRange[], pitch: number, plotWidth: number, labelWidth: number): number[] {
  const labelled: number[] = []
  let previousLeft = -labelWidth
  ranges.forEach((range, index) => {
    const left = range.from * pitch
    if (left - previousLeft < labelWidth || left > plotWidth - labelWidth) return
    labelled.push(index)
    previousLeft = left
  })
  return labelled
}

/** What a bar says when it is pointed at: its count, or how long the wait was. */
export function timelineBarText(bar: TimelineBar): string {
  if (bar.turn === null) return `Waited ${formatElapsed(bar.waitMs)} for a prompt`
  if (bar.calls === 0) return 'No tool calls'
  return `${bar.calls} tool ${bar.calls === 1 ? 'call' : 'calls'}`
}

/** The time the session worked: its turns, without the waits between them. */
export function timelineWorkMs(turns: readonly TimelineTurn[]): number {
  return turns.reduce((total, turn) => total + Math.max(0, turn.endedAt - turn.startedAt), 0)
}
