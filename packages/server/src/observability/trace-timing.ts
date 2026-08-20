import type { MetricsSpan } from '@solus/contracts/observability-types'
import { SPAN_KINDS } from './registries'

type Interval = [number, number]

export function blockingIntervals(root: MetricsSpan, children: MetricsSpan[]): Interval[] {
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

export function intervalComplement(root: MetricsSpan, intervals: Interval[]): Interval[] {
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
export function effectiveTraceSpans(root: MetricsSpan, children: MetricsSpan[]): MetricsSpan[] {
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

export function thinkingTimeSql(rootAlias: string): string {
  return `(SELECT SUM(${effectiveDurationSql('thinking_child')}) FROM spans AS thinking_child`
    + ` WHERE thinking_child.trace_id = ${rootAlias}.trace_id`
    + ` AND thinking_child.kind = '${SPAN_KINDS.thinking}')`
}

/** Wall-clock remainder after the union of semantic blocking intervals. This
 *  is the query-view equivalent of the waterfall's derived gap total. */
export function providerWaitSql(rootAlias: string): string {
  const effectiveStart = effectiveStartedAtSql('wait_child')
  return `(WITH effective_intervals AS (`
    + ` SELECT MAX(${rootAlias}.started_at, ${effectiveStart}) AS started_at,`
    + ` MIN(${rootAlias}.ended_at, wait_child.ended_at) AS ended_at`
    + ` FROM spans AS wait_child`
    + ` WHERE wait_child.trace_id = ${rootAlias}.trace_id`
    + ` AND wait_child.span_id <> ${rootAlias}.span_id`
    + ` AND wait_child.kind <> '${SPAN_KINDS.backgroundTask}'`
    + ` AND wait_child.ended_at IS NOT NULL`
    + `), ordered_intervals AS (`
    + ` SELECT started_at, ended_at,`
    + ` MAX(ended_at) OVER (ORDER BY started_at, ended_at`
    + ` ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prior_ended_at`
    + ` FROM effective_intervals WHERE ended_at > started_at`
    + `), marked_intervals AS (`
    + ` SELECT started_at, ended_at,`
    + ` CASE WHEN prior_ended_at IS NULL OR started_at > prior_ended_at THEN 1 ELSE 0 END AS starts_group`
    + ` FROM ordered_intervals`
    + `), grouped_intervals AS (`
    + ` SELECT started_at, ended_at,`
    + ` SUM(starts_group) OVER (ORDER BY started_at, ended_at) AS interval_group`
    + ` FROM marked_intervals`
    + `), merged_intervals AS (`
    + ` SELECT MIN(started_at) AS started_at, MAX(ended_at) AS ended_at`
    + ` FROM grouped_intervals GROUP BY interval_group`
    + `) SELECT CASE WHEN ${rootAlias}.ended_at IS NULL THEN NULL ELSE MAX(0,`
    + ` ${rootAlias}.ended_at - ${rootAlias}.started_at`
    + ` - COALESCE((SELECT SUM(ended_at - started_at) FROM merged_intervals), 0)) END)`
}
