import { describe, expect, test } from 'bun:test'
import {
  barHeightShare,
  breakLabel,
  costAxisTop,
  timelineBarText,
  timelineChartRows,
  timelineLabels,
  timelineLayout,
  timelineWorkMs,
  turnIndexAt,
  type TimelineTurn,
} from '@solus/client-core/turn-timeline'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

function turn(id: string, startedAt: number, endedAt: number): TimelineTurn {
  return { id, startedAt, endedAt, prompt: `Prompt ${id}` }
}

describe('the bar span', () => {
  test('is the finest round span whose bars fit the room', () => {
    // WHY: the legend names what a bar is ("per 30 seconds"). A bar must be a
    // span a person can say, and the plot must use all the detail the pane has.
    const turns = [turn('a', 0, 10 * MINUTE)]
    expect(timelineLayout(turns, [], 200).span.seconds).toBe(15)
    expect(timelineLayout(turns, [], 20).span.seconds).toBe(30)
    expect(timelineLayout(turns, [], 10).span.seconds).toBe(60)
  })

  test('falls back to the coarsest span when nothing fits, and the caller scrolls', () => {
    const turns = Array.from({ length: 50 }, (_, index) => turn(`t${index}`, index * HOUR, index * HOUR + MINUTE))
    const layout = timelineLayout(turns, [], 10)
    expect(layout.span.seconds).toBe(3600)
    expect(layout.bars.length).toBeGreaterThan(10)
  })
})

describe('the line is working time', () => {
  test('a short wait between two turns is one bar', () => {
    const turns = [turn('a', 0, 2 * MINUTE), turn('b', 12 * MINUTE, 14 * MINUTE)]
    const layout = timelineLayout(turns, [], 100)
    expect(layout.ranges).toEqual([
      { from: 0, to: 8 },
      { from: 9, to: 17 },
    ])
    expect(layout.gaps).toEqual([{ from: 8, to: 9, waitMs: 10 * MINUTE, isBreak: false }])
    expect(layout.bars[8]!.turn).toBeNull()
  })

  test('a wait of an hour or more is a break: a few bars, however long it was, and it says how long', () => {
    // WHY: a session left for a night would otherwise be one long empty line
    // with its turns pressed into the ends. The break keeps a fixed width, and
    // the line still tells the reader the person was away.
    const turns = [turn('a', 0, 2 * MINUTE), turn('b', 14 * HOUR, 14 * HOUR + 2 * MINUTE)]
    const layout = timelineLayout(turns, [], 100)
    expect(layout.span.seconds).toBe(15)
    expect(layout.ranges).toEqual([
      { from: 0, to: 8 },
      { from: 14, to: 22 },
    ])
    expect(layout.gaps).toEqual([{ from: 8, to: 14, waitMs: 14 * HOUR - 2 * MINUTE, isBreak: true }])
    expect(timelineBarText(layout.bars[8]!)).toBe('Waited 13h 58m for a prompt')
    expect(breakLabel(layout.gaps[0]!.waitMs)).toBe('14h')
    expect(breakLabel(3 * 24 * HOUR)).toBe('3d')
  })

  test('a turn with no work is still wide enough to point at', () => {
    const layout = timelineLayout([turn('a', 0, 0), turn('b', MINUTE, MINUTE)], [], 100)
    expect(layout.ranges).toEqual([
      { from: 0, to: 2 },
      { from: 3, to: 5 },
    ])
  })

  test('the work time is the turns without the waits between them', () => {
    expect(timelineWorkMs([turn('a', 0, 2 * MINUTE), turn('b', HOUR, HOUR + 3 * MINUTE)])).toBe(5 * MINUTE)
  })
})

describe('tool calls', () => {
  test('a call counts in the bar of its turn that holds its time', () => {
    const turns = [turn('a', 0, MINUTE), turn('b', 10 * MINUTE, 11 * MINUTE)]
    // 15-second bars: turn a holds bars 0..3, the wait is bar 4, turn b holds bars 5..8.
    const layout = timelineLayout(turns, [1_000, 2_000, 16_000, 10 * MINUTE + 31_000], 100)
    expect(layout.bars.map((bar) => bar.calls)).toEqual([2, 1, 0, 0, 0, 0, 0, 1, 0])
    expect(timelineBarText(layout.bars[0]!)).toBe('2 tool calls')
    expect(timelineBarText(layout.bars[1]!)).toBe('1 tool call')
    expect(timelineBarText(layout.bars[2]!)).toBe('No tool calls')
  })

  test('a call before the first prompt is in no turn, and one past its turn end counts in the last bar', () => {
    const layout = timelineLayout([turn('a', MINUTE, 2 * MINUTE)], [0, 5 * MINUTE], 100)
    expect(layout.bars.map((bar) => bar.calls)).toEqual([0, 0, 0, 1])
  })

  test('a quiet session does not stand every bar at full height', () => {
    // WHY: most bars hold one to three calls. Measured against the busiest of
    // them, they would all be tall, and the plot would read as a barcode.
    const layout = timelineLayout([turn('a', 0, MINUTE)], [1_000, 16_000, 17_000], 100)
    expect(layout.fullHeightCalls).toBe(10)
    expect(barHeightShare(1, layout.fullHeightCalls)).toBeCloseTo(0.1)
    expect(barHeightShare(0, layout.fullHeightCalls)).toBe(0)
  })

  test('one burst does not press the other bars flat', () => {
    // WHY: measured against a burst of 200 calls, a bar of 20 is a dot.
    // Nineteen bars in twenty set the scale, and the burst is cut at the top.
    const calls: number[] = []
    for (let bar = 0; bar < 39; bar++) for (let n = 0; n < 20; n++) calls.push(bar * 15_000 + n)
    for (let n = 0; n < 200; n++) calls.push(39 * 15_000 + n)
    const layout = timelineLayout([turn('a', 0, 10 * MINUTE)], calls, 100)
    expect(layout.span.seconds).toBe(15)
    expect(layout.fullHeightCalls).toBe(20)
    expect(barHeightShare(200, layout.fullHeightCalls)).toBe(1)
  })
})

describe('turn lookup', () => {
  test('finds the last turn that had started, and nothing before the first prompt', () => {
    const turns = [turn('a', 100, 200), turn('b', 300, 400)]
    expect(turnIndexAt(turns, 50)).toBe(-1)
    expect(turnIndexAt(turns, 100)).toBe(0)
    expect(turnIndexAt(turns, 250)).toBe(0)
    expect(turnIndexAt(turns, 300)).toBe(1)
    expect(turnIndexAt(turns, 9_999)).toBe(1)
  })
})

describe('time labels', () => {
  test('a label shows only where it has room, and never under "now"', () => {
    // WHY: two labels drawn over each other read as neither.
    const ranges = [
      { from: 0, to: 4 },
      { from: 5, to: 7 },
      { from: 20, to: 30 },
      { from: 38, to: 40 },
    ]
    // 5px bars in a 200px plot, 50px labels: the second turn starts 25px after
    // the first, and the last starts inside the room kept for the end label.
    expect(timelineLabels(ranges, 5, 200, 50)).toEqual([0, 2])
  })
})

describe('cost', () => {
  const turns = [turn('a', 0, 2 * MINUTE), turn('b', 12 * MINUTE, 14 * MINUTE), turn('c', 20 * MINUTE, 22 * MINUTE)]

  test("a turn's cost is spread over its own bars, and nothing is spent in the waits", () => {
    // WHY: the curve shows where the money went. A cost on the wrong turn, or
    // one that rises while nobody works, points at the wrong work.
    const layout = timelineLayout(turns, [], 200, [], [
      // The host's clock for a turn can start a moment before the prompt's time.
      { startedAt: 12 * MINUTE - 5, endedAt: 14 * MINUTE + 50, costUsd: 3 },
      { startedAt: 0, endedAt: 2 * MINUTE, costUsd: 0.5 },
    ])
    const spentIn = (index: number) => {
      const range = layout.ranges[index]!
      return layout.bars.slice(range.from, range.to).reduce((sum, bar) => sum + bar.costUsd, 0)
    }
    expect(spentIn(0)).toBeCloseTo(0.5)
    expect(spentIn(1)).toBeCloseTo(3)
    expect(layout.bars.filter((bar) => bar.turn === null).every((bar) => bar.costUsd === 0)).toBe(true)
    const b = layout.ranges[1]!
    expect(layout.bars[b.from]!.costUsd).toBeCloseTo(layout.bars[b.to - 1]!.costUsd)
    expect(layout.runningCostUsd[b.to - 1]).toBeCloseTo(3.5)
    expect(layout.totalCostUsd).toBeCloseTo(3.5)
  })

  test('a turn with no known cost reads as unknown, not as free', () => {
    const layout = timelineLayout(turns, [], 200, [], [{ startedAt: 0, endedAt: 2 * MINUTE, costUsd: 0.5 }])
    expect(layout.turnCostUsd).toEqual([0.5, null, null])
    expect(timelineLayout(turns, [], 200).totalCostUsd).toBe(0)
  })

  test('the cost axis tops out at a round figure over the total, so its middle rung is round too', () => {
    // WHY: the axis says how much was spent; "$48.35" as a rung reads as a
    // measurement, "$50" reads as a scale.
    expect(costAxisTop(48.35)).toBe(50)
    expect(costAxisTop(3.2)).toBe(4)
    expect(costAxisTop(0.42)).toBe(0.5)
    expect(costAxisTop(0)).toBe(0)
  })

  test('the line rides the bars on its own scale: nothing at the floor, the whole at the end', () => {
    const layout = timelineLayout(turns, [5_000], 200, [], [{ startedAt: 0, endedAt: 2 * MINUTE, costUsd: 4 }])
    const rows = timelineChartRows(layout, costAxisTop(4), 0.05)
    expect(rows[0]!.cost).toBeGreaterThan(0)
    expect(rows.at(-1)!.cost).toBe(1)
    // The bars stop short of the top, so the axis's top rung stays clear of them.
    expect(Math.max(...rows.map((row) => row.own?.[1] ?? 0))).toBeLessThan(1)
    expect(rows.every((row, index) => index === 0 || row.cost >= rows[index - 1]!.cost)).toBe(true)
  })
})
