import type {
  MetricsAttrValue,
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
// nested tools), so rollups use interval unions and derive uninstrumented time
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

/** Root turn time not covered by blocking child spans, clipped to the root
 *  interval. Background tasks are excluded — they never block the turn. */
export function uninstrumentedMs(root: MetricsSpan, children: MetricsSpan[]): number | null {
  if (root.endedAt === null) return null
  const intervals: Array<[number, number]> = []
  for (const child of children) {
    if (child.kind === SPAN_KINDS.backgroundTask) continue
    if (child.endedAt === null) continue
    const start = Math.max(child.startedAt, root.startedAt)
    const end = Math.min(child.endedAt, root.endedAt)
    if (end > start) intervals.push([start, end])
  }
  return Math.max(0, root.endedAt - root.startedAt - intervalUnionLength(intervals))
}

/** One turn's full span tree for the waterfall, ordered `(started_at, span_id)`. */
export function turnTrace(traceId: string): MetricsTurnTrace {
  const rows = getMetricsDb().prepare(`
    SELECT * FROM spans WHERE trace_id = ? ORDER BY started_at, span_id
  `).all(traceId) as unknown as SpanRow[]
  const spans = rows.map(toSpan)
  const root = spans.find((span) => span.kind === SPAN_KINDS.turn && span.parentSpanId === null)
  return {
    traceId,
    spans,
    uninstrumentedMs: root
      ? uninstrumentedMs(root, spans.filter((span) => span !== root))
      : null,
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

/** Root-turn rollup for session surfaces. Turn numbers are display ordinals
 *  over `(started_at, span_id)` — computed here, never persisted. */
export function sessionSummary(sessionId: string): MetricsSessionSummary {
  const rows = getMetricsDb().prepare(`
    SELECT * FROM spans
    WHERE kind = ? AND session_id = ?
    ORDER BY started_at, span_id
  `).all(SPAN_KINDS.turn, sessionId) as unknown as SpanRow[]

  const turns: MetricsTurnSummary[] = rows.map((row, index) => {
    const attrs = parseAttrs(row.attrs)
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
      costUsd: attrNumber(attrs, 'costUsd'),
      inputTokens: attrNumber(attrs, 'inputTokens'),
      outputTokens: attrNumber(attrs, 'outputTokens'),
      toolCallCount: attrNumber(attrs, 'toolCallCount'),
    }
  })

  return {
    sessionId,
    turnCount: turns.length,
    totalDurationMs: turns.reduce((total, turn) => total + (turn.durationMs ?? 0), 0),
    totalCostUsd: turns.reduce((total, turn) => total + (turn.costUsd ?? 0), 0),
    totalInputTokens: turns.reduce((total, turn) => total + (turn.inputTokens ?? 0), 0),
    totalOutputTokens: turns.reduce((total, turn) => total + (turn.outputTokens ?? 0), 0),
    turns,
  }
}
