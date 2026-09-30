import { describe, expect, test } from 'bun:test'
import type { MetricsSpan } from '@solus/contracts/observability-types'
import {
  attributeCount,
  attributeLabel,
  attributesAsText,
  isPrimaryGroup,
  PRIMARY_GROUP_LABELS,
  turnAttributes,
  turnStats,
} from '@solus/workspace-ui/components/insights/lib/turn-attributes'
import { buildTraceView } from '@solus/workspace-ui/components/insights/lib/waterfall'

function span(overrides: Partial<MetricsSpan> & Pick<MetricsSpan, 'spanId' | 'kind'>): MetricsSpan {
  return {
    parentSpanId: null,
    traceId: 'trace-1',
    name: overrides.kind,
    service: 'sessions',
    sessionId: 'session-1',
    provider: 'claude-code',
    model: 'claude-sonnet-5',
    projectRoot: '/repo',
    origin: 'typed',
    startedAt: 1_000,
    endedAt: 3_000,
    durationMs: 2_000,
    status: 'ok',
    attrs: {},
    ...overrides,
  }
}

function traceOf(
  rootAttrs: MetricsSpan['attrs'],
  children: MetricsSpan[] = [],
  providerWaitMs: number | null = null,
) {
  const root = span({
    spanId: 'trace-1',
    kind: 'turn',
    attrs: rootAttrs,
  })
  const view = buildTraceView({
    traceId: 'trace-1',
    spans: [root, ...children],
    providerWaitMs,
    gapSegments: [],
  })
  if (!view) throw new Error('expected a trace view')
  return { root, view }
}

function findAttribute(root: MetricsSpan, view: ReturnType<typeof traceOf>['view'], key: string) {
  const attribute = turnAttributes(root, view)
    .flatMap((group) => group.attributes)
    .find((entry) => entry.key === key)
  if (!attribute) throw new Error(`no attribute ${key}`)
  return attribute
}

describe('turn attributes', () => {
  test('the outcome numbers are attributes, not a separate strip', () => {
    // The whole point of the model: a reader looking for the duration, the cost,
    // or the tool-call count finds them in the same list as every other fact.
    const { root, view } = traceOf({ costUsd: 0.42, inputTokens: 100, outputTokens: 20 }, [
      span({ spanId: 'tool-1', parentSpanId: 'trace-1', kind: 'tool_call', name: 'Bash' }),
    ])
    const outcome = turnAttributes(root, view).find((group) => group.label === 'Outcome')

    expect(outcome?.attributes.map((entry) => entry.key)).toEqual(
      expect.arrayContaining(['duration_ms', 'cost_usd', 'input_tokens', 'tool_call_count']),
    )
    expect(findAttribute(root, view, 'tool_call_count').value).toBe('1')
  })

  test('the remaining uncovered turn time is named provider wait', () => {
    const { root, view } = traceOf({}, [], 750)
    const providerWait = findAttribute(root, view, 'provider_wait_ms')

    expect(providerWait.value).toBe('750ms')
    expect(providerWait.copyValue).toBe('750')
  })

  test('a row copies the stored value, not the value it prints', () => {
    // Copying "2.0s" out of a row and pasting it into a query is useless; the
    // control has to hand back the number the column actually holds.
    const { root, view } = traceOf({ costUsd: 0.4242 })

    expect(findAttribute(root, view, 'duration_ms')).toMatchObject({
      value: '2.0s',
      copyValue: '2000',
    })
    expect(findAttribute(root, view, 'cost_usd').copyValue).toBe('0.4242')
  })

  test('a missing measure keeps its row and says why it is missing', () => {
    // Codex reports no per-turn cost. Dropping the row would read as a surface
    // bug; printing $0 would be a lie.
    const { root, view } = traceOf({})
    const cost = findAttribute(root, view, 'cost_usd')

    expect(cost.value).toBe('—')
    expect(cost.copyValue).toBe('')
    expect(cost.note).toContain('no cost')
  })

  test('the groups a reader opens first are a subset of all of them', () => {
    // What "Show all" exists for: the collapsed view must hide something, and
    // the labels it shows must be labels the model actually produces.
    const { root, view } = traceOf({ taskTitle: 'Fix the tests' })
    const groups = turnAttributes(root, view)
    const primary = groups.filter(isPrimaryGroup)

    expect(primary.length).toBe(PRIMARY_GROUP_LABELS.length)
    expect(attributeCount(primary)).toBeLessThan(attributeCount(groups))
  })

  test('recorded task identities carry a drill path to the task page', () => {
    // A task shown on the full turn page is context, not inert telemetry. Both
    // its readable name and its id must preserve the task identity needed to
    // open the task beside Insights; older turns may have only the id.
    const { root, view } = traceOf({ taskId: 'task-1', taskTitle: 'Fix the tests' })

    expect(findAttribute(root, view, 'task').destination).toEqual({
      name: 'task',
      taskId: 'task-1',
    })
    expect(findAttribute(root, view, 'task_id').destination).toEqual({
      name: 'task',
      taskId: 'task-1',
    })
  })

  test('copy-all hands back every row as key and value', () => {
    const { root, view } = traceOf({ costUsd: 0.5 })
    const groups = turnAttributes(root, view)
    const lines = attributesAsText(groups).split('\n')

    expect(lines).toHaveLength(attributeCount(groups))
    expect(lines).toContain('cost_usd\t0.5')
  })

  // WHY: the rail prints the fact in words and keeps the column name for the
  // tooltip and the copy. A list of forty snake_case columns is a schema
  // dump, and the reader is not writing a query yet.
  test('every row carries a printed label distinct from its column name', () => {
    const { root, view } = traceOf({})
    for (const attribute of turnAttributes(root, view).flatMap((group) => group.attributes)) {
      expect(attribute.label).not.toMatch(/_/)
      expect(attribute.label.length).toBeGreaterThan(0)
    }
    expect(findAttribute(root, view, 'time_to_first_provider_event_ms').label).toBe('First provider event')
  })

  test('a column nobody named still prints as words rather than blank', () => {
    expect(attributeLabel('some_new_measure_ms')).toBe('Some new measure')
  })

  test('a denied permission tones the tool-call row and is counted', () => {
    const { root, view } = traceOf({}, [
      span({
        spanId: 'perm-1',
        parentSpanId: 'trace-1',
        kind: 'permission_wait',
        name: 'Bash',
        status: 'error',
        attrs: { decision: 'denied' },
      }),
    ])

    expect(findAttribute(root, view, 'tool_call_count').tone).toBe('warning')
    expect(findAttribute(root, view, 'permission_denial_count').value).toBe('1')
  })
})

describe('turn stats', () => {
  // WHY: the line under the title is the reading a viewer takes in before
  // anything else — duration, cost, tokens, cache, tools — so it has to be
  // short, and it has to say when the number it prints is a warning.
  test('the four outcome figures, in reading order', () => {
    const { root, view } = traceOf(
      { costUsd: 1.91, inputTokens: 26, outputTokens: 3_800, cacheReadTokens: 1_300_000, cacheCreationTokens: 11_800 },
      [span({ spanId: 'tool-1', parentSpanId: 'trace-1', kind: 'tool_call', name: 'Bash' })],
    )
    const stats = turnStats(root, view)
    expect(stats.map((stat) => stat.label)).toEqual(['Duration', 'Cost', 'Tokens', 'Cache'])
    expect(stats[1].value).toBe('$1.91')
    // Tokens state one total; the split is the line under it.
    expect(stats[2].value).toBe('3.8k')
    expect(stats[2].detail).toBe('26 in · 3.8k out')
    expect(stats[3].value).toBe('99% read')
  })

  test('a turn with no cache figures has no cache stat rather than a 0%', () => {
    const { root, view } = traceOf({ inputTokens: 100 })
    expect(turnStats(root, view).map((stat) => stat.label)).not.toContain('Cache')
  })

  test('a large context that mostly missed the cache is the expensive shape, and says so', () => {
    const { root, view } = traceOf({ inputTokens: 40_000, cacheReadTokens: 10_000, cacheCreationTokens: 5_000 })
    const cache = turnStats(root, view).find((stat) => stat.label === 'Cache')
    expect(cache?.tone).toBe('warning')
    expect(cache?.verdict?.kind).toBe('bad')
  })

  test('a turn that read nearly all its input from cache is judged good', () => {
    const { root, view } = traceOf({ inputTokens: 100, cacheReadTokens: 50_000, cacheCreationTokens: 0 })
    const cache = turnStats(root, view).find((stat) => stat.label === 'Cache')
    expect(cache?.verdict).toEqual({ kind: 'good', glyph: 'check', label: 'Hit' })
    expect(cache?.meter?.fill).toBeGreaterThan(0.99)
  })
})
