import { describe, expect, test } from 'bun:test'
import type { MetricsSpan, MetricsTurnTrace } from '../../src/shared/observability-types'
import {
  barExtent,
  buildTraceView,
  rowsByKind,
  spanAttributes,
  spanDetailLabel,
  spanPayload,
  unionLength,
  WATERFALL_MIN_BAR_FRACTION,
} from '../../src/renderer/components/insights/lib/waterfall'
import { valueColumnAtCursor } from '../../src/renderer/components/insights/lib/sql-editor-extensions'

// Child spans may overlap — parallel tools, a tool nested inside another — so
// every rollup here has to union intervals. Summing durations would report more
// time inside a turn than the turn itself took, which is the bug these tests
// exist to prevent.

function span(overrides: Partial<MetricsSpan> & Pick<MetricsSpan, 'spanId' | 'startedAt'>): MetricsSpan {
  return {
    parentSpanId: null,
    traceId: 'tr_1',
    kind: 'tool_call',
    name: 'Bash',
    service: 'solus.sessions',
    sessionId: 's_1',
    provider: 'claude',
    model: 'claude-fable-5',
    projectRoot: '/repo',
    origin: 'typed',
    endedAt: overrides.startedAt + 100,
    durationMs: 100,
    status: 'ok',
    attrs: {},
    ...overrides,
  }
}

const root = span({
  spanId: 'root',
  kind: 'turn',
  name: 'turn',
  startedAt: 1_000,
  endedAt: 2_000,
  durationMs: 1_000,
  attrs: { prompt: 'run the build', costUsd: 0.4 },
})

function trace(spans: MetricsSpan[], uninstrumentedMs: number | null = null): MetricsTurnTrace {
  return { traceId: 'tr_1', spans, uninstrumentedMs }
}

describe('unionLength', () => {
  test('overlapping intervals are counted once', () => {
    expect(unionLength([{ from: 0, to: 100 }, { from: 50, to: 150 }])).toBe(150)
  })

  test('disjoint intervals add up', () => {
    expect(unionLength([{ from: 0, to: 100 }, { from: 200, to: 250 }])).toBe(150)
  })

  test('a fully contained interval adds nothing', () => {
    expect(unionLength([{ from: 0, to: 100 }, { from: 20, to: 40 }])).toBe(100)
  })
})

describe('buildTraceView', () => {
  test('an empty trace has no view to render', () => {
    expect(buildTraceView(trace([]))).toBeNull()
    expect(buildTraceView(null)).toBeNull()
  })

  test('the root turn leads and children nest under their parent', () => {
    const child = span({ spanId: 'c1', parentSpanId: 'root', startedAt: 1_100 })
    const grandchild = span({ spanId: 'c2', parentSpanId: 'c1', startedAt: 1_120 })
    const view = buildTraceView(trace([root, grandchild, child]))
    expect(view?.rows.map((row) => [row.spanId, row.depth])).toEqual([
      ['root', 0],
      ['c1', 1],
      ['c2', 2],
    ])
  })

  test('a span whose parent is missing attaches to the root rather than vanishing', () => {
    const orphan = span({ spanId: 'orphan', parentSpanId: 'dropped', startedAt: 1_200 })
    const view = buildTraceView(trace([root, orphan]))
    expect(view?.rows.map((row) => row.spanId)).toContain('orphan')
    expect(view?.rows.find((row) => row.spanId === 'orphan')?.depth).toBe(1)
  })

  test('siblings are ordered by start time, not by arrival', () => {
    const late = span({ spanId: 'late', parentSpanId: 'root', startedAt: 1_500 })
    const early = span({ spanId: 'early', parentSpanId: 'root', startedAt: 1_100 })
    const view = buildTraceView(trace([root, late, early]))
    expect(view?.rows.slice(1).map((row) => row.spanId)).toEqual(['early', 'late'])
  })

  test('bars are positioned against the root interval', () => {
    const child = span({ spanId: 'c1', parentSpanId: 'root', startedAt: 1_500, endedAt: 1_750, durationMs: 250 })
    const view = buildTraceView(trace([root, child]))
    const row = view?.rows.find((candidate) => candidate.spanId === 'c1')
    expect(row?.left).toBeCloseTo(50)
    expect(row?.width).toBeCloseTo(25)
    expect(row?.share).toBeCloseTo(0.25)
  })

  test('two overlapping tool calls contribute their union to the kind legend', () => {
    const first = span({ spanId: 'a', parentSpanId: 'root', startedAt: 1_000, endedAt: 1_400, durationMs: 400 })
    const second = span({ spanId: 'b', parentSpanId: 'root', startedAt: 1_200, endedAt: 1_600, durationMs: 400 })
    const view = buildTraceView(trace([root, first, second]))
    const tools = view?.legend.find((entry) => entry.kind === 'tool_call')
    expect(tools?.ms).toBe(600)
    expect(tools?.share).toBeCloseTo(0.6)
  })

  test('uninstrumented time leads the legend when the server derived it', () => {
    const child = span({ spanId: 'c1', parentSpanId: 'root', startedAt: 1_000, endedAt: 1_400, durationMs: 400 })
    const view = buildTraceView(trace([root, child], 600))
    expect(view?.legend[0]).toMatchObject({ kind: 'uninstrumented', ms: 600 })
  })

  test('tool totals group repeat calls of the same tool', () => {
    const first = span({ spanId: 'a', parentSpanId: 'root', name: 'Bash', startedAt: 1_000, endedAt: 1_200, durationMs: 200 })
    const second = span({ spanId: 'b', parentSpanId: 'root', name: 'Bash', startedAt: 1_300, endedAt: 1_500, durationMs: 200 })
    const read = span({ spanId: 'c', parentSpanId: 'root', name: 'Read', startedAt: 1_600, endedAt: 1_650, durationMs: 50 })
    const view = buildTraceView(trace([root, first, second, read]))
    expect(view?.toolTotals[0]).toMatchObject({ tool: 'Bash', calls: 2, ms: 400 })
    expect(view?.toolTotals[1]).toMatchObject({ tool: 'Read', calls: 1 })
  })

  test('a denied permission is surfaced separately from the waterfall', () => {
    const denial = span({
      spanId: 'p1',
      parentSpanId: 'root',
      kind: 'permission_wait',
      name: 'Bash',
      startedAt: 1_100,
      attrs: { decision: 'denied' },
    })
    const granted = span({
      spanId: 'p2',
      parentSpanId: 'root',
      kind: 'permission_wait',
      name: 'Edit',
      startedAt: 1_300,
      attrs: { decision: 'granted' },
    })
    const view = buildTraceView(trace([root, denial, granted]))
    expect(view?.deniedPermissions.map((entry) => entry.spanId)).toEqual(['p1'])
  })

  test('an open span with no end still gets a placeable bar', () => {
    const open = span({ spanId: 'open', parentSpanId: 'root', startedAt: 1_400, endedAt: null, durationMs: null })
    const row = buildTraceView(trace([root, open]))?.rows.find((candidate) => candidate.spanId === 'open')
    expect(row?.durationMs).toBeNull()
    expect(row?.width).toBeGreaterThan(0)
  })
})

describe('chart accessors', () => {
  // The waterfall is a LayerChart ranged bar chart: every bar is placed by one
  // shared x scale, and these two accessors are the whole interface to it.
  const rowsOf = (spans: MetricsSpan[]) => buildTraceView(trace(spans))?.rows ?? []

  test('a bar spans the row’s own interval in trace milliseconds', () => {
    const child = span({ spanId: 'c', parentSpanId: 'root', startedAt: 1_300, endedAt: 1_800, durationMs: 500 })
    const row = rowsOf([root, child]).find((candidate) => candidate.spanId === 'c')!
    expect(barExtent(row, 1_000)).toEqual([300, 800])
  })

  test('a span too brief to see still gets a clickable extent', () => {
    const brief = span({ spanId: 'c', parentSpanId: 'root', startedAt: 1_100, endedAt: 1_100, durationMs: 0 })
    const row = rowsOf([root, brief]).find((candidate) => candidate.spanId === 'c')!
    const [start, end] = barExtent(row, 1_000)
    expect(end - start).toBeCloseTo(1_000 * WATERFALL_MIN_BAR_FRACTION)
  })

  test('an open span gets an extent rather than a zero-width bar', () => {
    const open = span({ spanId: 'c', parentSpanId: 'root', startedAt: 1_500, endedAt: null, durationMs: null })
    const row = rowsOf([root, open]).find((candidate) => candidate.spanId === 'c')!
    const [start, end] = barExtent(row, 1_000)
    expect(end).toBeGreaterThan(start)
  })

  test('rows group by kind so each layer keeps its own fixed colour', () => {
    const tool = span({ spanId: 't', parentSpanId: 'root', startedAt: 1_100 })
    const wait = span({ spanId: 'w', parentSpanId: 'root', kind: 'permission_wait', startedAt: 1_200 })
    const secondTool = span({ spanId: 't2', parentSpanId: 'root', startedAt: 1_300 })
    const groups = rowsByKind(rowsOf([root, tool, wait, secondTool]))
    expect(groups.map((group) => group.kind)).toEqual(['turn', 'tool_call', 'permission_wait'])
    expect(groups.find((group) => group.kind === 'tool_call')?.rows).toHaveLength(2)
  })

  test('every row lands in exactly one layer, so none is dropped from the plot', () => {
    const rows = rowsOf([
      root,
      span({ spanId: 'a', parentSpanId: 'root', startedAt: 1_100 }),
      span({ spanId: 'b', parentSpanId: 'root', kind: 'setup', startedAt: 1_200 }),
    ])
    const plotted = rowsByKind(rows).flatMap((group) => group.rows)
    expect(plotted).toHaveLength(rows.length)
  })
})

describe('span detail rendering', () => {
  test('a tool call is labelled by the command it ran', () => {
    const toolCall = span({
      spanId: 'a',
      startedAt: 0,
      attrs: { input: JSON.stringify({ command: 'bun run build' }) },
    })
    expect(spanDetailLabel(toolCall)).toBe('bun run build')
  })

  test('truncated input is shown as-is rather than dropped', () => {
    const toolCall = span({ spanId: 'a', startedAt: 0, attrs: { input: '{"command":"bun run bui' } })
    expect(spanDetailLabel(toolCall)).toBe('{"command":"bun run bui')
  })

  test('the payload block names truncation when the emitter capped the value', () => {
    const toolCall = span({
      spanId: 'a',
      startedAt: 0,
      attrs: { input: '{"command":"x"}', inputTruncated: true },
    })
    expect(spanPayload(toolCall)?.label).toBe('Input (truncated)')
  })

  test('attributes exclude the payload fields, which get their own block', () => {
    const toolCall = span({
      spanId: 'a',
      startedAt: 0,
      attrs: { input: '{}', exitCode: 0, isSubagent: false },
    })
    const keys = spanAttributes(toolCall).map((attribute) => attribute.key)
    expect(keys).not.toContain('input')
    expect(keys).toEqual(['exit code', 'is subagent'])
  })
})

describe('SQL value completion', () => {
  test('a literal compared against a registered column offers its values', () => {
    expect(valueColumnAtCursor("select * from tool_calls where tool = 'Ba")).toBe('tool')
    expect(valueColumnAtCursor("select * from turns where model in ('cla")).toBe('model')
    expect(valueColumnAtCursor("select * from turns where status like 'er")).toBe('status')
  })

  test('an unregistered column offers nothing — there is no cheap distinct for it', () => {
    expect(valueColumnAtCursor("select * from turns where prompt = 'hel")).toBeNull()
  })

  test('a cursor outside a string literal is not a value position', () => {
    expect(valueColumnAtCursor('select * from turns where duration_ms > 100')).toBeNull()
  })
})
