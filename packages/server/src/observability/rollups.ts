import type {
  MetricsSpanAttrs,
  MetricsGapCategory,
  MetricsGapSegment,
  MetricsLogEvent,
  MetricsLogLevel,
  MetricsSessionSummary,
  MetricsSpan,
  MetricsTurnSummary,
  MetricsTurnTrace,
} from '@solus/contracts/observability-types'
import { getMetricsDb } from './metrics-db'
import { SPAN_KINDS } from './registries'
import {
  blockingIntervals,
  effectiveTraceSpans,
  intervalComplement,
} from './trace-timing'

// ─── Session and turn rollups ───
//
// Child spans record only observed intervals and may overlap (parallel or
// nested tools), so rollups use interval unions and derive Provider wait
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

interface LogEventRow {
  trace_id: string
  span_id: string
  occurred_at: number
  level: MetricsLogLevel
  name: string
  tag: string
  file: string
  attrs: string
}

/** The one boundary where the stored JSON blob becomes typed attributes. The
 *  emitter writes it from the same registry the read type is declared from. */
function parseAttrs(raw: string): MetricsSpanAttrs {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Object.prototype.toString.call(parsed) !== '[object Object]') return {}
    // SAFETY: `spans.attrs` is written only by the session emitter, from the
    // registry that `MetricsSpanAttrs` declares the read side of.
    return parsed as MetricsSpanAttrs
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

function toLogEvent(row: LogEventRow): MetricsLogEvent {
  let attrs: MetricsLogEvent['attrs'] = {}
  try {
    const parsed: unknown = JSON.parse(row.attrs)
    if (Object.prototype.toString.call(parsed) === '[object Object]') {
      // SAFETY: `log_events.attrs` is written only by the structured logger
      // exporter, which accepts the same scalar values this contract declares.
      attrs = parsed as MetricsLogEvent['attrs']
    }
  } catch {}
  return {
    traceId: row.trace_id,
    spanId: row.span_id,
    occurredAt: row.occurred_at,
    level: row.level,
    name: row.name,
    tag: row.tag,
    file: row.file,
    attrs,
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

/** The turn attributes that record an offset from the turn's own start. */
type TurnBoundaryAttr =
  | 'timeToFirstActivityMs'
  | 'timeToFirstProviderEventMs'
  | 'timeToProviderCompleteMs'
  | 'timeToLastProviderEventMs'

function boundaryAt(root: MetricsSpan, attrName: TurnBoundaryAttr): number | null {
  if (root.endedAt === null) return null
  const offset = root.attrs[attrName]
  if (offset === undefined) return null
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
  return 'provider_wait'
}

/** Root turn intervals left after blocking spans and thinking lead-ins.
 *  Lifecycle boundaries split the remaining provider wait into locations a
 *  user can inspect. */
export function gapSegments(root: MetricsSpan, children: MetricsSpan[]): MetricsGapSegment[] {
  if (root.endedAt === null) return []
  const attributedChildren = effectiveTraceSpans(root, children)
  const activity = attributedChildren.filter((child) => ACTIVITY_KINDS.has(child.kind))
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

  return intervalComplement(root, blockingIntervals(root, attributedChildren)).flatMap(([startedAt, endedAt]) => {
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
export function providerWaitMs(root: MetricsSpan, children: MetricsSpan[]): number | null {
  if (root.endedAt === null) return null
  return gapSegments(root, children).reduce((total, segment) => total + segment.durationMs, 0)
}

/** One turn's full span tree for the waterfall, ordered `(started_at, span_id)`. */
export function turnTrace(traceId: string): MetricsTurnTrace {
  const rawRows: unknown = getMetricsDb().prepare(`
    SELECT * FROM spans WHERE trace_id = ? ORDER BY started_at, span_id
  `).all(traceId)
  // SAFETY: `SELECT *` over `spans` returns that table's columns, which `SpanRow`
  // names one-for-one.
  const rows = rawRows as SpanRow[]
  const spans = rows.map(toSpan)
  const rawLogRows: unknown = getMetricsDb().prepare(`
    SELECT trace_id, span_id, occurred_at, level, name, tag, file, attrs
    FROM log_events WHERE trace_id = ? ORDER BY occurred_at, event_id
  `).all(traceId)
  // SAFETY: the SELECT names every `LogEventRow` column one-for-one, and the
  // writer constrains `level` to `MetricsLogLevel`.
  const logEvents = (rawLogRows as LogEventRow[]).map(toLogEvent)
  const root = spans.find((span) => span.kind === SPAN_KINDS.turn && span.parentSpanId === null)
  const rawChildren = root ? spans.filter((span) => span !== root) : []
  const children = root ? effectiveTraceSpans(root, rawChildren) : []
  const attributedById = new Map(children.map((span) => [span.spanId, span]))
  const attributedSpans = spans
    .map((span) => attributedById.get(span.spanId) ?? span)
    .sort((a, b) => a.startedAt - b.startedAt || a.spanId.localeCompare(b.spanId))
  const gaps = root ? gapSegments(root, children) : []
  return {
    traceId,
    spans: attributedSpans,
    logEvents,
    providerWaitMs: root ? gaps.reduce((total, segment) => total + segment.durationMs, 0) : null,
    gapSegments: gaps,
  }
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
  const rawRows: unknown = getMetricsDb().prepare(`
    SELECT * FROM spans
    WHERE kind = ? AND session_id = ?
    ORDER BY started_at, span_id
  `).all(SPAN_KINDS.turn, sessionId)
  // SAFETY: `SELECT *` over `spans` returns that table's columns, which `SpanRow`
  // names one-for-one.
  const rows = rawRows as SpanRow[]

  const rowsWithAttrs = rows.map((row) => ({ row, attrs: parseAttrs(row.attrs) }))
  const firstTaskId = rowsWithAttrs
    .map(({ attrs }) => attrs.taskId ?? null)
    .find((value) => value !== null) ?? null
  const firstTaskTitle = rowsWithAttrs
    .map(({ attrs }) => attrs.taskTitle ?? null)
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
      promptSource: attrs.promptSource ?? null,
      prompt: summaryPrompt(attrs.prompt ?? null),
      costUsd: attrs.costUsd ?? null,
      inputTokens: attrs.inputTokens ?? null,
      outputTokens: attrs.outputTokens ?? null,
      toolCallCount: attrs.toolCallCount ?? null,
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
