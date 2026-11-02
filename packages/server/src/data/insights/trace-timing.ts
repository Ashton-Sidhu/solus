import { SPAN_KINDS, type SpanKind } from './registries'

type Interval = [number, number]

/** What the timing model reads of a span: the trace root's own interval, and
 *  of each child its kind and interval. A `MetricsSpan` and a `spans` row both
 *  satisfy it, so the trace view and the root's stored measures share one
 *  definition of Thinking and provider wait. */
export interface TimedSpan {
  spanId: string
  kind: string
  startedAt: number
  endedAt: number | null
  durationMs: number | null
}

export type TimedRoot = Pick<TimedSpan, 'startedAt' | 'endedAt'>

export function blockingIntervals(root: TimedRoot, children: TimedSpan[]): Interval[] {
  if (root.endedAt === null) return []
  const intervals: Interval[] = []
  for (const child of children) {
    if (child.kind === SPAN_KINDS.backgroundTask || child.endedAt === null) continue
    const startedAt = Math.max(child.startedAt, root.startedAt)
    const endedAt = Math.min(child.endedAt, root.endedAt)
    if (endedAt > startedAt) intervals.push([startedAt, endedAt])
  }
  return intervals.sort((a, b) => a[0] - b[0])
}

export function intervalComplement(root: TimedRoot, intervals: Interval[]): Interval[] {
  if (root.endedAt === null) return []
  const gaps: Interval[] = []
  let cursor = root.startedAt
  for (const [rawStart, rawEnd] of intervals) {
    const startedAt = Math.max(root.startedAt, rawStart)
    const endedAt = Math.min(root.endedAt, rawEnd)
    if (startedAt > cursor) gaps.push([cursor, startedAt])
    if (endedAt > cursor) cursor = endedAt
  }
  if (cursor < root.endedAt) gaps.push([cursor, root.endedAt])
  return gaps
}

/** The product timing model for Thinking. A provider can report only after the
 *  model has begun to reason, so Thinking owns the immediately preceding
 *  uncovered interval. Persisted spans stay as provider facts; semantic query
 *  and waterfall surfaces use this projection. */
export function effectiveTraceSpans<Span extends TimedSpan>(root: TimedRoot, children: Span[]): Span[] {
  return children.map((child) => {
    if (child.kind !== SPAN_KINDS.thinking) return child
    const blockers = children.filter((candidate) =>
      candidate.spanId !== child.spanId
      && candidate.kind !== SPAN_KINDS.backgroundTask
      && candidate.endedAt !== null,
    )
    const hasBlockingOverlap = blockers.some((candidate) =>
      candidate.startedAt <= child.startedAt
      && (candidate.endedAt ?? candidate.startedAt) > child.startedAt,
    )
    if (hasBlockingOverlap) return child
    const startedAt = blockers.reduce(
      (latest, candidate) => candidate.endedAt !== null && candidate.endedAt <= child.startedAt
        ? Math.max(latest, candidate.endedAt)
        : latest,
      root.startedAt,
    )
    if (startedAt >= child.startedAt) return child
    return {
      ...child,
      startedAt,
      durationMs: child.endedAt === null ? null : Math.max(0, child.endedAt - startedAt),
    }
  })
}

function rootStartSql(rowAlias: string): string {
  return `(SELECT timing_root.started_at FROM spans AS timing_root`
    + ` WHERE timing_root.span_id = ${rowAlias}.trace_id)`
}

/** SQL counterpart of `effectiveTraceSpans`, kept beside it so the generated
 *  `events` and `turns` views cannot invent a separate Thinking definition. */
export function effectiveStartedAtSql(rowAlias: string): string {
  const rootStartedAt = rootStartSql(rowAlias)
  const blocker = `timing_blocker.trace_id = ${rowAlias}.trace_id`
    + ` AND timing_blocker.span_id <> ${rowAlias}.span_id`
    + ` AND timing_blocker.span_id <> timing_blocker.trace_id`
    + ` AND timing_blocker.kind <> '${SPAN_KINDS.backgroundTask}'`
    + ' AND timing_blocker.ended_at IS NOT NULL'
  return `CASE WHEN ${rowAlias}.kind <> '${SPAN_KINDS.thinking}' THEN ${rowAlias}.started_at`
    + ` WHEN EXISTS (SELECT 1 FROM spans AS timing_blocker WHERE ${blocker}`
    + ` AND timing_blocker.started_at <= ${rowAlias}.started_at`
    + ` AND timing_blocker.ended_at > ${rowAlias}.started_at) THEN ${rowAlias}.started_at`
    + ` ELSE COALESCE((SELECT MAX(timing_blocker.ended_at) FROM spans AS timing_blocker`
    + ` WHERE ${blocker} AND timing_blocker.ended_at <= ${rowAlias}.started_at),`
    + ` ${rootStartedAt}, ${rowAlias}.started_at) END`
}

export function effectiveDurationSql(rowAlias: string): string {
  return `CASE WHEN ${rowAlias}.ended_at IS NULL THEN NULL`
    + ` ELSE MAX(0, ${rowAlias}.ended_at - (${effectiveStartedAtSql(rowAlias)})) END`
}

/** The measures stored on a turn's root when it ends (plans/029 §6, P3): the
 *  columns the `turns` view selects. Each per-kind sum is a duration total over
 *  the trace's children of that kind, null when the trace has none, so a
 *  parallel pair of tools sums past wall-clock by design. */
export interface TurnMeasures {
  providerWaitMs: number | null
  thinkingTimeMs: number | null
  toolTimeMs: number | null
  streamingTimeMs: number | null
  setupTimeMs: number | null
  permissionWaitMs: number | null
  questionWaitMs: number | null
  compactionTimeMs: number | null
  queueWaitMs: number | null
  rateLimitWaitMs: number | null
  settlementTimeMs: number | null
}

function kindTotal(children: TimedSpan[], kind: SpanKind): number | null {
  let total: number | null = null
  for (const child of children) {
    if (child.kind !== kind || child.durationMs === null) continue
    total = (total ?? 0) + child.durationMs
  }
  return total
}

/** Root wall-clock time outside the union of blocking child intervals, after
 *  Thinking has absorbed its lead-ins; null while the root is open. */
export function providerWaitMs(root: TimedRoot, children: TimedSpan[]): number | null {
  if (root.endedAt === null) return null
  return intervalComplement(root, blockingIntervals(root, effectiveTraceSpans(root, children)))
    .reduce((total, [startedAt, endedAt]) => total + (endedAt - startedAt), 0)
}

/** A root's measures from its children. `children` is every other span of the
 *  trace; the caller passes them when the root has ended. */
export function turnMeasures(root: TimedRoot, children: TimedSpan[]): TurnMeasures {
  const attributed = effectiveTraceSpans(root, children)
  return {
    providerWaitMs: providerWaitMs(root, children),
    thinkingTimeMs: kindTotal(attributed, SPAN_KINDS.thinking),
    toolTimeMs: kindTotal(children, SPAN_KINDS.toolCall),
    streamingTimeMs: kindTotal(children, SPAN_KINDS.responseStream),
    setupTimeMs: kindTotal(children, SPAN_KINDS.setup),
    permissionWaitMs: kindTotal(children, SPAN_KINDS.permissionWait),
    questionWaitMs: kindTotal(children, SPAN_KINDS.questionWait),
    compactionTimeMs: kindTotal(children, SPAN_KINDS.contextCompaction),
    queueWaitMs: kindTotal(children, SPAN_KINDS.queueWait),
    rateLimitWaitMs: kindTotal(children, SPAN_KINDS.rateLimitWait),
    settlementTimeMs: kindTotal(children, SPAN_KINDS.turnSettlement),
  }
}
