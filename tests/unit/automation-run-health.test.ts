import { describe, expect, test } from 'bun:test'
import { countdown, runHealth } from '@solus/workspace-ui/components/automations/lib/automation-format'
import type { AutomationRun, AutomationRunStatus } from '@solus/contracts/types'

/** A finished run `seconds` long, started at a fixed instant. */
function run(id: string, seconds: number, status: AutomationRunStatus = 'succeeded'): AutomationRun {
  return {
    id,
    automationId: 'automation-1',
    startedAt: '2026-07-18T12:00:00.000Z',
    finishedAt: new Date(Date.parse('2026-07-18T12:00:00.000Z') + seconds * 1000).toISOString(),
    status,
  }
}

describe('runHealth', () => {
  test('reads oldest to newest so the sparkline trends left to right', () => {
    // The store keeps runs newest-first; drawn in that order the trend — and the
    // highlight on the most recent bar — would point the wrong way.
    const { bars } = runHealth([run('newest', 10), run('middle', 10), run('oldest', 10)])
    expect(bars.map((b) => b.id)).toEqual(['oldest', 'middle', 'newest'])
    expect(bars.filter((b) => b.latest).map((b) => b.id)).toEqual(['newest'])
  })

  test('only counts runs that did what they were asked as clean', () => {
    // "16 of 17 clean" is a reliability claim. A cancelled or in-flight run is
    // not evidence the automation works, so it must not inflate the count.
    const runs = [
      run('a', 10, 'succeeded'),
      run('b', 10, 'succeeded'),
      run('c', 10, 'failed'),
      run('d', 10, 'cancelled'),
      run('e', 10, 'running'),
    ]
    const { clean, total, successRate } = runHealth(runs)
    expect({ clean, total, successRate }).toEqual({ clean: 2, total: 5, successRate: 40 })
  })

  test('colours each bar by how its run ended', () => {
    // A failure has to stand out from the cancelled and in-flight runs beside
    // it, or the graph hides the one thing a reader scans it for.
    const { bars } = runHealth([
      run('running', 10, 'running'),
      run('cancelled', 10, 'cancelled'),
      run('failed', 10, 'failed'),
      run('succeeded', 10, 'succeeded'),
    ])
    expect(bars.map((b) => [b.id, b.tone])).toEqual([
      ['succeeded', 'success'],
      ['failed', 'error'],
      ['cancelled', 'cancelled'],
      ['running', 'running'],
    ])
  })

  test('colours the success rate as healthy, mixed, or poor', () => {
    // One failure in a full window is noise; a third failing is a pattern.
    const window = (failures: number) =>
      runHealth(Array.from({ length: 17 }, (_, i) => run(`r${i}`, 10, i < failures ? 'failed' : 'succeeded')))
    expect(window(1).rateTone).toBe('good')
    expect(window(4).rateTone).toBe('mixed')
    expect(window(6).rateTone).toBe('poor')
  })

  test('scales bars against the longest run and floors the short ones', () => {
    // Duration is the only signal in the bar's height, so it has to be relative
    // to the window — and a sub-second run still has to draw as a bar, not a gap.
    const { bars } = runHealth([run('slow', 100), run('quick', 1)])
    expect(bars.map((b) => [b.id, b.heightPct])).toEqual([
      ['quick', 18],
      ['slow', 100],
    ])
  })

  test('looks back over a bounded window, not the whole history', () => {
    const { bars, total } = runHealth(
      Array.from({ length: 40 }, (_, i) => run(`run-${i}`, 10)),
    )
    expect(bars).toHaveLength(17)
    expect(total).toBe(17)
    // The window is the 17 most recent, ending on the newest run of all.
    expect(bars.at(-1)?.id).toBe('run-0')
  })
})

describe('countdown', () => {
  const now = Date.parse('2026-07-18T12:00:00.000Z')

  test('reads as two units so "next run in 4h 12m" stays precise and short', () => {
    expect(countdown('2026-07-18T16:12:00.000Z', now)).toBe('4h 12m')
    expect(countdown('2026-07-18T12:40:00.000Z', now)).toBe('40m')
    expect(countdown('2026-07-20T15:00:00.000Z', now)).toBe('2d 3h')
  })

  test('drops the trailing unit when it is zero', () => {
    expect(countdown('2026-07-18T15:00:00.000Z', now)).toBe('3h')
    expect(countdown('2026-07-20T12:00:00.000Z', now)).toBe('2d')
  })

  test('goes empty once the instant has passed rather than counting backwards', () => {
    // A schedule that has fired isn't news; the caller falls back to the state
    // line instead of showing a negative countdown.
    expect(countdown('2026-07-18T11:59:00.000Z', now)).toBe('')
  })
})
