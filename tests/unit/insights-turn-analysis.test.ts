import { describe, expect, test } from 'bun:test'
import type { MetricsSessionSummary, MetricsSpan, MetricsTurnTrace } from '@solus/contracts/observability-types'
import {
  annotateStats,
  cacheEconomics,
  contextGrowth,
  firstFailingSpanId,
  modelChoiceHint,
  repeatedCalls,
  subagentRollup,
  traceExportJson,
  turnBaselines,
  turnFindings,
  waitingOn,
} from '@solus/workspace-ui/components/insights/lib/turn-analysis'
import { turnStats } from '@solus/workspace-ui/components/insights/lib/turn-attributes'
import { buildTraceView } from '@solus/workspace-ui/components/insights/lib/waterfall'

// The readings a person makes when they ask "why was this slow" or "why did
// this cost that". Each test holds one claim the page prints: the number it
// shows is derived from the trace as recorded, and where the record cannot
// answer the reading says so instead of printing a zero.

function span(overrides: Partial<MetricsSpan> & Pick<MetricsSpan, 'spanId' | 'startedAt'>): MetricsSpan {
  return {
    parentSpanId: 'root',
    traceId: 'tr_1',
    kind: 'tool_call',
    name: 'Bash',
    service: 'solus.sessions',
    sessionId: 's_1',
    provider: 'claude-code',
    model: 'claude-opus-5-5',
    projectRoot: '/repo',
    origin: 'typed',
    endedAt: overrides.startedAt + 100,
    durationMs: 100,
    status: 'ok',
    attrs: {},
    ...overrides,
  }
}

function rootOf(attrs: MetricsSpan['attrs'] = {}, overrides: Partial<MetricsSpan> = {}): MetricsSpan {
  return span({
    spanId: 'root',
    parentSpanId: null,
    kind: 'turn',
    name: 'turn',
    startedAt: 1_000,
    endedAt: 2_000,
    durationMs: 1_000,
    attrs,
    ...overrides,
  })
}

function traceOf(spans: MetricsSpan[], providerWaitMs: number | null = null): MetricsTurnTrace {
  return { traceId: 'tr_1', spans, logEvents: [], providerWaitMs, gapSegments: [] }
}

function bash(spanId: string, startedAt: number, command: string, extra: Partial<MetricsSpan> = {}): MetricsSpan {
  return span({ spanId, startedAt, attrs: { input: JSON.stringify({ command }) }, ...extra })
}

describe('cache economics', () => {
  test('the hit rate is reads over everything the model was given', () => {
    const cache = cacheEconomics(rootOf({ inputTokens: 100, cacheReadTokens: 900, cacheCreationTokens: 0 }))
    expect(cache?.hitRate).toBeCloseTo(0.9)
  })

  test('dollars saved are solved from the turn’s own cost, never a price table', () => {
    // WHY: a price table goes stale per model. The turn reported what it cost;
    // the provider's rate ratios say what the reads would have cost fresh.
    const root = rootOf({ costUsd: 1, inputTokens: 1_000, cacheReadTokens: 10_000, outputTokens: 0 })
    const cache = cacheEconomics(root)
    // rate r: 1 = 1000r + 10000·0.1r = 2000r → r = 0.0005; saved = 10000·r·0.9 = 4.5
    expect(cache?.savedUsd).toBeCloseTo(4.5)
    expect(cache?.basis).toContain('reported cost')
  })

  test('a turn with no reported cost prices nothing and says why', () => {
    const cache = cacheEconomics(rootOf({ inputTokens: 100, cacheReadTokens: 900 }))
    expect(cache?.savedUsd).toBeNull()
    expect(cache?.basis).toContain('no cost')
  })

  test('a turn that reported no cache figures has no economics at all', () => {
    expect(cacheEconomics(rootOf({ inputTokens: 100 }))).toBeNull()
  })
})

describe('waiting on', () => {
  test('a tool behind a permission dialog charges the dialog to the person, not the tool', () => {
    const view = buildTraceView(
      traceOf([
        rootOf(),
        span({ spanId: 'tool', startedAt: 1_100, endedAt: 1_500, durationMs: 400 }),
        span({ spanId: 'perm', kind: 'permission_wait', startedAt: 1_100, endedAt: 1_300, durationMs: 200 }),
      ]),
    )!
    const waits = waitingOn(view)
    expect(waits.find((entry) => entry.party === 'user')?.ms).toBe(200)
    expect(waits.find((entry) => entry.party === 'tools')?.ms).toBe(200)
  })

  test('unrecorded time stays in coverage and does not blame the provider', () => {
    const root = rootOf()
    const trace = traceOf([root])
    const view = buildTraceView(trace)!
    view.gapSummaries = [{
      category: 'between_activities', label: 'Between activities',
      description: '', ms: 380, share: 0.38, segments: 1,
    }]
    expect(waitingOn(view)).toContainEqual(expect.objectContaining({
      party: 'unrecorded', label: 'Unrecorded', ms: 380,
    }))
    expect(waitingOn(view).find((entry) => entry.party === 'provider')).toBeUndefined()
    expect(turnFindings(root, view, trace, null).some((finding) => finding.title.includes('provider'))).toBe(false)
  })

  test('shares are of the whole turn, longest first', () => {
    const view = buildTraceView(
      traceOf([rootOf(), span({ spanId: 'think', kind: 'thinking', startedAt: 1_000, endedAt: 1_500, durationMs: 500 })]),
    )!
    const waits = waitingOn(view)
    expect(waits[0]).toMatchObject({ party: 'model', share: 0.5 })
  })

  test('the queue wait before the turn is charged to nobody inside it', () => {
    // WHY: a prompt queued for twice the turn's length printed "Solus 200%".
    // The wait precedes the root; it is no share of the turn's wall clock.
    const view = buildTraceView(
      traceOf([
        rootOf(),
        span({ spanId: 'queue', kind: 'queue_wait', name: 'queue_wait', startedAt: -1_000, endedAt: 1_000, durationMs: 2_000 }),
        span({ spanId: 'setup', kind: 'setup', name: 'setup', startedAt: 1_000, endedAt: 1_100, durationMs: 100 }),
      ]),
    )!
    const solus = waitingOn(view).find((entry) => entry.party === 'solus')
    expect(solus).toMatchObject({ ms: 100, share: 0.1 })
  })
})

describe('repeated calls', () => {
  test('missing web inputs do not prove repetition in old traces', () => {
    for (const input of ['{"query":""}', '{"query":"","action":null}', '{"query":"","action":{"type":"other"}}']) {
      expect(repeatedCalls([
        span({ spanId: 'a', name: 'WebSearch', attrs: { input } }),
        span({ spanId: 'b', name: 'WebSearch', attrs: { input } }),
      ])).toEqual([])
    }
    const input = JSON.stringify({ query: '', action: { type: 'search', queries: ['real query'] } })
    expect(repeatedCalls([
      span({ spanId: 'a', name: 'WebSearch', attrs: { input } }),
      span({ spanId: 'b', name: 'WebSearch', attrs: { input } }),
    ])).toHaveLength(1)
  })

  test('the same command twice is a repeat; whitespace is not a difference', () => {
    const repeats = repeatedCalls([
      rootOf(),
      bash('a', 1_100, 'bun test  tests/unit/a.test.ts'),
      bash('b', 1_300, 'bun test tests/unit/a.test.ts'),
      bash('c', 1_500, 'bun test tests/unit/b.test.ts'),
    ])
    expect(repeats).toHaveLength(1)
    expect(repeats[0]).toMatchObject({ tool: 'Bash', spanIds: ['a', 'b'], totalMs: 200 })
  })

  test('an input with no command or path names its fields rather than a cut JSON head', () => {
    const input = JSON.stringify({ browserPageId: 'browser_50d32536-a0d4-44c1-bb9b-66305ecce13d', action: 'reload' })
    const call = (spanId: string, startedAt: number) =>
      span({ spanId, startedAt, name: 'mcp__solus__browser_navigate', attrs: { input } })
    const [repeat] = repeatedCalls([rootOf(), call('a', 1_100), call('b', 1_300)])
    expect(repeat.detail).toBe('action: reload · browserPageId: browser_50d32536-a0d4-44c1-bb9b…')
  })
})

describe('baselines', () => {
  const session: MetricsSessionSummary = {
    sessionId: 's_1',
    turnCount: 4,
    totalDurationMs: 0,
    totalCostUsd: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    turns: [
      { turnNumber: 1, traceId: 'tr_0', startedAt: 0, endedAt: 100, durationMs: 100, status: 'ok', model: 'm', origin: null, promptSource: null, prompt: null, costUsd: 0.1, inputTokens: 10, outputTokens: 10, toolCallCount: 0 },
      { turnNumber: 2, traceId: 'tr_x', startedAt: 0, endedAt: 300, durationMs: 300, status: 'ok', model: 'm', origin: null, promptSource: null, prompt: null, costUsd: 0.3, inputTokens: 10, outputTokens: 10, toolCallCount: 0 },
      { turnNumber: 3, traceId: 'tr_1', startedAt: 0, endedAt: 1_000, durationMs: 1_000, status: 'ok', model: 'm', origin: null, promptSource: null, prompt: null, costUsd: 1, inputTokens: 10, outputTokens: 10, toolCallCount: 0 },
    ],
  }

  test('this turn is measured against the other turns, never against itself', () => {
    const [duration] = turnBaselines(rootOf(), session, [])
    expect(duration.sessionMedian).toBe('200ms')
    expect(duration.sessionRatio).toBeCloseTo(5)
  })

  test('one neighbour is not a baseline', () => {
    const one = { ...session, turns: session.turns.slice(1) }
    expect(turnBaselines(rootOf(), one, [])[0].sessionMedian).toBeNull()
  })

  test('the stat row carries the comparison and turns warning past twice the median', () => {
    const root = rootOf()
    const view = buildTraceView(traceOf([root]))!
    const stats = annotateStats(turnStats(root, view), turnBaselines(root, session, []), null, null)
    const duration = stats.find((stat) => stat.label === 'Duration')
    expect(duration?.note).toContain('5.0× the session median of 200ms')
    expect(duration?.tone).toBe('warning')
    // A figure far above its median says so on the tile, not only on hover.
    expect(duration?.detail).toBe('5.0× session median')
    // The tile judges the figure: a badge, and a meter with the median marked.
    expect(duration?.verdict).toEqual({ kind: 'bad', glyph: 'up', label: 'Slow' })
    expect(duration?.meter?.fill).toBe(1)
  })

  test('a figure well under its median is judged good, one near it typical', () => {
    const root = rootOf({ costUsd: 1 })
    const view = buildTraceView(traceOf([root]))!
    const cheap = { ...session, turns: session.turns.map((turn) => (turn.traceId === 'tr_1' ? turn : { ...turn, costUsd: 5 })) }
    const near = { ...session, turns: session.turns.map((turn) => (turn.traceId === 'tr_1' ? turn : { ...turn, durationMs: 900 })) }
    const cost = annotateStats(turnStats(root, view), turnBaselines(root, cheap, []), null, null).find((stat) => stat.label === 'Cost')
    const duration = annotateStats(turnStats(root, view), turnBaselines(root, near, []), null, null).find((stat) => stat.label === 'Duration')
    expect(cost?.verdict).toEqual({ kind: 'good', glyph: 'down', label: 'Cheap' })
    expect(duration?.verdict).toEqual({ kind: 'usual', glyph: 'even', label: 'Typical' })
  })

  test('without a baseline the figure is stated, not judged', () => {
    const root = rootOf()
    const view = buildTraceView(traceOf([root]))!
    const duration = annotateStats(turnStats(root, view), turnBaselines(root, null, []), null, null).find((stat) => stat.label === 'Duration')
    expect(duration?.verdict).toBeUndefined()
    expect(duration?.meter).toBeUndefined()
  })
})

describe('context growth', () => {
  const session: MetricsSessionSummary = {
    sessionId: 's_1',
    turnCount: 2,
    totalDurationMs: 0,
    totalCostUsd: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    turns: [
      { turnNumber: 1, traceId: 'tr_0', startedAt: 0, endedAt: 1, durationMs: 1, status: 'ok', model: 'm', origin: null, promptSource: null, prompt: null, costUsd: null, inputTokens: null, outputTokens: null, contextUsedTokens: 40_000, toolCallCount: 0 },
      { turnNumber: 2, traceId: 'tr_1', startedAt: 0, endedAt: 1, durationMs: 1, status: 'ok', model: 'm', origin: null, promptSource: null, prompt: null, costUsd: null, inputTokens: null, outputTokens: null, contextUsedTokens: 80_000, toolCallCount: 0 },
    ],
  }

  test('fill is against the window, delta is against the previous turn', () => {
    const growth = contextGrowth(rootOf({ contextUsedTokens: 80_000, contextWindow: 100_000 }), session)
    expect(growth).toMatchObject({ fill: 0.8, deltaTokens: 40_000 })
  })

  test('a turn that recorded no context reading has no stat rather than a 0%', () => {
    expect(contextGrowth(rootOf({ contextWindow: 100_000 }), session)).toBeNull()
  })

  test('the stat row adds a Context figure that warns when the window is mostly full', () => {
    const root = rootOf({ contextUsedTokens: 80_000, contextWindow: 100_000 })
    const view = buildTraceView(traceOf([root]))!
    const context = annotateStats(turnStats(root, view), [], null, contextGrowth(root, session)).find(
      (stat) => stat.label === 'Context',
    )
    expect(context?.value).toBe('80% full')
    expect(context?.note).toContain('+40.0k since the previous turn')
    expect(context?.tone).toBe('warning')
  })
})

describe('errors first', () => {
  test('a failed turn opens on the tool that was refused, not the stream that failed after it', () => {
    const view = buildTraceView(
      traceOf([
        rootOf({}, { status: 'error' }),
        span({ spanId: 'stream', kind: 'response_stream', startedAt: 1_050, status: 'error' }),
        span({ spanId: 'tool', startedAt: 1_100, status: 'error', attrs: { error: 'exit 1' } }),
      ]),
    )!
    expect(firstFailingSpanId(view)).toBe('tool')
    const findings = turnFindings(view.root!, view, traceOf(view.rows.map((row) => row.span!)), null)
    expect(findings[0]).toMatchObject({ id: 'failure', tone: 'failure', detail: 'exit 1', spanIds: ['tool'] })
  })

  test('a turn that succeeded has no failure to open on', () => {
    expect(firstFailingSpanId(buildTraceView(traceOf([rootOf()]))!)).toBeNull()
  })
})

describe('model choice', () => {
  test('a top-tier model on a read-only lookup gets the hint, with the cost it implies', () => {
    const hint = modelChoiceHint(rootOf({ outputTokens: 300, costUsd: 1 }), [
      span({ spanId: 'r', startedAt: 1_100, name: 'Read' }),
      bash('g', 1_200, 'git status'),
    ])
    expect(hint?.title).toContain('Read-only turn')
    expect(hint?.estimatedUsd).toBeCloseTo(0.2)
  })

  test('one edit, one subagent, or a long answer withholds the hint', () => {
    expect(modelChoiceHint(rootOf({ outputTokens: 300 }), [span({ spanId: 'e', startedAt: 1_100, name: 'Edit' })])).toBeNull()
    expect(modelChoiceHint(rootOf({ outputTokens: 300 }), [span({ spanId: 'r', startedAt: 1_100, name: 'Read' }), span({ spanId: 'a', startedAt: 1_200, kind: 'agent_run', name: 'Task' })])).toBeNull()
    expect(modelChoiceHint(rootOf({ outputTokens: 5_000 }), [span({ spanId: 'r', startedAt: 1_100, name: 'Read' })])).toBeNull()
  })

  test('a model without a cheaper tier gets no hint', () => {
    expect(modelChoiceHint(rootOf({ outputTokens: 300 }, { model: 'claude-sonnet-5' }), [span({ spanId: 'r', startedAt: 1_100, name: 'Read' })])).toBeNull()
  })
})

describe('subagents', () => {
  test('an agent run rolls up what it holds', () => {
    const view = buildTraceView(
      traceOf([
        rootOf(),
        span({ spanId: 'agent', kind: 'agent_run', name: 'Task', startedAt: 1_100, endedAt: 1_600, durationMs: 500 }),
        span({ spanId: 'in1', parentSpanId: 'agent', startedAt: 1_150 }),
        span({ spanId: 'in2', parentSpanId: 'agent', startedAt: 1_300, status: 'error' }),
        span({ spanId: 'after', startedAt: 1_700 }),
      ]),
    )!
    expect(subagentRollup(view, 'agent')).toEqual({ spanCount: 2, toolCallCount: 2, activeMs: 200, errorCount: 1 })
    expect(subagentRollup(view, 'after')).toBeNull()
  })
})

describe('export and links', () => {
  test('the export carries the spans and the readings, as one document', () => {
    const root = rootOf({ costUsd: 0.5 })
    const trace = traceOf([root, bash('a', 1_100, 'ls'), bash('b', 1_200, 'ls')])
    const view = buildTraceView(trace)!
    const exported = JSON.parse(traceExportJson(trace, view, root))
    expect(exported.spans).toHaveLength(3)
    expect(exported.summary.repeatedCalls).toHaveLength(1)
  })
})
