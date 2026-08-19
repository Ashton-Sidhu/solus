// ─── Observability query contracts ───
//
// The serializable surface between the Insights clients and the metrics query
// engine (docs/plans/observability.md). A QuerySpec is what the builder edits
// and the server compiles to parameterized SQL; SQL text flows through the
// guarded read-only executor. Both return the same tabular result shape.

/** One cell of a query result. */
export type MetricsValue = string | number | boolean | null

export interface MetricsTimeRange {
  /** Inclusive lower bound on started_at, epoch ms. */
  from?: number
  /** Exclusive upper bound on started_at, epoch ms. */
  to?: number
}

export type MetricsFilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in'

export interface MetricsFilter {
  /** A spans column, an `attrs.<path>` JSON path, or a registry field name
   *  (registry names require an `eq` filter on `kind` in the same spec). */
  field: string
  op: MetricsFilterOp
  value: string | number | boolean | Array<string | number>
}

export type MetricsTimeBucket = 'minute' | 'hour' | 'day' | 'week' | 'month'

export type MetricsGroupBy = { field: string } | { timeBucket: MetricsTimeBucket }

export type MetricsAggregateFn = 'count' | 'avg' | 'min' | 'max' | 'sum' | 'p50' | 'p95'

export interface MetricsAggregate {
  fn: MetricsAggregateFn
  /** Field the aggregate reads. Required for everything except `count`. */
  field?: string
  /** Output column name. Defaults to the fn, or `<fn>_<field>`. */
  as?: string
}

/** The builder/preset query contract — table-less, always over `spans`. */
export interface MetricsQuerySpec {
  timeRange?: MetricsTimeRange
  filters?: MetricsFilter[]
  groupBy?: MetricsGroupBy[]
  /** Omit for a plain span listing (drill-through rows). */
  aggregates?: MetricsAggregate[]
  orderBy?: Array<{ field: string; dir: 'asc' | 'desc' }>
  limit?: number
}

export interface MetricsQueryResult {
  columns: string[]
  /** Row cells aligned to `columns`. */
  rows: MetricsValue[][]
  /** The registry view the query read — the declared grain the client picks a
   *  result shape from. Absent when no single view is identifiable (a join of
   *  two views, raw `spans`, a CTE-wrapped source) or on results from hosts
   *  that predate the field. */
  sourceView?: string
}

export type MetricsFieldType = 'string' | 'number' | 'boolean' | 'duration'

/** The role a column plays in a query — what the schema panel groups by so a
 *  table reads as a data model rather than a flat column dump. */
export type MetricsFieldGroup =
  | 'identity'
  | 'dimension'
  | 'timing'
  | 'measure'
  | 'child_time'
  | 'tool'
  | 'detail'

export interface MetricsFieldDescriptor {
  /** The SQL column name in the view. */
  name: string
  type: MetricsFieldType
  description: string
  /** Absent on results from hosts that predate field groups. */
  group?: MetricsFieldGroup
}

export interface MetricsViewDescriptor {
  view: string
  /** The span kinds the view slices out of `spans` — one for `turns`, many for
   *  `events` and `internal_events`. */
  kinds: string[]
  /** True for the separate `internal.*` Solus-health slice. */
  internal: boolean
  description: string
  columns: MetricsFieldDescriptor[]
}

/** The `spans` fact table every generated view reads from. Served alongside the
 *  views because a cross-kind question is written against it directly. */
export interface MetricsBaseTable {
  table: string
  description: string
  columns: MetricsFieldDescriptor[]
}

/** The field registry as served to clients: views, columns, types, docs. */
export interface MetricsSchema {
  views: MetricsViewDescriptor[]
  base: MetricsBaseTable
  /** How the views and the fact table relate — one statement per fact. Every
   *  surface that documents the schema states the same model from this list. */
  relationships: string[]
}

export type MetricsSqlValidation =
  | { ok: true; columns: string[] }
  | { ok: false; error: string; offset?: number; guardViolation?: boolean }

export interface MetricsNlCompileResult {
  sql: string
  /** Whether the final SQL prepared cleanly against the guarded executor. */
  ok: boolean
  error?: string
  attempts: number
}

/** A user-authored query persisted in solus.db. Exactly one form owns it:
 *  a builder-editable spec, or editor-owned SQL text. */
export interface SavedMetricsQuery {
  id: string
  name: string
  form: 'spec' | 'sql'
  spec?: MetricsQuerySpec
  sql?: string
  createdAt: number
  updatedAt: number
}

export type MetricsAttrValue = string | number | boolean

export interface MetricsSpan {
  spanId: string
  parentSpanId: string | null
  traceId: string
  kind: string
  name: string
  service: string
  sessionId: string | null
  provider: string | null
  model: string | null
  projectRoot: string | null
  origin: string | null
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  status: string
  attrs: Record<string, MetricsAttrValue>
}

export type MetricsGapCategory =
  | 'provider_startup'
  | 'before_first_activity'
  | 'between_activities'
  | 'provider_completion'
  | 'turn_settlement'
  | 'after_last_provider_event'
  | 'unattributed'

/** One uncovered interval inside a turn. The category describes where the gap
 *  sits between observed lifecycle boundaries; it does not claim what the
 *  provider or model did during that interval. */
export interface MetricsGapSegment {
  category: MetricsGapCategory
  startedAt: number
  endedAt: number
  durationMs: number
}

/** One turn's full span tree for the waterfall. */
export interface MetricsTurnTrace {
  traceId: string
  spans: MetricsSpan[]
  /** Root turn time not covered by the union of observed blocking child
   *  intervals. Null when the trace has no root turn span. */
  unattributedMs: number | null
  /** The uncovered intervals split at observed provider and settlement
   *  boundaries. Their durations sum to `unattributedMs`. */
  gapSegments: MetricsGapSegment[]
}

export interface MetricsTurnSummary {
  /** Display ordinal over `(startedAt, spanId)` — computed at query time,
   *  never persisted. */
  turnNumber: number
  traceId: string
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  status: string
  model: string | null
  origin: string | null
  promptSource: string | null
  /** The turn's own ask, as one line and capped for the wire: a session rollup
   *  names its turns by what was asked, and a full prompt is unbounded text
   *  nobody reads in a list row. Null when the turn recorded no prompt. */
  prompt: string | null
  costUsd: number | null
  inputTokens: number | null
  outputTokens: number | null
  toolCallCount: number | null
}

export interface MetricsSessionSummary {
  sessionId: string
  /** First task identity recorded by any turn in the session. Optional for
   *  hosts that predate session-level task context. */
  taskId?: string | null
  taskTitle?: string | null
  turnCount: number
  totalDurationMs: number
  /** Sum of turns with known cost. Null when no turn has a known cost. */
  totalCostUsd: number | null
  totalInputTokens: number
  totalOutputTokens: number
  turns: MetricsTurnSummary[]
}
