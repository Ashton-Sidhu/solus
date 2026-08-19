import { describe, expect, test } from 'bun:test'
import type { MetricsSpan } from '@solus/contracts/observability-types'
import { buildTraceView, type WaterfallRow } from '@solus/workspace-ui/components/insights/lib/waterfall'
import {
  activation,
  barsForLines,
  buildWaterfallTree,
  expandableIds,
  flattenTree,
  pathToSpan,
} from '@solus/workspace-ui/components/insights/lib/waterfall-tree'

// A turn's spans are long and mostly repetition: a dozen tool calls, one
// thinking span per segment. Folding a run of consecutive siblings into a lane
// is what makes the trace readable, so these tests hold the fold's three
// promises — that the sequence survives it, that nothing leaves the plot when a
// lane closes, and that the reader can always get back to an individual span.

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
})

function rowsOf(spans: MetricsSpan[]): WaterfallRow[] {
  return buildTraceView({ traceId: 'tr_1', spans, unattributedMs: null, gapSegments: [] })!.rows
}

function treeOf(spans: MetricsSpan[]) {
  return buildWaterfallTree(rowsOf(spans), 1_000)
}

const threeTools = [
  root,
  span({ spanId: 't1', parentSpanId: 'root', startedAt: 1_100 }),
  span({ spanId: 't2', parentSpanId: 'root', name: 'Read', startedAt: 1_250 }),
  span({ spanId: 't3', parentSpanId: 'root', startedAt: 1_400 }),
]

describe('waterfall grouping', () => {
  test('a run of siblings folds into one lane', () => {
    const lines = flattenTree(treeOf(threeTools), new Set())
    expect(lines).toHaveLength(2)
    const lane = lines[1]
    expect(lane.type).toBe('group')
    if (lane.type !== 'group') return
    expect(lane.group.memberCount).toBe(3)
    expect(lane.group.label).toBe('Tool calls')
  })

  test('a lone sibling stays its own row rather than becoming a lane of one', () => {
    const lines = flattenTree(
      treeOf([root, span({ spanId: 's1', parentSpanId: 'root', kind: 'setup', startedAt: 1_050 })]),
      new Set(),
    )
    expect(lines.map((line) => line.type)).toEqual(['span', 'span'])
  })

  test('a lane reports the union of its members, so overlapping tools are counted once', () => {
    const lines = flattenTree(
      treeOf([
        root,
        span({ spanId: 'a', parentSpanId: 'root', startedAt: 1_100, endedAt: 1_300, durationMs: 200 }),
        span({ spanId: 'b', parentSpanId: 'root', startedAt: 1_200, endedAt: 1_400, durationMs: 200 }),
      ]),
      new Set(),
    )
    const lane = lines[1]
    expect(lane.type === 'group' && lane.group.totalMs).toBe(300)
  })

  test('a lane is a run, so alternating work keeps its sequence', () => {
    // Thinking, two tools, thinking again, two more tools. Pooling by kind
    // would read as "the turn thought, then called tools", which is not what
    // happened — the waterfall exists to show the alternation.
    const lines = flattenTree(
      treeOf([
        root,
        span({ spanId: 'k1', parentSpanId: 'root', kind: 'thinking', startedAt: 1_050 }),
        span({ spanId: 't1', parentSpanId: 'root', startedAt: 1_150 }),
        span({ spanId: 't2', parentSpanId: 'root', startedAt: 1_300 }),
        span({ spanId: 'k2', parentSpanId: 'root', kind: 'thinking', startedAt: 1_450 }),
        span({ spanId: 't3', parentSpanId: 'root', startedAt: 1_600 }),
        span({ spanId: 't4', parentSpanId: 'root', startedAt: 1_700 }),
      ]),
      new Set(),
    )
    expect(
      lines.slice(1).map((line) => (line.type === 'group' ? `${line.group.spanKind}×${line.group.memberCount}` : line.row.kind)),
    ).toEqual(['thinking', 'tool_call×2', 'thinking', 'tool_call×2'])
  })

  test('two runs of one kind are separate lanes that open independently', () => {
    const tree = treeOf([
      root,
      span({ spanId: 't1', parentSpanId: 'root', startedAt: 1_100 }),
      span({ spanId: 't2', parentSpanId: 'root', startedAt: 1_200 }),
      span({ spanId: 'k1', parentSpanId: 'root', kind: 'thinking', startedAt: 1_300 }),
      span({ spanId: 't3', parentSpanId: 'root', startedAt: 1_400 }),
      span({ spanId: 't4', parentSpanId: 'root', startedAt: 1_500 }),
    ])
    const ids = expandableIds(tree)
    expect(new Set(ids).size).toBe(2)
    const lines = flattenTree(tree, new Set([ids[0]]))
    expect(lines.filter((line) => line.type === 'span').map((line) => line.row.spanId)).toEqual([
      'root',
      't1',
      't2',
      'k1',
    ])
  })

  test('a lane names the tools inside it when they differ', () => {
    const lane = treeOf(threeTools)[0].type === 'span' ? treeOf(threeTools)[0] : null
    const group = lane?.type === 'span' ? lane.children[0] : null
    expect(group?.type === 'group' && group.group.detail).toBe('Bash ×2, Read')
  })

  test('a failure inside a closed lane is still counted on it', () => {
    const lines = flattenTree(
      treeOf([
        root,
        span({ spanId: 't1', parentSpanId: 'root', startedAt: 1_100 }),
        span({ spanId: 't2', parentSpanId: 'root', startedAt: 1_200, status: 'error' }),
      ]),
      new Set(),
    )
    const lane = lines[1]
    expect(lane.type === 'group' && lane.group.errorCount).toBe(1)
  })

  test('nested spans are counted but not listed until their parent opens', () => {
    const nested = [
      root,
      span({ spanId: 'agent', parentSpanId: 'root', kind: 'agent_run', name: 'Task', startedAt: 1_100 }),
      span({ spanId: 'inner', parentSpanId: 'agent', startedAt: 1_120 }),
    ]
    const tree = treeOf(nested)
    const closed = flattenTree(tree, new Set())
    expect(closed).toHaveLength(2)
    const agentLine = closed[1]
    expect(agentLine.type === 'span' && agentLine.hiddenCount).toBe(1)
    expect(flattenTree(tree, new Set(['agent']))).toHaveLength(3)
  })
})

describe('opening a lane', () => {
  test('an opened lane keeps its own row, so the fold is reversible', () => {
    const tree = treeOf(threeTools)
    const lines = flattenTree(tree, new Set(expandableIds(tree)))
    expect(lines[1].type).toBe('group')
    expect(lines.filter((line) => line.type === 'span')).toHaveLength(4)
  })

  test('a deep link opens only the lanes its span is inside', () => {
    const tree = treeOf([
      root,
      span({ spanId: 'a1', parentSpanId: 'root', kind: 'agent_run', name: 'Task', startedAt: 1_100 }),
      span({ spanId: 'a2', parentSpanId: 'root', kind: 'agent_run', name: 'Task', startedAt: 1_200 }),
      span({ spanId: 'deep', parentSpanId: 'a2', startedAt: 1_220 }),
    ])
    const path = pathToSpan(tree, 'deep')
    expect(path).toEqual(['root::agent_run::1', 'a2'])
    const lines = flattenTree(tree, new Set(path))
    expect(lines.some((line) => line.type === 'span' && line.row.spanId === 'deep')).toBe(true)
  })

  test('an unknown span opens nothing', () => {
    expect(pathToSpan(treeOf(threeTools), 'missing')).toEqual([])
  })
})

describe('activating a line', () => {
  // Solus's dispatch steps hang off the turn's `setup` span, so the only way
  // into them is `setup`'s own caret. A click that opened the detail panel and
  // left the steps folded made the internals toggle look like it did nothing.
  const setupWithSteps = [
    root,
    span({ spanId: 'setup', parentSpanId: 'root', kind: 'setup', name: 'setup', startedAt: 1_010 }),
    span({
      spanId: 'step1',
      parentSpanId: 'setup',
      kind: 'internal.dispatch_step',
      name: 'launch_run',
      startedAt: 1_020,
    }),
    span({
      spanId: 'step2',
      parentSpanId: 'setup',
      kind: 'internal.dispatch_step',
      name: 'git_state',
      startedAt: 1_040,
    }),
  ]

  // WHY: dispatch folds nest — setup's steps hold steps of their own — so a
  // lane named after its kind reads "Dispatch steps" at every level and tells
  // the reader nothing about which level they are looking at.
  test('a step lane names its members, not its kind', () => {
    const lane = flattenTree(treeOf(setupWithSteps), new Set(['setup']))
      .find((line) => line.type === 'group')!
    expect(lane.type === 'group' && lane.group.label).toBe('launch_run, git_state')
  })

  test('a span with children unfolds on activation and opens its own detail', () => {
    const tree = treeOf(setupWithSteps)
    const closed = flattenTree(tree, new Set())
    const setupLine = closed.find((line) => line.type === 'span' && line.row.spanId === 'setup')!
    expect(activation(setupLine)).toEqual({ toggleId: 'setup', selectSpanId: 'setup' })
    expect(flattenTree(tree, new Set(['setup'])).length).toBeGreaterThan(closed.length)
  })

  test('a leaf span only opens its detail — there is nothing to unfold', () => {
    const line = flattenTree(treeOf(setupWithSteps), new Set(expandableIds(treeOf(setupWithSteps))))
      .find((entry) => entry.type === 'span' && entry.row.spanId === 'step1')!
    expect(activation(line)).toEqual({ toggleId: null, selectSpanId: 'step1' })
  })

  test('a lane only unfolds — a lane has no detail of its own', () => {
    const lane = flattenTree(treeOf(threeTools), new Set())[1]
    expect(activation(lane)).toEqual({ toggleId: lane.id, selectSpanId: null })
  })
})

describe('bars', () => {
  test('a closed lane still draws every member, so folding hides no span', () => {
    const tree = treeOf(threeTools)
    const bars = barsForLines(flattenTree(tree, new Set()), tree, 1_000)
    // The turn root plus all three tool calls, on two lines.
    expect(bars).toHaveLength(4)
    expect(new Set(bars.map((bar) => bar.lineId)).size).toBe(2)
    expect(bars.filter((bar) => bar.lineId === 'root::tool_call::1').map((bar) => bar.spanId)).toEqual([
      't1',
      't2',
      't3',
    ])
  })

  test('an opened lane draws its members quietly, since the rows below now carry them', () => {
    const tree = treeOf(threeTools)
    const bars = barsForLines(flattenTree(tree, new Set(['root::tool_call::1'])), tree, 1_000)
    const laneBars = bars.filter((bar) => bar.lineId === 'root::tool_call::1')
    expect(laneBars.every((bar) => bar.faded)).toBe(true)
    expect(bars.filter((bar) => bar.lineId === 't1' && !bar.faded)).toHaveLength(1)
  })

  test('a failed span wears the status colour so it reads from a closed lane', () => {
    const tree = treeOf([
      root,
      span({ spanId: 't1', parentSpanId: 'root', startedAt: 1_100 }),
      span({ spanId: 't2', parentSpanId: 'root', startedAt: 1_200, status: 'error' }),
    ])
    const bars = barsForLines(flattenTree(tree, new Set()), tree, 1_000)
    expect(bars.find((bar) => bar.spanId === 't2')?.color).toBe('var(--failure)')
    expect(bars.find((bar) => bar.spanId === 't1')?.color).not.toBe('var(--failure)')
  })

  test('every bar sits in a line the reader can see', () => {
    const tree = treeOf(threeTools)
    const lines = flattenTree(tree, new Set(['root::tool_call::1']))
    const visible = new Set(lines.map((line) => line.id))
    for (const bar of barsForLines(lines, tree, 1_000)) expect(visible.has(bar.lineId)).toBe(true)
  })
})
