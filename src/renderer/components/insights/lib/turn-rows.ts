import type { MetricsQueryResult, MetricsValue } from '../../../../shared/observability-types'

// Result shape → the explore list.
//
// The console runs whatever the user asked for, so a result can be anything: a
// grouped rollup, a tool-call listing, or a turn listing. Only a turn listing
// can be rendered as the rich list with a waterfall behind each row. Rather
// than force every query into that shape, the page detects it and falls back to
// a plain result table — a grouped query is still a useful answer.
//
// Pure and non-reactive: the page reads these from `$derived`.

/** The columns a result must carry to be read as turns. */
const REQUIRED_TURN_COLUMNS = ['trace_id', 'started_at'] as const

export interface TurnRow {
  traceId: string
  sessionId: string | null
  startedAt: number
  durationMs: number | null
  status: string
  model: string | null
  provider: string | null
  origin: string | null
  promptSource: string | null
  prompt: string
  costUsd: number | null
  inputTokens: number | null
  outputTokens: number | null
  toolCallCount: number | null
}

function asNumber(value: MetricsValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asString(value: MetricsValue | undefined): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

export function isTurnResult(result: MetricsQueryResult | null): boolean {
  if (!result) return false
  return REQUIRED_TURN_COLUMNS.every((column) => result.columns.includes(column))
}

/** Rows a `turns` query produced, in the order the query returned them. Rows
 *  without a usable start time are dropped: they cannot be placed on the
 *  histogram or ordered against their siblings. */
export function toTurnRows(result: MetricsQueryResult | null): TurnRow[] {
  if (!isTurnResult(result) || !result) return []
  const index = new Map(result.columns.map((column, at) => [column, at]))
  const cell = (row: MetricsValue[], column: string): MetricsValue | undefined => {
    const at = index.get(column)
    return at === undefined ? undefined : row[at]
  }
  const rows: TurnRow[] = []
  for (const row of result.rows) {
    const traceId = asString(cell(row, 'trace_id'))
    const startedAt = asNumber(cell(row, 'started_at'))
    if (!traceId || startedAt == null) continue
    rows.push({
      traceId,
      startedAt,
      sessionId: asString(cell(row, 'session_id')),
      durationMs: asNumber(cell(row, 'duration_ms')),
      status: asString(cell(row, 'status')) ?? 'unknown',
      model: asString(cell(row, 'model')),
      provider: asString(cell(row, 'provider')),
      origin: asString(cell(row, 'origin')),
      promptSource: asString(cell(row, 'prompt_source')),
      prompt: asString(cell(row, 'prompt')) ?? '',
      costUsd: asNumber(cell(row, 'cost_usd')),
      inputTokens: asNumber(cell(row, 'input_tokens')),
      outputTokens: asNumber(cell(row, 'output_tokens')),
      toolCallCount: asNumber(cell(row, 'tool_call_count')),
    })
  }
  return rows
}

export type TurnStatusFilter = 'ok' | 'error' | 'interrupted'

export interface TurnStatusCounts {
  ok: number
  error: number
  interrupted: number
}

export function countByStatus(rows: TurnRow[]): TurnStatusCounts {
  const counts: TurnStatusCounts = { ok: 0, error: 0, interrupted: 0 }
  for (const row of rows) {
    if (row.status === 'ok') counts.ok += 1
    else if (row.status === 'error') counts.error += 1
    else if (row.status === 'interrupted') counts.interrupted += 1
  }
  return counts
}

export type TurnSortKey = 'startedAt' | 'durationMs' | 'costUsd' | 'tokens' | 'model' | 'sessionId' | 'prompt'

export interface TurnSort {
  key: TurnSortKey
  dir: 'asc' | 'desc'
}

function sortValue(row: TurnRow, key: TurnSortKey): string | number {
  switch (key) {
    case 'startedAt':
      return row.startedAt
    case 'durationMs':
      return row.durationMs ?? -1
    case 'costUsd':
      return row.costUsd ?? -1
    case 'tokens':
      return (row.inputTokens ?? 0) + (row.outputTokens ?? 0)
    case 'model':
      return row.model ?? ''
    case 'sessionId':
      return row.sessionId ?? ''
    case 'prompt':
      return row.prompt
  }
}

export function sortTurns(rows: TurnRow[], sort: TurnSort): TurnRow[] {
  const direction = sort.dir === 'asc' ? 1 : -1
  return rows.slice().sort((a, b) => {
    const left = sortValue(a, sort.key)
    const right = sortValue(b, sort.key)
    if (left === right) return 0
    return (left > right ? 1 : -1) * direction
  })
}

export interface SessionGroup {
  sessionId: string
  turns: TurnRow[]
  totalDurationMs: number
  totalCostUsd: number | null
  /** The most recent prompt in the group — what the collapsed row shows. */
  latestPrompt: string
}

/** Groups in first-appearance order, so the group list follows whatever sort
 *  the user chose rather than imposing a second one. */
export function groupBySession(rows: TurnRow[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>()
  for (const row of rows) {
    const sessionId = row.sessionId ?? 'unassigned'
    let group = groups.get(sessionId)
    if (!group) {
      group = {
        sessionId,
        turns: [],
        totalDurationMs: 0,
        totalCostUsd: null,
        latestPrompt: '',
      }
      groups.set(sessionId, group)
    }
    group.turns.push(row)
    group.totalDurationMs += row.durationMs ?? 0
    if (row.costUsd != null) group.totalCostUsd = (group.totalCostUsd ?? 0) + row.costUsd
  }
  for (const group of groups.values()) {
    const latest = group.turns.reduce((newest, row) => (row.startedAt > newest.startedAt ? row : newest))
    group.latestPrompt = latest.prompt
  }
  return [...groups.values()]
}

/** The p95 duration of the rows on screen — the threshold the list highlights
 *  a latency against. Null when too few rows carry a duration to mean anything. */
export function p95Duration(rows: TurnRow[]): number | null {
  const durations = rows
    .map((row) => row.durationMs)
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b)
  if (durations.length < 4) return null
  return durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))]
}
