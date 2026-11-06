import { describe, expect, test } from 'bun:test'
import type { MetricsSessionSummary, MetricsTurnSummary } from '@solus/contracts/observability-types'
import { lastCompleteTurn, scrollListToRow } from '@solus/workspace-ui/components/insights/lib/session-summary'

// A session has no page in Insights. Opening one lands on a turn, so the choice
// of turn is the whole behavior.

function sessionOf(...statuses: string[]): MetricsSessionSummary {
  const turns = statuses.map((status, index) => ({ traceId: `trace-${index + 1}`, status }) as MetricsTurnSummary)
  return { sessionId: 'session', turns } as MetricsSessionSummary
}

describe('the turn a session opens on', () => {
  test('is the newest turn of a finished session', () => {
    expect(lastCompleteTurn(sessionOf('ok', 'ok'))?.traceId).toBe('trace-2')
  })

  test('skips the running turn for the one before it', () => {
    expect(lastCompleteTurn(sessionOf('ok', 'ok', 'unknown'))?.traceId).toBe('trace-2')
  })

  test('counts a turn that failed, because it ended', () => {
    expect(lastCompleteTurn(sessionOf('ok', 'error'))?.traceId).toBe('trace-2')
  })

  test('is the running turn when no turn has ended', () => {
    expect(lastCompleteTurn(sessionOf('unknown'))?.traceId).toBe('trace-1')
  })

  test('is nothing when the session recorded no turns', () => {
    expect(lastCompleteTurn(sessionOf())).toBeNull()
  })
})

describe('showing the open turn in the session list', () => {
  // A row in the list's own coordinates: the list shows 100 to 200 on screen.
  function listAndRow(top: number, bottom: number) {
    const list = { scrollTop: 50, getBoundingClientRect: () => ({ top: 100, bottom: 200 }) }
    const row = { getBoundingClientRect: () => ({ top, bottom }) }
    return { list: list as unknown as HTMLElement, row: row as unknown as HTMLElement }
  }

  test('moves the list down by the row hidden below it', () => {
    const { list, row } = listAndRow(190, 220)
    scrollListToRow(list, row)
    expect(list.scrollTop).toBe(70)
  })

  test('moves the list up by the row hidden above it', () => {
    const { list, row } = listAndRow(80, 110)
    scrollListToRow(list, row)
    expect(list.scrollTop).toBe(30)
  })

  test('leaves a row already in view where it is', () => {
    const { list, row } = listAndRow(120, 150)
    scrollListToRow(list, row)
    expect(list.scrollTop).toBe(50)
  })
})
