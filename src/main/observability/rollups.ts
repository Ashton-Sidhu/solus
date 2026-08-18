import type {
  MetricsAttrValue,
  MetricsGapCategory,
  MetricsGapSegment,
  MetricsSessionSummary,
  MetricsSpan,
  MetricsTurnSummary,
  MetricsTurnTrace,
} from '../../shared/observability-types'
import { getMetricsDb } from './metrics-db'
import { SPAN_KINDS } from './registries'

// ─── Session and turn rollups ───
//
// Child spans record only observed intervals and may overlap (parallel or
// nested tools), so rollups use interval unions and derive unattributed time
// from the root turn minus the union — never from synthetic spans.

interface SpanRow {
  span_id: string
  parent_span_id: string | null
  trace_id: string
  kind: string
  name: string
  service: string
  session_id: string | null
  provider: string | null
  model: string | null
  project_root: string | null
  origin: string | null
  started_at: number
  ended_at: number | null
  duration_ms: number | null
  status: string
  attrs: string
}

function parseAttrs(raw: string): Record<string, MetricsAttrValue> {
  try {
    const parsed = JSON.parse(raw) as Record<string, MetricsAttrValue>
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function toSpan(row: SpanRow): MetricsSpan {
  return {
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    traceId: row.trace_id,
    kind: row.kind,
    name: row.name,
    service: row.service,
    sessionId: row.session_id,
    provider: row.provider,
    model: row.model,
    projectRoot: row.project_root,
    origin: row.origin,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    status: row.status,
    attrs: parseAttrs(row.attrs),
  }
}

/** Total length covered by the union of possibly-overlapping intervals. */
export function intervalUnionLength(intervals: Array<[number, number]>): number {
  const sorted = intervals
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0])
  let total = 0
  let currentStart = 0
  let currentEnd = -Infinity
  for (const [start, end] of sorted) {
    if (start > currentEnd) {
      if (currentEnd > -Infinity) total += currentEnd - currentStart
      currentStart = start
      currentEnd = end
    } else if (end > currentEnd) {
      currentEnd = end
    }
  }
  if (currentEnd > -Infinity) total += currentEnd - currentStart
  return total
}

function blockingIntervals(root: MetricsSpan, children: MetricsSpan[]): Array<[number, number]> {
  if (root.endedAt === null) return []
  const intervals: Array<[number, number]> = []
  for (const child of children) {
    if (child.kind === SPAN_KINDS.backgroundTask) continue
    if (child.endedAt === null) continue
    const start = Math.max(child.startedAt, root.startedAt)
    const end = Math.min(child.endedAt, root.endedAt)
    if (end > start) intervals.push([start, end])
  }
  return intervals.sort((a, b) => a[0] - b[0])
}

function intervalComplement(root: MetricsSpan, intervals: Array<[number, number]>): Array<[number, number]> {
  if (root.endedAt === null) return []
  const gaps: Array<[number, number]> = []
  let cursor = root.startedAt
  for (const [rawStart, rawEnd] of intervals) {
    const start = Math.max(root.startedAt, rawStart)
    const end = Math.min(root.endedAt, rawEnd)
    if (start > cursor) gaps.push([cursor, start])
    if (end > cursor) cursor = end
  }
  if (cursor < root.endedAt) gaps.push([cursor, root.endedAt])
  return gaps
}

function boundaryAt(root: MetricsSpan, attrName: string): number | null {
  if (root.endedAt === null) return null
  const offset = attrNumber(root.attrs, attrName)
  if (offset === null) return null
  return Math.min(root.endedAt, Math.max(root.startedAt, root.startedAt + offset))
}

const ACTIVITY_KINDS = new Set<string>([
  SPAN_KINDS.thinking,
  SPAN_KINDS.responseStream,
  SPAN_KINDS.toolCall,
])

function categoryAt(input: {
  at: number
  firstProviderEventAt: number | null
  firstActivityAt: number | null
  lastActivityAt: number | null
  providerCompletedAt: number | null
  lastProviderEventAt: number | null
}): MetricsGapCategory {
  if (input.firstProviderEventAt !== null && input.at < input.firstProviderEventAt) {
    return 'provider_startup'
  }
  if (input.firstActivityAt !== null && input.at < input.firstActivityAt) {
    return 'before_first_activity'
  }
  if (input.providerCompletedAt !== null && input.at >= input.providerCompletedAt) {
    return 'turn_settlement'
  }
  if (
    input.providerCompletedAt !== null
    && input.lastActivityAt !== null
    && input.at >= input.lastActivityAt
  ) {
    return 'provider_completion'
  }
  if (input.lastProviderEventAt !== null && input.at >= input.lastProviderEventAt) {
    return 'after_last_provider_event'
  }
  if (input.firstActivityAt !== null && input.at >= input.firstActivityAt) {
    return 'between_activities'
  }
  return 'unattributed'
}

/** Root turn intervals not covered by blocking child spans. Lifecycle
 *  boundaries split the residual into locations a user can inspect without
 *  pretending that Solus observed the provider's internal work. */
export function gapSegments(root: MetricsSpan, children: MetricsSpan[]): MetricsGapSegment[] {
  if (root.endedAt === null) return []
  const activity = children.filter((child) => ACTIVITY_KINDS.has(child.kind))
  const firstActivityAt = boundaryAt(root, 'timeToFirstActivityMs')
    ?? (activity.length ? Math.min(...activity.map((span) => span.startedAt)) : null)
  const activityEnds = activity
    .map((span) => span.endedAt)
    .filter((endedAt): endedAt is number => endedAt !== null)
  const lastActivityAt = activityEnds.length ? Math.max(...activityEnds) : null
  const firstProviderEventAt = boundaryAt(root, 'timeToFirstProviderEventMs')
  const providerCompletedAt = boundaryAt(root, 'timeToProviderCompleteMs')
  const lastProviderEventAt = boundaryAt(root, 'timeToLastProviderEventMs')
  const cuts = [
    firstProviderEventAt,
    firstActivityAt,
    lastActivityAt,
    providerCompletedAt,
    lastProviderEventAt,
  ].filter((at): at is number => at !== null)

  return intervalComplement(root, blockingIntervals(root, children)).flatMap(([startedAt, endedAt]) => {
    const points = [...new Set([
      startedAt,
      ...cuts.filter((at) => at > startedAt && at < endedAt),
      endedAt,
    ])].sort((a, b) => a - b)
    return points.slice(0, -1).map((from, index) => {
      const to = points[index + 1]
      return {
        category: categoryAt({
          at: from + (to - from) / 2,
          firstProviderEventAt,
          firstActivityAt,
          lastActivityAt,
          providerCompletedAt,
          lastProviderEventAt,
        }),
        startedAt: from,
        endedAt: to,
        durationMs: to - from,
      }
    })
  })
}

/** Root turn time not covered by blocking child spans, clipped to the root
 *  interval. Background tasks are excluded — they never block the turn. */
export function unattributedMs(root: MetricsSpan, children: MetricsSpan[]): number | null {
  if (root.endedAt === null) return null
  return gapSegments(root, children).reduce((total, segment) => total + segment.durationMs, 0)
}

/** One turn's full span tree for the waterfall, ordered `(started_at, span_id)`. */
export function turnTrace(traceId: string): MetricsTurnTrace {
  const rows = getMetricsDb().prepare(`
    SELECT * FROM spans WHERE trace_id = ? ORDER BY started_at, span_id
  `).all(traceId) as unknown as SpanRow[]
  const spans = rows.map(toSpan)
  const root = spans.find((span) => span.kind === SPAN_KINDS.turn && span.parentSpanId === null)
  const children = root ? spans.filter((span) => span !== root) : []
  const gaps = root ? gapSegments(root, children) : []
  return {
    traceId,
    spans,
    unattributedMs: root ? gaps.reduce((total, segment) => total + segment.durationMs, 0) : null,
    gapSegments: gaps,
  }
}

function attrNumber(attrs: Record<string, MetricsAttrValue>, key: string): number | null {
  const value = attrs[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function attrString(attrs: Record<string, MetricsAttrValue>, key: string): string | null {
  const value = attrs[key]
  return typeof value === 'string' ? value : null
}

/** Characters of a turn's ask the rollup carries. A row shows one truncated
 *  line, and a 200-turn session must not send 200 whole prompts to say so. */
const SUMMARY_PROMPT_CHARS = 200

function summaryPrompt(prompt: string | null): string | null {
  const line = prompt?.replace(/\s+/g, ' ').trim() ?? ''
  if (!line) return null
  return line.length > SUMMARY_PROMPT_CHARS ? `${line.slice(0, SUMMARY_PROMPT_CHARS)}…` : line
}

/** Root-turn rollup for session surfaces. Turn numbers are display ordinals
 *  over `(started_at, span_id)` — computed here, never persisted. */
export function sessionSummary(sessionId: string): MetricsSessionSummary {
  const rows = getMetricsDb().prepare(`
    SELECT * FROM spans
    WHERE kind = ? AND session_id = ?
    ORDER BY started_at, span_id
  `).all(SPAN_KINDS.turn, sessionId) as unknown as SpanRow[]

  const rowsWithAttrs = rows.map((row) => ({ row, attrs: parseAttrs(row.attrs) }))
  const firstTaskId = rowsWithAttrs
    .map(({ attrs }) => attrString(attrs, 'taskId'))
    .find((value) => value !== null) ?? null
  const firstTaskTitle = rowsWithAttrs
    .map(({ attrs }) => attrString(attrs, 'taskTitle'))
    .find((value) => value !== null) ?? null

  const turns: MetricsTurnSummary[] = rowsWithAttrs.map(({ row, attrs }, index) => {
    return {
      turnNumber: index + 1,
      traceId: row.trace_id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMs: row.duration_ms,
      status: row.status,
      model: row.model,
      origin: row.origin,
      promptSource: attrString(attrs, 'promptSource'),
      prompt: summaryPrompt(attrString(attrs, 'prompt')),
      costUsd: attrNumber(attrs, 'costUsd'),
      inputTokens: attrNumber(attrs, 'inputTokens'),
      outputTokens: attrNumber(attrs, 'outputTokens'),
      toolCallCount: attrNumber(attrs, 'toolCallCount'),
    }
  })
  const knownCosts = turns.flatMap((turn) => turn.costUsd === null ? [] : [turn.costUsd])

  return {
    sessionId,
    taskId: firstTaskId,
    taskTitle: firstTaskTitle,
    turnCount: turns.length,
    totalDurationMs: turns.reduce((total, turn) => total + (turn.durationMs ?? 0), 0),
    totalCostUsd: knownCosts.length > 0
      ? knownCosts.reduce((total, costUsd) => total + costUsd, 0)
      : null,
    totalInputTokens: turns.reduce((total, turn) => total + (turn.inputTokens ?? 0), 0),
    totalOutputTokens: turns.reduce((total, turn) => total + (turn.outputTokens ?? 0), 0),
    turns,
  }
}
