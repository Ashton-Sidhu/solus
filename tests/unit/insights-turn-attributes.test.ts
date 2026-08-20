import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { MetricsSpan } from '@solus/contracts/observability-types'
import {
  attributeCount,
  attributesAsText,
  isPrimaryGroup,
  PRIMARY_GROUP_LABELS,
  turnAttributes,
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

function traceOf(rootAttrs: MetricsSpan['attrs'], children: MetricsSpan[] = []) {
  const root = span({
    spanId: 'trace-1',
    kind: 'turn',
    attrs: rootAttrs,
  })
  const view = buildTraceView({
    traceId: 'trace-1',
    spans: [root, ...children],
    unattributedMs: null,
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
  test('showing every attribute grows the card instead of hiding new rows behind an inner fold', () => {
    // The primary groups are already taller than the old 28rem expanded cap.
    // Applying that cap only after the click made the state change invisible:
    // the card stayed the same height and the new groups landed below its fold.
    const component = readFileSync(
      new URL('../../packages/workspace-ui/src/components/insights/TurnAttributes.svelte', import.meta.url),
      'utf8',
    )

    expect(component).not.toContain("'max-h-[28rem] overflow-y-auto'")
    expect(component).toContain('expanded ? "Show less" : `Show all ${total} attributes`')
  })

  test('long names and values truncate while their complete text stays in tooltips', () => {
    // Narrow detail rails must stay scannable when names, ids, and paths are
    // long. Both tracks truncate instead of growing the row, while tooltips
    // keep the complete recorded text and any explanation available.
    const component = readFileSync(
      new URL('../../packages/workspace-ui/src/components/insights/TurnAttributes.svelte', import.meta.url),
      'utf8',
    )

    expect(component).toContain('grid-template-columns:minmax(0,3fr) minmax(0,2fr) 1.75rem')
    expect(component).toContain('min-w-0 truncate cursor-help')
    expect(component).toContain('block truncate text-[0.6875rem]')
    expect(component).toContain('<TooltipUI.Content')
    expect(component).toContain('{attribute.key}</span>')
    expect(component).toContain('value={attribute.value}')
    expect(component).toContain('{attribute.note}</span>')
    expect(component).not.toContain('side="right"')
  })

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

  test('the task drill opens in the trailing pane', () => {
    // Insights must remain visible while the task opens beside it, matching
    // other contextual task links rather than replacing the leading pane.
    const panel = readFileSync(
      new URL('../../packages/workspace-ui/src/components/insights/TurnDetailPanel.svelte', import.meta.url),
      'utf8',
    )
    const attributes = readFileSync(
      new URL('../../packages/workspace-ui/src/components/insights/TurnAttributes.svelte', import.meta.url),
      'utf8',
    )

    expect(panel).toContain('workspace.goToTask(taskId, "click", "secondary")')
    expect(panel).toContain('<TurnAttributes groups={attributeGroups} onOpenTask={openTask} />')
    expect(attributes).toContain('title="Open task in the trailing pane"')
  })

  test('copy-all hands back every row as key and value', () => {
    const { root, view } = traceOf({ costUsd: 0.5 })
    const groups = turnAttributes(root, view)
    const lines = attributesAsText(groups).split('\n')

    expect(lines).toHaveLength(attributeCount(groups))
    expect(lines).toContain('cost_usd\t0.5')
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
