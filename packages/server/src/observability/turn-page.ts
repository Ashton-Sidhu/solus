import type {
  MetricsTurnPageRequest,
  MetricsTurnPageResult,
  MetricsTurnSortField,
  MetricsTurnStats,
  MetricsTurnStatusCounts,
  MetricsTurnVolumeBucket,
} from '@solus/contracts/observability-types'
import { TURN_VOLUME_BUCKET_COUNT } from '@solus/contracts/observability-types'
import { getReadOnlyMetricsDb } from './metrics-db'
import { runCompiledSql } from './sql-guard'

const MAX_PAGE_SIZE = 100

const TURN_COLUMNS = [
  'span_id',
  'trace_id',
  'session_id',
  'started_at',
  'duration_ms',
  'status',
  'model',
  'provider',
  'origin',
  'prompt',
  'prompt_source',
  'cost_usd',
  'input_tokens',
  'output_tokens',
  'tool_call_count',
] as const

const SORT_SQL = {
  started_at: 'started_at',
  duration_ms: 'duration_ms',
  cost_usd: 'cost_usd',
  tokens: '(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0))',
  model: 'model',
  session_id: 'session_id',
  prompt: 'prompt',
} satisfies Record<MetricsTurnSortField, string>

interface WhereClause {
  sql: string
  params: Array<string | number>
}

interface CountRow {
  total: number
}

interface StatusRow {
  ok: number
  error: number
  interrupted: number
}

interface StatsRow {
  counted: number
  failed: number
  total_cost_usd: number | null
  costed_count: number
  p50_duration_ms: number | null
  p95_duration_ms: number | null
}

interface VolumeRow {
  bucket_index: number
  total: number
  claude_code: number
  codex: number
  unknown_provider: number
  cost_usd: number
  costed_count: number
}

function normalizedRequest(request: MetricsTurnPageRequest): MetricsTurnPageRequest {
  const { from, to } = request.timeRange
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw new Error('Insights needs an ordered, finite time range.')
  }
  if (!Number.isInteger(request.pageIndex) || request.pageIndex < 0) {
    throw new Error('Insights pageIndex must be a non-negative integer.')
  }
  if (!Number.isInteger(request.pageSize) || request.pageSize < 1) {
    throw new Error('Insights pageSize must be a positive integer.')
  }
  if (!Object.hasOwn(SORT_SQL, request.sort.field)) {
    throw new Error(`Unsupported Insights turn sort: ${request.sort.field}`)
  }
  if (request.sort.dir !== 'asc' && request.sort.dir !== 'desc') {
    throw new Error(`Unsupported Insights turn sort direction: ${request.sort.dir}`)
  }
  return {
    ...request,
    pageSize: Math.min(request.pageSize, MAX_PAGE_SIZE),
    search: request.search?.trim() || undefined,
  }
}

function whereClause(request: MetricsTurnPageRequest, includeStatus: boolean): WhereClause {
  const conditions = ['started_at >= ?', 'started_at < ?']
  const params: Array<string | number> = [request.timeRange.from, request.timeRange.to]
  if (request.sessionId) {
    conditions.push('session_id = ?')
    params.push(request.sessionId)
  }
  if (request.taskId) {
    conditions.push('task_id = ?')
    params.push(request.taskId)
  }
  if (request.search) {
    const pattern = `%${request.search}%`
    conditions.push(`(
      prompt LIKE ? COLLATE NOCASE
      OR session_id LIKE ? COLLATE NOCASE
      OR model LIKE ? COLLATE NOCASE
      OR provider LIKE ? COLLATE NOCASE
    )`)
    params.push(pattern, pattern, pattern, pattern)
  }
  if (includeStatus && request.status) {
    conditions.push('status = ?')
    params.push(request.status)
  }
  return { sql: conditions.join(' AND '), params }
}

function countRows(where: WhereClause): number {
  const rawRow: unknown = getReadOnlyMetricsDb()
    .prepare(`SELECT COUNT(*) AS total FROM turns WHERE ${where.sql}`)
    .get(...where.params)
  // SAFETY: the aggregate statement always returns its single named row.
  const row = rawRow as CountRow
  return Number(row.total)
}

function statusCounts(where: WhereClause): MetricsTurnStatusCounts {
  const rawRow: unknown = getReadOnlyMetricsDb().prepare(`
    SELECT
      SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error,
      SUM(CASE WHEN status = 'interrupted' THEN 1 ELSE 0 END) AS interrupted
    FROM turns
    WHERE ${where.sql}
  `).get(...where.params)
  // SAFETY: the aggregate statement always returns its three named columns.
  const row = rawRow as StatusRow
  return {
    ok: Number(row.ok ?? 0),
    error: Number(row.error ?? 0),
    interrupted: Number(row.interrupted ?? 0),
  }
}

function stats(where: WhereClause): MetricsTurnStats {
  const rawRow: unknown = getReadOnlyMetricsDb().prepare(`
    WITH filtered AS (
      SELECT status, cost_usd, duration_ms
      FROM turns
      WHERE ${where.sql}
    ), ranked AS (
      SELECT
        duration_ms,
        ROW_NUMBER() OVER (ORDER BY duration_ms) AS rank,
        COUNT(*) OVER () AS duration_count
      FROM filtered
      WHERE duration_ms IS NOT NULL
    )
    SELECT
      (SELECT COUNT(*) FROM filtered) AS counted,
      (SELECT COUNT(*) FROM filtered WHERE status IN ('error', 'interrupted')) AS failed,
      (SELECT SUM(cost_usd) FROM filtered WHERE cost_usd IS NOT NULL) AS total_cost_usd,
      (SELECT COUNT(*) FROM filtered WHERE cost_usd IS NOT NULL) AS costed_count,
      (SELECT duration_ms FROM ranked
        WHERE rank = CAST(duration_count * 0.50 AS INTEGER) + 1 LIMIT 1) AS p50_duration_ms,
      (SELECT duration_ms FROM ranked
        WHERE duration_count >= 4
          AND rank = CAST(duration_count * 0.95 AS INTEGER) + 1 LIMIT 1) AS p95_duration_ms
  `).get(...where.params)
  // SAFETY: the CTE's final SELECT always returns its six named aggregates.
  const row = rawRow as StatsRow
  const counted = Number(row.counted ?? 0)
  const failed = Number(row.failed ?? 0)
  return {
    counted,
    failed,
    failureRate: counted > 0 ? failed / counted : 0,
    totalCostUsd: Number(row.costed_count ?? 0) > 0 ? Number(row.total_cost_usd ?? 0) : null,
    p50DurationMs: row.p50_duration_ms == null ? null : Number(row.p50_duration_ms),
    p95DurationMs: row.p95_duration_ms == null ? null : Number(row.p95_duration_ms),
  }
}

function volume(where: WhereClause, from: number, to: number): MetricsTurnVolumeBucket[] {
  const width = (to - from) / TURN_VOLUME_BUCKET_COUNT
  const rawRows: unknown = getReadOnlyMetricsDb().prepare(`
    SELECT
      MIN(${TURN_VOLUME_BUCKET_COUNT - 1}, CAST((started_at - ?) / ? AS INTEGER)) AS bucket_index,
      COUNT(*) AS total,
      SUM(CASE WHEN provider = 'claude-code' THEN 1 ELSE 0 END) AS claude_code,
      SUM(CASE WHEN provider = 'codex' THEN 1 ELSE 0 END) AS codex,
      SUM(CASE WHEN provider IS NULL OR provider NOT IN ('claude-code', 'codex') THEN 1 ELSE 0 END) AS unknown_provider,
      COALESCE(SUM(cost_usd), 0) AS cost_usd,
      SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS costed_count
    FROM turns
    WHERE ${where.sql}
    GROUP BY bucket_index
    ORDER BY bucket_index
  `).all(from, width, ...where.params)
  // SAFETY: every grouped row is projected to the exact seven columns below.
  const rows = rawRows as VolumeRow[]
  return rows.map((row) => ({
    at: from + Number(row.bucket_index) * width,
    endAt: from + (Number(row.bucket_index) + 1) * width,
    total: Number(row.total),
    claudeCode: Number(row.claude_code ?? 0),
    codex: Number(row.codex ?? 0),
    unknownProvider: Number(row.unknown_provider ?? 0),
    costUsd: Number(row.cost_usd ?? 0),
    costedCount: Number(row.costed_count ?? 0),
  }))
}

/** One bounded table page and the aggregates for every matching turn. */
export function turnPage(input: MetricsTurnPageRequest): MetricsTurnPageResult {
  const request = normalizedRequest(input)
  const unfilteredStatusWhere = whereClause(request, false)
  const filteredWhere = whereClause(request, true)
  const totalRows = countRows(filteredWhere)
  const lastPage = Math.max(0, Math.ceil(totalRows / request.pageSize) - 1)
  const pageIndex = Math.min(request.pageIndex, lastPage)
  const sortSql = SORT_SQL[request.sort.field]
  const direction = request.sort.dir.toUpperCase()
  const page = runCompiledSql(`
    SELECT ${TURN_COLUMNS.join(', ')}
    FROM turns
    WHERE ${filteredWhere.sql}
    ORDER BY ${sortSql} ${direction}, started_at DESC, span_id DESC
    LIMIT ? OFFSET ?
  `, [...filteredWhere.params, request.pageSize, pageIndex * request.pageSize], 'turns')

  return {
    page,
    pageIndex,
    pageSize: request.pageSize,
    totalRows,
    statusCounts: statusCounts(unfilteredStatusWhere),
    stats: stats(filteredWhere),
    volume: volume(filteredWhere, request.timeRange.from, request.timeRange.to),
  }
}
