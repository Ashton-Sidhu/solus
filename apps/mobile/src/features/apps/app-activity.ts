import type {
  AppCallDetail,
  AppCallOutcome,
  AppCallerKind,
  AppCallsRequest,
  AppDescriptor,
  AppLogLine,
  AppMetrics,
  AppOperationMetrics,
  AppSpan,
} from '@solus/contracts/apps'
import { APP_CALLER_KINDS } from '@solus/contracts/apps'
import type { RowLine } from '../webhooks/webhook-rows'
import { agoText, callerKindLabel, callOutcomeLabel, countText, durationText } from './apps'

/**
 * The Activity section and the numbers of the Overview (docs/plans/apps.md
 * §9.2): the call log with its filters, one call with what the host kept of
 * it (decision 21), and the calls of the last 24 hours.
 */

// ─── The call log ───

/** What the call log is narrowed to. Null is no filter. */
export interface CallFilters {
  readonly operation: string | null
  readonly callerKind: AppCallerKind | null
  readonly outcome: AppCallOutcome | null
}

export const NO_CALL_FILTERS: CallFilters = { operation: null, callerKind: null, outcome: null }

export const CALL_PAGE_SIZE = 50
/** The most calls the host gives in one read. */
const CALL_LIMIT_MAX = 500

/** One choice of a filter. A null value shows everything. */
export interface FilterChoice<Value> {
  readonly value: Value | null
  readonly label: string
}

export const CALLER_CHOICES: readonly FilterChoice<AppCallerKind>[] = [
  { value: null, label: 'Every caller' },
  ...APP_CALLER_KINDS.map((kind) => ({ value: kind, label: callerKindLabel(kind) })),
]

export const OUTCOME_CHOICES: readonly FilterChoice<AppCallOutcome>[] = [
  { value: null, label: 'Every outcome' },
  { value: 'failed', label: callOutcomeLabel('failed') },
  { value: 'ok', label: callOutcomeLabel('ok') },
  { value: 'running', label: callOutcomeLabel('running') },
]

/** The operations a person can narrow the log to: those the active version declares. */
export function operationChoices(descriptor: AppDescriptor | null): FilterChoice<string>[] {
  return [{ value: null, label: 'Every operation' }, ...(descriptor?.operations ?? []).map((operation) => ({ value: operation.name, label: operation.name }))]
}

export function hasCallFilters(filters: CallFilters): boolean {
  return filters.operation !== null || filters.callerKind !== null || filters.outcome !== null
}

/** The read of the call log: the newest `limit` calls that pass every filter that is set. */
export function callsRequest(appId: string, filters: CallFilters, limit: number): AppCallsRequest {
  const request: AppCallsRequest = { appId, limit }
  if (filters.operation !== null) request.operation = filters.operation
  if (filters.callerKind !== null) request.callerKind = filters.callerKind
  if (filters.outcome !== null) request.outcome = filters.outcome
  return request
}

/** A full page can have older calls behind it, until the host's limit for one read. */
export function canShowOlderCalls(shown: number, limit: number): boolean {
  return shown >= limit && limit < CALL_LIMIT_MAX
}

export function olderCallsLimit(limit: number): number {
  return Math.min(limit + CALL_PAGE_SIZE, CALL_LIMIT_MAX)
}

// ─── One call ───

/** A time inside a call, from its start. */
export function offsetText(ms: number): string {
  return `+${durationText(ms)}`
}

/** One log line as the call's detail prints it. A warning or an error reads as a fault. */
export function logLine(line: AppLogLine): RowLine {
  const text = `${offsetText(line.atMs)}  ${line.text}`
  return line.level === 'warn' || line.level === 'error' ? { text, tone: 'danger' } : { text }
}

export function spanKindLabel(kind: AppSpan['kind']): string {
  switch (kind) {
    case 'fetch': return 'Request'
    case 'tool': return 'Tool'
    case 'sql': return 'SQL'
    case 'file': return 'File'
    case 'signal': return 'Signal'
    case 'workflow': return 'Workflow'
    case 'step': return 'Step'
    case 'model': return 'Model'
  }
}

/** One span of a trace, as a row of its waterfall. */
export interface SpanRow {
  readonly key: string
  readonly title: string
  /** How long the span took. */
  readonly trailing: string
  readonly failed: boolean
  readonly lines: readonly RowLine[]
  /** Where the span starts and how wide it is, as fractions of the call's time. */
  readonly offset: number
  readonly width: number
}

/** The thinnest bar that still shows: a span of no time is not nothing. */
const MIN_SPAN_WIDTH = 0.02

/**
 * The trace of one call in the order its spans started (§1). The bars are in
 * the time of the call; a call that still runs, or one from before the host
 * kept times, is as long as its last span.
 */
export function spanRows(call: Pick<AppCallDetail, 'spans' | 'durationMs'>): SpanRow[] {
  const spans = [...call.spans].sort((a, b) => a.startMs - b.startMs)
  const total = Math.max(call.durationMs ?? 0, ...spans.map((span) => span.startMs + span.durationMs), 1)
  return spans.map((span, index) => {
    const offset = Math.min(Math.max(span.startMs / total, 0), 1 - MIN_SPAN_WIDTH)
    const width = Math.min(Math.max(span.durationMs / total, MIN_SPAN_WIDTH), 1 - offset)
    const facts = [`Started at ${offsetText(span.startMs)}`]
    if (span.detail) facts.push(span.detail)
    return {
      key: `${index}:${span.kind}:${span.name}`,
      title: `${spanKindLabel(span.kind)} · ${span.name}`,
      trailing: durationText(span.durationMs),
      failed: !span.ok,
      lines: [span.ok ? { text: facts.join(' · ') } : { text: facts.join(' · '), tone: 'danger' }],
      offset,
      width,
    }
  })
}

// ─── The last 24 hours ───

function timeText(ms: number | null): string {
  return ms === null ? 'No call yet' : durationText(ms)
}

/** The numbers of the last 24 hours, as value rows. */
export function metricsRows(metrics: AppMetrics): { label: string; value: string }[] {
  return [
    { label: 'Calls', value: String(metrics.calls) },
    { label: 'Failed', value: String(metrics.failed) },
    { label: 'Median time', value: timeText(metrics.p50Ms) },
    { label: '95th percentile', value: timeText(metrics.p95Ms) },
  ]
}

/** One hour of the chart: its calls and its failed calls as fractions of the busiest hour. */
export interface HourBar {
  readonly start: number
  readonly calls: number
  readonly failed: number
}

/** The bar for each hour, the oldest first. An app with no call has 24 empty bars. */
export function hourBars(hours: AppMetrics['hours']): HourBar[] {
  const most = Math.max(...hours.map((hour) => hour.calls), 0)
  return hours.map((hour) => ({
    start: hour.start,
    calls: most === 0 ? 0 : hour.calls / most,
    failed: most === 0 ? 0 : Math.min(hour.failed, hour.calls) / most,
  }))
}

/** What the chart says to a person who cannot see it. */
export function hourBarsLabel(metrics: AppMetrics): string {
  const most = Math.max(...metrics.hours.map((hour) => hour.calls), 0)
  return `Calls in each of the last 24 hours. ${countText(metrics.calls, 'call')}, ${metrics.failed} failed. The most in one hour: ${most}.`
}

/** The lines of one operation in the last 24 hours: its calls, its times, and its last call. */
export function operationMetricLines(operation: AppOperationMetrics, now: number): RowLine[] {
  const lines: RowLine[] = [
    operation.failed > 0
      ? { text: `${operation.failed} of ${countText(operation.calls, 'call')} failed`, tone: 'danger' }
      : { text: countText(operation.calls, 'call') },
  ]
  if (operation.p50Ms !== null && operation.p95Ms !== null) {
    lines.push({ text: `Median ${durationText(operation.p50Ms)} · 95th percentile ${durationText(operation.p95Ms)}` })
  }
  if (operation.lastAt !== null) lines.push({ text: `Last call ${agoText(operation.lastAt, now)}` })
  return lines
}
