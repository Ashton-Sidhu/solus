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

/** One column of a query result.
 *
 *  `type` is the registry's declared type, carried through so the client reads
 *  a column's meaning instead of inferring it from the cells. It is absent only
 *  where no declaration exists — an aliased aggregate or a computed expression
 *  in free-form SQL — and a reader that needs a type there must decode the
 *  values itself. */
export interface MetricsResultColumn {
  name: string
  type?: MetricsFieldType
}

export interface MetricsQueryResult {
  columns: MetricsResultColumn[]
  /** Row cells aligned to `columns`. */
  rows: MetricsValue[][]
  /** The registry view the query read — the declared grain the client picks a
   *  result shape from. Absent when no single view is identifiable (a join of
   *  two views, raw `spans`, a CTE-wrapped source) or on results from hosts
   *  that predate the field. */
  sourceView?: string
}

export type MetricsTurnStatus = 'ok' | 'error' | 'interrupted'

export type MetricsTurnSortField =
  | 'started_at'
  | 'duration_ms'
  | 'cost_usd'
  | 'tokens'
  | 'model'
  | 'session_id'
  | 'prompt'

/** The normal Insights turn listing. The server applies every filter before it
 * paginates, so a page is a window into the selected dataset rather than the
 * whole dataset being copied to the client. */
export interface MetricsTurnPageRequest {
  timeRange: Required<MetricsTimeRange>
  pageIndex: number
  pageSize: number
  sort: { field: MetricsTurnSortField; dir: 'asc' | 'desc' }
  status?: MetricsTurnStatus
  search?: string
  sessionId?: string
  taskId?: string
}

export interface MetricsTurnStatusCounts {
  ok: number
  error: number
  interrupted: number
}

export interface MetricsTurnStats {
  counted: number
  failed: number
  failureRate: number
  totalCostUsd: number | null
  p50DurationMs: number | null
  p95DurationMs: number | null
}

/**
 * How many intervals the turn-volume histogram is aggregated into.
 *
 * The server aggregates to this, and the demo fixture has to produce the same
 * shape or the demo histogram is not the histogram. Declared once so the two
 * cannot disagree.
 */
export const TURN_VOLUME_BUCKET_COUNT = 112

/** One server-aggregated chart interval. Its size is bounded independently of
 * the number of turns in the selected range. */
export interface MetricsTurnVolumeBucket {
  at: number
  endAt: number
  total: number
  claudeCode: number
  codex: number
  unknownProvider: number
  costUsd: number
  costedCount: number
}

export interface MetricsTurnPageResult {
  page: MetricsQueryResult
  pageIndex: number
  pageSize: number
  totalRows: number
  statusCounts: MetricsTurnStatusCounts
  stats: MetricsTurnStats
  volume: MetricsTurnVolumeBucket[]
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
  attrs: MetricsSpanAttrs
}

/**
 * Every attribute the span registry declares, across all kinds.
 *
 * The registry (`field-registry.ts`) is the source of truth: it names each
 * attribute, its kind, and its type, and generates the SQL views from that. This
 * is the read side of the same declaration, so a reader gets the attribute's
 * type instead of a union it has to narrow.
 *
 * Every field is optional because a span carries only its own kind's attributes
 * — reading `input` off a turn root yields `undefined`, which is what the type
 * says. It is deliberately closed: the emitter's write side stays open (a
 * dispatch step records arbitrary paths and argv), but reading an attribute the
 * registry does not declare should be a deliberate act, not a typo that
 * silently yields `undefined`. `metrics-attrs.test.ts` fails if the two drift.
 */
export interface MetricsSpanAttrs {
  // turn
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  interTurnIdleMs?: number
  timeToFirstActivityMs?: number
  timeToFirstTextMs?: number
  timeToFirstProviderEventMs?: number
  timeToLastProviderEventMs?: number
  timeToProviderCompleteMs?: number
  automationName?: string
  automationId?: string
  taskTitle?: string
  taskId?: string
  projectName?: string
  branch?: string
  hostname?: string
  hostOs?: string
  promptSource?: string
  isResume?: boolean
  hasThinking?: boolean
  prompt?: string
  promptTruncated?: boolean
  systemPrompt?: string
  systemPromptChars?: number
  systemPromptTruncated?: boolean
  response?: string
  responseChars?: number
  responseTruncated?: boolean

  // turn and agent_run
  promptChars?: number
  reasoningEffort?: string
  toolCallCount?: number
  permissionDenialCount?: number

  // tool_call
  input?: string
  inputTruncated?: boolean
  declined?: boolean
  providerDurationMs?: number
  isSubagent?: boolean
  parentToolUseId?: string

  // tool_call, agent_run, internal.dispatch_step
  error?: string
  // tool_call and agent_run
  exitCode?: number
  // tool_call and background_task
  outcomeStatus?: string

  // permission_wait and question_wait
  decision?: string
  // question_wait
  questionCount?: number

  // context_compaction
  trigger?: string

  // background_task
  blocking?: boolean
  toolUseId?: string

  // agent_run
  timedOut?: boolean

  // internal.dispatch_step
  step?: string
  fn?: string
  file?: string

  // Synthesised by the waterfall for a gap pseudo-span, never persisted: a gap
  // is a server-derived coverage interval that the client draws as a span.
  category?: MetricsGapCategory
  description?: string
}

export type MetricsGapCategory =
  | 'provider_startup'
  | 'before_first_activity'
  | 'between_activities'
  | 'provider_completion'
  | 'turn_settlement'
  | 'after_last_provider_event'
  | 'provider_wait'

/** One uncovered interval inside a turn. The category describes where the gap
 *  sits between observed lifecycle boundaries; it does not claim what the
 *  provider or model did during that interval. */
export interface MetricsGapSegment {
  category: MetricsGapCategory
  startedAt: number
  endedAt: number
  durationMs: number
}

export type MetricsLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** One structured logger emission owned by a span in the trace. */
export interface MetricsLogEvent {
  traceId: string
  spanId: string
  occurredAt: number
  level: MetricsLogLevel
  name: string
  tag: string
  file: string
  attrs: Record<string, string | number | boolean>
}

/** One turn's full span tree for the waterfall. */
export interface MetricsTurnTrace {
  traceId: string
  spans: MetricsSpan[]
  logEvents: MetricsLogEvent[]
  /** Root turn time outside semantic blocking activity. Null when the trace
   *  has no root turn span. */
  providerWaitMs: number | null
  /** The uncovered intervals split at observed provider and settlement
   *  boundaries. Their durations sum to `providerWaitMs`. */
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
