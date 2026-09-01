import { describe, expect, test } from 'bun:test'
import { sessionContextBuckets } from '@solus/workspace-ui/components/insights/lib/session-context'
import {
  promptsByTrace,
  sessionSummaryView,
} from '@solus/workspace-ui/components/insights/lib/session-summary'
import type { TurnRow } from '@solus/workspace-ui/components/insights/lib/turn-rows'
import type { MetricsSessionSummary } from '@solus/contracts/observability-types'

const FROM = 1_000_000
const TO = FROM + 10_000

function turn(partial: Partial<TurnRow> & { traceId: string; startedAt: number }): TurnRow {
  return {
    sessionId: 'session-a',
    durationMs: 1000,
    status: 'ok',
    model: 'claude',
    provider: 'claude-code',
    origin: 'typed',
    promptSource: null,
    prompt: '',
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    toolCallCount: null,
    ...partial,
  }
}

function buckets(rows: TurnRow[], currentTraceId = 'a1', count = 10) {
  return sessionContextBuckets({
    rows,
    sessionId: 'session-a',
    currentTraceId,
    currentStartedAt: FROM,
    from: FROM,
    to: TO,
    count,
  })
}

describe('Insights session strip counts', () => {
  // Why it matters: the three bar layers are three readings of one bucketing.
  // Counting this session separately is what keeps its bars from disappearing
  // into a backdrop drawn from the same turns.
  test('a bucket counts this session apart from every other one in it', () => {
    const built = buckets([
      turn({ traceId: 'other', startedAt: FROM + 100, sessionId: 'session-b' }),
      turn({ traceId: 'mine', startedAt: FROM + 200 }),
    ])
    expect(built[0].total).toBe(2)
    expect(built[0].sessionCount).toBe(1)
  })

  test('a failed turn is counted as one', () => {
    const built = buckets([turn({ traceId: 'a1', startedAt: FROM + 100, status: 'error' })])
    expect(built[0].failed).toBe(1)
  })

  test('the turn being read marks its bar even when the answer never listed it', () => {
    const built = sessionContextBuckets({
      rows: [],
      sessionId: 'session-a',
      currentTraceId: 'deep-linked',
      currentStartedAt: FROM + 500,
      from: FROM,
      to: TO,
      count: 10,
    })
    expect(built.filter((bar) => bar.isCurrent)).toHaveLength(1)
  })

  test('a turn outside the window is dropped rather than piled onto an edge bar', () => {
    const built = buckets([turn({ traceId: 'late', startedAt: TO + 5000 })])
    expect(built.every((bar) => bar.total === 0)).toBe(true)
  })
})

const SESSION: MetricsSessionSummary = {
  sessionId: 'session-a',
  turnCount: 3,
  totalDurationMs: 6000,
  totalCostUsd: 0.5,
  totalInputTokens: 100,
  totalOutputTokens: 50,
  turns: [
    {
      turnNumber: 1,
      traceId: 'a1',
      startedAt: FROM,
      endedAt: FROM + 1000,
      durationMs: 1000,
      status: 'ok',
      model: 'claude',
      origin: 'typed',
      promptSource: null,
      prompt: null,
      costUsd: 0.1,
      inputTokens: 10,
      outputTokens: 5,
      toolCallCount: 1,
    },
    {
      turnNumber: 2,
      traceId: 'a2',
      startedAt: FROM + 2000,
      endedAt: FROM + 6000,
      durationMs: 4000,
      status: 'error',
      model: 'claude',
      origin: 'typed',
      promptSource: null,
      prompt: null,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      toolCallCount: null,
    },
    {
      turnNumber: 3,
      traceId: 'a3',
      startedAt: FROM + 7000,
      endedAt: null,
      durationMs: null,
      status: 'ok',
      model: null,
      origin: 'typed',
      promptSource: null,
      prompt: null,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      toolCallCount: null,
    },
  ],
}

describe('Insights session summary', () => {
  // Why it matters: the card exists to answer "where am I in this session".
  test('it states the reader’s place in the session', () => {
    const view = sessionSummaryView(SESSION, new Map(), 'a2', null)
    expect(view.position).toBe(2)
    expect(view.turnCount).toBe(3)
  })

  test('a turn the session does not hold leaves the place unclaimed', () => {
    const view = sessionSummaryView(SESSION, new Map(), 'elsewhere', null)
    expect(view.position).toBe(0)
  })

  test('a row is named by what was asked when the answer carries the text', () => {
    const prompts = promptsByTrace([
      turn({ traceId: 'a1', startedAt: FROM, prompt: 'fix   the\nflaky test' }),
      turn({ traceId: 'a2', startedAt: FROM, prompt: '   ' }),
    ])
    const view = sessionSummaryView(SESSION, prompts, 'a1', 'Flaky test hunt')
    expect(view.rows[0].title).toBe('fix the flaky test')
    // No prompt text: the session's own name, never the model. A column of
    // repeated model ids names nothing a reader was looking for.
    expect(view.rows[1].title).toBe('Flaky test hunt')
    expect(view.rows[2].title).toBe('Flaky test hunt')
    expect(view.rows.some((row) => row.title === 'claude')).toBe(false)
  })

  test('a turn outside the answer is named by the ask the rollup carries', () => {
    // WHY: the session name is the same on every row, so a card falling back to
    // it names none of them. The rollup's own capped prompt outranks it.
    const session: MetricsSessionSummary = {
      ...SESSION,
      turns: SESSION.turns.map((turnSummary, index) =>
        index === 1 ? { ...turnSummary, prompt: 'rerun the suite' } : turnSummary,
      ),
    }
    const view = sessionSummaryView(session, new Map(), 'a1', 'Flaky test hunt')
    expect(view.rows[1].title).toBe('rerun the suite')
    expect(view.rows[0].title).toBe('Flaky test hunt')
  })

  test('a session the host no longer names falls back to a stated absence', () => {
    const view = sessionSummaryView(SESSION, new Map(), 'a1', null)
    expect(view.rows[0].title).toBe('No prompt text recorded')
  })

  test('a failed turn is marked, so the thread shows where it broke', () => {
    const view = sessionSummaryView(SESSION, new Map(), 'a1', null)
    expect(view.rows[1].failed).toBe(true)
    expect(view.rows[0].failed).toBe(false)
  })

  test('the measures a row drops travel with it, for the hover card', () => {
    // WHY: the row prints three things. Everything else the rollup recorded has
    // to survive the view or the hover card has nothing to answer with.
    const view = sessionSummaryView(SESSION, new Map(), 'a1', null)
    expect(view.rows[0].model).toBe('claude')
    expect(view.rows[0].tokens).toBe(15)
    expect(view.rows[0].status).toBe('ok')
    expect(view.rows[2].tokens).toBeNull()
  })
})

