import type { AppCallDetail, AppSpan } from '@solus/contracts/apps'
import type { MetricsSpan } from '@solus/contracts/observability-types'
import { buildTraceView, type TraceView } from '../../../insights/lib/waterfall'

/**
 * The trace of one call (docs/plans/apps.md §9.2), in the shape the Insights
 * waterfall draws: the call is the root, and each thing it waited for is a
 * span under it. Pure, so the mapping is tested.
 */

/** Each kind of span keeps one hue of the art ramp, so a request reads as a request in every call. */
const SPAN_KIND_COLORS = {
  fetch: 'var(--solus-art-5)',
  tool: 'var(--solus-art-4)',
  sql: 'var(--solus-art-3)',
  file: 'var(--solus-art-2)',
  signal: 'var(--solus-art-6)',
  workflow: 'var(--solus-art-1)',
  step: 'var(--solus-art-1)',
  model: 'var(--solus-art-2)',
} satisfies { [Kind in AppSpan['kind']]: string }

/**
 * The call's spans as an Insights trace: the times of a span are from the start
 * of the call, so they move onto the call's own clock. A call with no span has
 * no trace.
 */
export function callTraceView(call: AppCallDetail): TraceView | null {
  if (call.spans.length === 0) return null
  const traceId = call.traceId ?? call.id
  const rootSpanId = call.spanId ?? call.id
  const status = call.outcome === 'failed' ? 'error' : call.outcome === 'running' ? 'running' : 'ok'
  const lastEnd = call.spans.reduce((end, span) => Math.max(end, span.startMs + span.durationMs), 0)
  const root: MetricsSpan = {
    spanId: rootSpanId, parentSpanId: null, traceId, kind: 'app_call', name: call.operation, service: 'app',
    sessionId: null, provider: null, model: null, projectRoot: null, origin: null,
    startedAt: call.startedAt,
    // A call that still runs ends, for the picture, where its last span ends.
    endedAt: call.finishedAt ?? call.startedAt + lastEnd,
    durationMs: call.durationMs, status, attrs: call.error ? { error: call.error } : {},
  }
  const spans: MetricsSpan[] = call.spans.map((span, index) => ({
    spanId: `${rootSpanId}:${index}`, parentSpanId: rootSpanId, traceId, kind: span.kind, name: span.name, service: 'app',
    sessionId: null, provider: null, model: null, projectRoot: null, origin: null,
    startedAt: call.startedAt + span.startMs, endedAt: call.startedAt + span.startMs + span.durationMs, durationMs: span.durationMs,
    status: span.ok ? 'ok' : 'error', attrs: span.detail ? { description: span.detail } : {},
  }))
  const colors = new Map(spans.map((span, index) => [span.spanId, SPAN_KIND_COLORS[call.spans[index].kind]]))
  const view = buildTraceView({ traceId, spans: [root, ...spans], logEvents: [], providerWaitMs: null, gapSegments: [] })
  if (!view) return null
  // The waterfall names its root as a turn; here the root is the call.
  for (const row of view.rows) {
    if (row.spanId === rootSpanId) Object.assign(row, { label: call.operation, title: call.operation })
    row.color = colors.get(row.spanId) ?? row.color
  }
  return view
}

/** When a log line was written, from the start of the call: "+12ms", "+1.4s". */
export function logLineOffset(atMs: number): string {
  return atMs < 1000 ? `+${Math.round(atMs)}ms` : `+${(atMs / 1000).toFixed(1)}s`
}
