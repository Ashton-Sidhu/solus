import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MetricsGapSegment, MetricsSpan, MetricsTurnTrace } from '@solus/contracts/observability-types'
import {
  barExtent,
  buildTraceView,
  firstObservedActivityMs,
  hasInternalRows,
  visibleRows,
  spanAttributes,
  spanDetailLabel,
  spanPayload,
  unionLength,
  WATERFALL_MIN_BAR_FRACTION,
} from '@solus/workspace-ui/components/insights/lib/waterfall'
import { valueColumnAtCursor } from '@solus/workspace-ui/components/insights/lib/sql-editor-extensions'

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

function trace(
  spans: MetricsSpan[],
  providerWaitMs: number | null = null,
  gapSegments: MetricsGapSegment[] = [],
): MetricsTurnTrace {
  return { traceId: 'tr_1', spans, providerWaitMs, gapSegments }
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

describe('Solus internals', () => {
  // Dispatch nests: setup holds launch_run, which holds the git command that
  // actually cost the time. Hiding setup has to take the whole branch with it.
  const setup = span({ spanId: 'setup', parentSpanId: 'root', kind: 'setup', name: 'setup', startedAt: 1_010 })
  const launch = span({
    spanId: 'launch', parentSpanId: 'setup', kind: 'internal.dispatch_step', name: 'launch_run', startedAt: 1_020,
  })
  const worktree = span({
    spanId: 'worktree',
    parentSpanId: 'launch',
    kind: 'internal.dispatch_step',
    name: 'worktree_create',
    startedAt: 1_030,
    attrs: { fn: 'createWorktree', file: 'control-plane.ts' },
  })
  const tool = span({ spanId: 'tool', parentSpanId: 'root', startedAt: 1_200 })
  const settlement = span({
    spanId: 'settle', parentSpanId: 'root', kind: 'turn_settlement', name: 'Solus settlement', startedAt: 1_800,
  })
  const view = buildTraceView(trace([root, setup, launch, worktree, tool, settlement]))!

  test('the toggle off leaves the agent\'s own work and nothing of Solus\'s', () => {
    expect(visibleRows(view.rows, false).map((row) => row.spanId)).toEqual(['root', 'tool'])
  })

  test('a hidden step never survives its hidden parent', () => {
    // A dispatch step re-attached to the turn root would read as a top-level
    // phase of the turn, which is precisely what it is not.
    const kept = visibleRows(view.rows, false)
    expect(kept.some((row) => row.kind === 'internal.dispatch_step')).toBe(false)
  })

  test('the toggle on restores every row at its original depth', () => {
    expect(visibleRows(view.rows, true).map((row) => [row.spanId, row.depth])).toEqual([
      ['root', 0], ['setup', 1], ['launch', 2], ['worktree', 3], ['tool', 1], ['settle', 1],
    ])
  })

  // WHY: a dispatch step is Solus's own code, and the reader of one is on their
  // way to it. The step id has to survive verbatim so it can be searched for,
  // and the function it times is what turns the row into a destination.
  test('a dispatch step names the function it times, id intact', () => {
    expect(view.rows.find((row) => row.spanId === 'worktree')?.label)
      .toBe('worktree_create · createWorktree')
  })

  test('a step recorded before call sites were captured still names itself', () => {
    expect(view.rows.find((row) => row.spanId === 'launch')?.label).toBe('launch_run')
  })

  test('a trace with nothing to reveal does not offer the toggle', () => {
    expect(hasInternalRows(view)).toBe(true)
    expect(hasInternalRows(buildTraceView(trace([root, tool]))!)).toBe(false)
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

  test('Solus lifecycle work is named directly in the trace', () => {
    const setup = span({
      spanId: 'setup', parentSpanId: 'root', kind: 'setup', name: 'setup',
      startedAt: 1_000, endedAt: 1_010, durationMs: 10,
    })
    const settlement = span({
      spanId: 'settlement', parentSpanId: 'root', kind: 'turn_settlement', name: 'Solus settlement',
      startedAt: 1_950, endedAt: 2_000, durationMs: 50,
    })
    const view = buildTraceView(trace([root, setup, settlement]))
    expect(view?.rows.find((row) => row.spanId === 'setup')?.label).toBe('Solus setup')
    expect(view?.rows.find((row) => row.spanId === 'settlement')).toMatchObject({
      label: 'Solus settlement', durationMs: 50,
    })
  })

  test('first observed activity ignores setup and finds the earliest agent-output span', () => {
    const setup = span({ spanId: 'setup', parentSpanId: 'root', kind: 'setup', startedAt: 1_000, endedAt: 1_010 })
    const tool = span({ spanId: 'tool', parentSpanId: 'root', startedAt: 1_080, endedAt: 1_100 })
    const response = span({
      spanId: 'response', parentSpanId: 'root', kind: 'response_stream', startedAt: 1_050, endedAt: 1_070,
    })
    const view = buildTraceView(trace([root, setup, tool, response]))
    expect(view && firstObservedActivityMs(view)).toBe(50)
  })

  test('two overlapping tool calls contribute their union to the kind legend', () => {
    const first = span({ spanId: 'a', parentSpanId: 'root', startedAt: 1_000, endedAt: 1_400, durationMs: 400 })
    const second = span({ spanId: 'b', parentSpanId: 'root', startedAt: 1_200, endedAt: 1_600, durationMs: 400 })
    const view = buildTraceView(trace([root, first, second]))
    const tools = view?.legend.find((entry) => entry.kind === 'tool_call')
    expect(tools?.ms).toBe(600)
    expect(tools?.share).toBeCloseTo(0.6)
  })

  test('provider wait leads the legend when the server derived a remainder', () => {
    const child = span({ spanId: 'c1', parentSpanId: 'root', startedAt: 1_000, endedAt: 1_400, durationMs: 400 })
    const view = buildTraceView(trace([root, child], 600))
    expect(view?.legend[0]).toMatchObject({
      kind: 'provider_wait',
      label: 'Provider wait',
      ms: 600,
    })
    expect(view?.traceCoverage).toBeCloseTo(0.4)
  })

  test('gap summaries group lifecycle locations without presenting them as causes', () => {
    const gaps: MetricsGapSegment[] = [
      { category: 'provider_startup', startedAt: 1_000, endedAt: 1_100, durationMs: 100 },
      { category: 'between_activities', startedAt: 1_200, endedAt: 1_300, durationMs: 100 },
      { category: 'between_activities', startedAt: 1_400, endedAt: 1_600, durationMs: 200 },
    ]
    const view = buildTraceView(trace([root], 400, gaps))
    expect(view?.gapSummaries).toEqual([
      expect.objectContaining({
        category: 'between_activities', label: 'Between activities', segments: 2, ms: 300, share: 0.3,
      }),
      expect.objectContaining({
        category: 'provider_startup', label: 'Before first provider event', segments: 1, ms: 100, share: 0.1,
      }),
    ])
  })

  test('keeps between-activity gaps in the summary without interrupting waterfall rows', () => {
    const gaps: MetricsGapSegment[] = [
      { category: 'between_activities', startedAt: 1_200, endedAt: 1_500, durationMs: 300 },
      { category: 'provider_completion', startedAt: 1_800, endedAt: 1_900, durationMs: 100 },
    ]
    const view = buildTraceView(trace([root], 400, gaps))!
    const rows = view.rows.filter((row) => row.kind === 'provider_wait')

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      label: 'Provider completion', startOffsetMs: 800, durationMs: 100, depth: 1,
    })
    expect(rows[0].span?.attrs).toMatchObject({
      category: 'provider_completion',
      description: 'After the last recorded activity, before the provider reported completion.',
    })
    expect(view.gapSummaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'between_activities', ms: 300, segments: 1 }),
    ]))
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

describe('Trace surface composition', () => {
  const waterfall = readFileSync(
    join(import.meta.dir, '../../packages/workspace-ui/src/components/insights/TraceWaterfall.svelte'),
    'utf8',
  )
  const coverage = readFileSync(
    join(import.meta.dir, '../../packages/workspace-ui/src/components/insights/TraceCoverage.svelte'),
    'utf8',
  )

  // Why it matters: the bar on a line already wears its kind's hue. A dot beside
  // the name repeats it and spends the left margin the name needs to stay whole.
  test('a waterfall label carries no coloured dot', () => {
    expect(waterfall).not.toMatch(/size-1\.5[^"]*rounded-full/)
    expect(waterfall).not.toMatch(/rounded-full[^"]*size-1\.5/)
  })

  // Why it matters: a trace can be hundreds of rows long. If the open span's
  // detail only lives at the end of the plot, every pick costs a scroll to the
  // bottom and back, which is the whole complaint the dock exists to answer.
  test('the open span detail docks in view instead of resting at the end of the plot', () => {
    expect(waterfall).toContain('sticky bottom-0')
  })

  test('the docked detail separates itself from the waterfall', () => {
    // WHY: the dock overlaps a card with the same surface colour. Without an
    // lifted shadow, opening it can look like no action occurred.
    expect(waterfall).not.toContain('var(--primary)_36%')
    expect(waterfall).not.toContain('var(--primary)_10%')
    expect(waterfall).toContain('0_1rem_2.5rem_-1rem_rgba(0,0,0,0.3)')
    expect(waterfall).not.toContain('bg-[color-mix(in_oklch,var(--primary)_5%,transparent)]')
  })

  // Why it matters: sticky positions against the nearest scroll container. An
  // `overflow-hidden` Trace card silently becomes that container, and the dock
  // stops following the reader with no error anywhere.
  test('the Trace card does not clip itself into a scroll container', () => {
    const panel = readFileSync(
      join(import.meta.dir, '../../packages/workspace-ui/src/components/insights/TurnDetailPanel.svelte'),
      'utf8',
    )
    expect(panel).not.toMatch(/overflow-hidden rounded-xl bg-card/)
  })

  // Why it matters: the detail is no longer beside its own row, so without a
  // position track nothing on it says when in the turn the span ran.
  test('the docked detail states where in the trace the span sits', () => {
    expect(waterfall).toContain('openExtent')
    expect(waterfall).toContain('startOffsetMs')
  })

  // Why it matters: coverage is the complement of the remainder the legend
  // already prints, so a second number restates one fact as two.
  test('the coverage strip states the remainder, not a second attributed figure', () => {
    expect(coverage).not.toContain('} attributed')
    expect(coverage).not.toContain('traceCoverage')
  })

  // Why it matters: every other legend entry is a measurement. This one is what
  // is left over, and a reader cannot tell that from its name alone.
  test('provider wait explains itself on hover', () => {
    expect(coverage).toContain('PROVIDER_WAIT_EXPLANATION')
    expect(coverage).toContain('PROVIDER_WAIT_CAUSES')
    expect(coverage).toContain('TooltipUI.Content')
  })
})
