import type { AppSpan } from '@solus/contracts/apps'

/**
 * The trace of one call as a waterfall (docs/plans/apps.md §9.2): each span is
 * a bar on the call's own time line. Pure, so the math is tested.
 */

export interface WaterfallRow {
  span: AppSpan
  /** Where the bar starts and how wide it is, in percent of the line. */
  leftPercent: number
  widthPercent: number
}

export interface Waterfall {
  /** The time the line covers, in milliseconds. */
  totalMs: number
  rows: WaterfallRow[]
}

/** The least width of a bar, so a span of no time still shows. */
const MIN_BAR_PERCENT = 0.75

/**
 * The spans of a call, the earliest first, on a line that covers the call. A
 * call that still runs has no time yet, and a span can end after the time the
 * host recorded: the line then ends where the last span ends.
 */
export function traceWaterfall(spans: readonly AppSpan[], callDurationMs: number | null): Waterfall {
  const lastEnd = spans.reduce((end, span) => Math.max(end, span.startMs + span.durationMs), 0)
  const totalMs = Math.max(callDurationMs ?? 0, lastEnd, 1)
  const rows = [...spans]
    .sort((a, b) => a.startMs - b.startMs)
    .map((span): WaterfallRow => {
      const leftPercent = Math.min(Math.max((span.startMs / totalMs) * 100, 0), 100 - MIN_BAR_PERCENT)
      const widthPercent = Math.min(Math.max((span.durationMs / totalMs) * 100, MIN_BAR_PERCENT), 100 - leftPercent)
      return { span, leftPercent, widthPercent }
    })
  return { totalMs, rows }
}

const SPAN_KIND_LABELS = {
  fetch: 'Network',
  tool: 'Tool',
  sql: 'SQL',
  file: 'File',
  signal: 'Signal',
  workflow: 'Workflow',
  step: 'Step',
  model: 'Model',
} satisfies { [Kind in AppSpan['kind']]: string }

export function spanKindLabel(kind: AppSpan['kind']): string {
  return SPAN_KIND_LABELS[kind]
}

/** When a log line was written, from the start of the call: "+12ms", "+1.4s". */
export function logLineOffset(atMs: number): string {
  return atMs < 1000 ? `+${Math.round(atMs)}ms` : `+${(atMs / 1000).toFixed(1)}s`
}
