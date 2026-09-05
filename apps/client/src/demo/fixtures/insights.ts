import type {
  MetricsQueryResult,
  MetricsSessionSummary,
  MetricsSpan,
  MetricsTurnPageRequest,
  MetricsTurnPageResult,
  MetricsTurnSortField,
  MetricsTurnStats,
  MetricsTurnStatusCounts,
  MetricsTurnTrace,
  MetricsTurnVolumeBucket,
} from '@solus/contracts/observability-types'
import { TURN_VOLUME_BUCKET_COUNT } from '@solus/contracts/observability-types'
import { TURN_LISTING_COLUMNS, TURN_SELECT_COLUMNS } from '@solus/workspace-ui/components/insights/lib/insights-queries'
import { DEMO_PROJECT } from './types'

// Recorded runs for the Insights page.
//
// The real page reads `metrics.db` through a guarded SQL executor; the demo has
// no database and no SQL engine, so it serves this fixed set of turns instead.
// Everything the page can ask for is derived from it: the histogram, the explore
// listing, each turn's waterfall, and the session rollup behind a turn.
//
// Times are minutes before the visit rather than instants. A fixture authored
// with absolute timestamps would fall out of the default "last 24 hours" window
// the moment it aged, and the page would open on an empty chart.

/** One recorded turn, as the fixture states it. */
interface DemoTurn {
  /** Minutes before the visit the turn started. */
  minutesAgo: number
  sessionId: string
  model: string
  prompt: string
  promptSource: string
  origin: string
  status: 'ok' | 'error' | 'interrupted'
  durationMs: number
  costUsd: number
  inputTokens: number
  outputTokens: number
  /** Tool calls in the turn, as `[name, duration]` — the waterfall's bars. */
  tools: Array<[string, number]>
}

const RATELIMIT = 'demo-session-ratelimit'
const WEBHOOKS = 'demo-session-webhooks'
const BILLING = 'demo-session-billing'

/** Insights can be asked about a task, whose turns are the turns of every
 *  session that worked it. The demo has one session per task, and these are the
 *  same bindings `data/tasks.json` states. */
export const DEMO_SESSION_BY_TASK = new Map<string, string>([
  ['ACME-214', RATELIMIT],
  ['demo-task-7', WEBHOOKS],
  ['demo-task-4', BILLING],
])

const SONNET = 'claude-sonnet-5'
const OPUS = 'claude-opus-4-8'

const DEMO_TURNS: DemoTurn[] = [
  { minutesAgo: 3, sessionId: RATELIMIT, model: SONNET, prompt: 'Return the standard rate-limit headers on every 429, not just the enforced ones.', promptSource: 'user', origin: 'chat', status: 'ok', durationMs: 74_200, costUsd: 0.41, inputTokens: 61_400, outputTokens: 3_120, tools: [['Read', 1_900], ['Edit', 2_400], ['Bash', 18_700], ['Read', 1_100]] },
  { minutesAgo: 9, sessionId: RATELIMIT, model: SONNET, prompt: 'The concurrency test is flaky under load. Make the bucket refill deterministic.', promptSource: 'user', origin: 'chat', status: 'ok', durationMs: 121_800, costUsd: 0.68, inputTokens: 74_900, outputTokens: 5_640, tools: [['Read', 2_200], ['Grep', 900], ['Edit', 3_100], ['Bash', 41_300], ['Bash', 22_800]] },
  { minutesAgo: 21, sessionId: RATELIMIT, model: SONNET, prompt: 'Wire the middleware into the public router and keep local development unlimited.', promptSource: 'user', origin: 'chat', status: 'ok', durationMs: 58_400, costUsd: 0.29, inputTokens: 48_200, outputTokens: 2_480, tools: [['Read', 1_500], ['Edit', 2_900], ['Bash', 12_600]] },
  { minutesAgo: 34, sessionId: RATELIMIT, model: SONNET, prompt: 'Run the rate-limit suite.', promptSource: 'user', origin: 'chat', status: 'error', durationMs: 26_900, costUsd: 0.08, inputTokens: 21_700, outputTokens: 640, tools: [['Bash', 19_400]] },
  { minutesAgo: 47, sessionId: RATELIMIT, model: SONNET, prompt: 'Add per-key rate limiting to the public API. Use Redis, return standard headers, and keep local development usable.', promptSource: 'user', origin: 'chat', status: 'ok', durationMs: 214_600, costUsd: 1.12, inputTokens: 96_300, outputTokens: 9_870, tools: [['Read', 3_400], ['Read', 2_100], ['Grep', 1_200], ['Write', 4_600], ['Edit', 3_300], ['Bash', 54_900], ['Bash', 31_200]] },
  { minutesAgo: 68, sessionId: WEBHOOKS, model: SONNET, prompt: 'Add an interleaving regression test for two endpoints retrying at once.', promptSource: 'user', origin: 'chat', status: 'ok', durationMs: 96_300, costUsd: 0.52, inputTokens: 58_800, outputTokens: 4_210, tools: [['Read', 1_800], ['Write', 3_900], ['Bash', 34_700]] },
  { minutesAgo: 82, sessionId: WEBHOOKS, model: SONNET, prompt: 'Inject the scheduling clock so the timing tests stop depending on wall time.', promptSource: 'user', origin: 'chat', status: 'ok', durationMs: 88_100, costUsd: 0.47, inputTokens: 55_100, outputTokens: 3_760, tools: [['Read', 2_000], ['Edit', 3_200], ['Edit', 2_700], ['Bash', 27_400]] },
  { minutesAgo: 97, sessionId: WEBHOOKS, model: SONNET, prompt: 'Retry the delivery worker suite.', promptSource: 'user', origin: 'chat', status: 'interrupted', durationMs: 14_300, costUsd: 0.04, inputTokens: 16_900, outputTokens: 310, tools: [['Bash', 11_800]] },
  { minutesAgo: 118, sessionId: WEBHOOKS, model: SONNET, prompt: 'Remove the endpoint-scoped retry counters — they leak across deliveries.', promptSource: 'user', origin: 'chat', status: 'ok', durationMs: 132_500, costUsd: 0.71, inputTokens: 68_400, outputTokens: 5_980, tools: [['Grep', 1_100], ['Read', 2_300], ['Edit', 4_100], ['Bash', 38_600]] },
  { minutesAgo: 143, sessionId: WEBHOOKS, model: SONNET, prompt: 'Fix the flaky retry logic in webhook delivery. Preserve idempotency and make the timing tests deterministic.', promptSource: 'user', origin: 'chat', status: 'ok', durationMs: 187_900, costUsd: 0.96, inputTokens: 88_700, outputTokens: 8_430, tools: [['Read', 2_800], ['Grep', 1_400], ['Read', 1_900], ['Edit', 3_700], ['Bash', 47_200], ['Bash', 29_800]] },
  { minutesAgo: 186, sessionId: RATELIMIT, model: SONNET, prompt: 'Summarize what changed on this branch for the pull request body.', promptSource: 'automation', origin: 'automation', status: 'ok', durationMs: 41_700, costUsd: 0.18, inputTokens: 34_600, outputTokens: 1_920, tools: [['Read', 2_600]] },
  { minutesAgo: 232, sessionId: BILLING, model: OPUS, prompt: 'What does the current subscription model assume that usage-based pricing breaks?', promptSource: 'user', origin: 'chat', status: 'ok', durationMs: 156_400, costUsd: 1.84, inputTokens: 71_200, outputTokens: 7_640, tools: [['Read', 3_100], ['Grep', 1_600], ['Read', 2_400]] },
  { minutesAgo: 271, sessionId: BILLING, model: OPUS, prompt: 'Plan the migration from flat subscriptions to usage-based pricing. Do not edit code yet.', promptSource: 'user', origin: 'chat', status: 'ok', durationMs: 268_300, costUsd: 3.27, inputTokens: 104_800, outputTokens: 14_260, tools: [['Read', 4_200], ['Read', 3_600], ['Grep', 2_100], ['Read', 2_900]] },
  { minutesAgo: 344, sessionId: WEBHOOKS, model: SONNET, prompt: 'Which deliveries retried more than three times yesterday?', promptSource: 'user', origin: 'chat', status: 'ok', durationMs: 52_800, costUsd: 0.24, inputTokens: 39_100, outputTokens: 2_140, tools: [['Bash', 16_300], ['Read', 1_700]] },
  { minutesAgo: 402, sessionId: RATELIMIT, model: SONNET, prompt: 'Draft the rate-limit section of the API docs.', promptSource: 'user', origin: 'chat', status: 'ok', durationMs: 63_100, costUsd: 0.31, inputTokens: 42_800, outputTokens: 3_480, tools: [['Read', 2_200], ['Write', 3_800]] },
  { minutesAgo: 498, sessionId: BILLING, model: OPUS, prompt: 'Cost the backfill: how many request-log rows are we talking about?', promptSource: 'user', origin: 'chat', status: 'ok', durationMs: 94_600, costUsd: 1.21, inputTokens: 58_300, outputTokens: 4_910, tools: [['Bash', 28_400], ['Read', 2_100]] },
  { minutesAgo: 587, sessionId: WEBHOOKS, model: SONNET, prompt: 'Check the delivery worker for anything that still reads global state.', promptSource: 'user', origin: 'chat', status: 'ok', durationMs: 78_400, costUsd: 0.39, inputTokens: 51_600, outputTokens: 3_210, tools: [['Grep', 1_300], ['Read', 2_500], ['Read', 1_800]] },
  { minutesAgo: 663, sessionId: RATELIMIT, model: SONNET, prompt: 'Rerun the failing bucket test with more logging.', promptSource: 'user', origin: 'chat', status: 'error', durationMs: 33_200, costUsd: 0.11, inputTokens: 26_400, outputTokens: 890, tools: [['Edit', 2_300], ['Bash', 24_100]] },
  { minutesAgo: 741, sessionId: BILLING, model: OPUS, prompt: 'Write up the rollout risks for the pricing change.', promptSource: 'user', origin: 'chat', status: 'ok', durationMs: 142_700, costUsd: 1.68, inputTokens: 66_900, outputTokens: 8_120, tools: [['Read', 2_700], ['Write', 4_400]] },
  { minutesAgo: 892, sessionId: WEBHOOKS, model: SONNET, prompt: 'Regenerate the review report for this branch.', promptSource: 'automation', origin: 'automation', status: 'ok', durationMs: 108_900, costUsd: 0.58, inputTokens: 62_400, outputTokens: 5_030, tools: [['Read', 3_100], ['Read', 2_400], ['Grep', 1_500]] },
  { minutesAgo: 1_014, sessionId: RATELIMIT, model: SONNET, prompt: 'Sketch the Redis key layout before we commit to it.', promptSource: 'user', origin: 'chat', status: 'ok', durationMs: 71_300, costUsd: 0.34, inputTokens: 45_700, outputTokens: 3_890, tools: [['Read', 2_000]] },
  { minutesAgo: 1_186, sessionId: BILLING, model: OPUS, prompt: 'How do competitors price overage, and what does that imply for our tiers?', promptSource: 'user', origin: 'chat', status: 'ok', durationMs: 197_500, costUsd: 2.44, inputTokens: 82_100, outputTokens: 11_380, tools: [['Read', 3_300]] },
  { minutesAgo: 1_298, sessionId: WEBHOOKS, model: SONNET, prompt: 'Nightly branch report.', promptSource: 'automation', origin: 'automation', status: 'ok', durationMs: 86_200, costUsd: 0.44, inputTokens: 54_300, outputTokens: 3_640, tools: [['Read', 2_800], ['Grep', 1_200]] },
  { minutesAgo: 1_402, sessionId: RATELIMIT, model: SONNET, prompt: 'List every endpoint that would need a limit before launch.', promptSource: 'user', origin: 'chat', status: 'ok', durationMs: 49_600, costUsd: 0.22, inputTokens: 37_500, outputTokens: 2_260, tools: [['Grep', 1_400], ['Read', 2_100]] },
]

/** A turn as every projection here reads it: the fixture row placed in time. */
export interface DemoTurnRecord extends DemoTurn {
  traceId: string
  spanId: string
  startedAt: number
  toolTimeMs: number
  toolCallCount: number
}

function hexId(prefix: string, index: number, salt: number): string {
  return `${prefix}${(index + 1).toString(16).padStart(4, '0')}${(salt * 2654435761 % 0xffffffff).toString(16).padStart(8, '0')}`
}

/** The fixture placed against the visit. Built once per page load, so every
 *  answer on the page describes the same instants. */
export function demoTurnRecords(now: number): DemoTurnRecord[] {
  return DEMO_TURNS.map((turn, index) => ({
    ...turn,
    traceId: hexId('7a', index, index + 11),
    spanId: hexId('5c', index, index + 29),
    startedAt: now - turn.minutesAgo * 60_000,
    toolTimeMs: turn.tools.reduce((total, [, ms]) => total + ms, 0),
    toolCallCount: turn.tools.length,
  }))
}

const TURN_CELL = {
  span_id: (turn) => turn.spanId,
  trace_id: (turn) => turn.traceId,
  session_id: (turn) => turn.sessionId,
  started_at: (turn) => turn.startedAt,
  duration_ms: (turn) => turn.durationMs,
  status: (turn) => turn.status,
  model: (turn) => turn.model,
  provider: () => 'claude',
  origin: (turn) => turn.origin,
  prompt: (turn) => turn.prompt,
  prompt_source: (turn) => turn.promptSource,
  cost_usd: (turn) => turn.costUsd,
  input_tokens: (turn) => turn.inputTokens,
  output_tokens: (turn) => turn.outputTokens,
  tool_call_count: (turn) => turn.toolCallCount,
} satisfies Record<(typeof TURN_SELECT_COLUMNS)[number], (turn: DemoTurnRecord) => string | number | null>

/** The turn listing, in the column order the explore query selects. */
export function turnListingResult(turns: DemoTurnRecord[]): MetricsQueryResult {
  return {
    columns: TURN_LISTING_COLUMNS,
    rows: turns.map((turn) => TURN_SELECT_COLUMNS.map((column) => TURN_CELL[column](turn))),
    sourceView: 'turns',
  }
}

const SORT_VALUE = {
  started_at: (turn) => turn.startedAt,
  duration_ms: (turn) => turn.durationMs,
  cost_usd: (turn) => turn.costUsd,
  tokens: (turn) => turn.inputTokens + turn.outputTokens,
  model: (turn) => turn.model,
  session_id: (turn) => turn.sessionId,
  prompt: (turn) => turn.prompt,
} satisfies Record<MetricsTurnSortField, (turn: DemoTurnRecord) => string | number>

function matchesSearch(turn: DemoTurnRecord, search: string): boolean {
  const needle = search.toLowerCase()
  return [turn.prompt, turn.sessionId, turn.model, 'claude']
    .some((field) => field.toLowerCase().includes(needle))
}

function statusCountsOf(turns: DemoTurnRecord[]): MetricsTurnStatusCounts {
  return {
    ok: turns.filter((turn) => turn.status === 'ok').length,
    error: turns.filter((turn) => turn.status === 'error').length,
    interrupted: turns.filter((turn) => turn.status === 'interrupted').length,
  }
}

/** The percentile the server's `ranked` CTE picks: the row at
 *  `CAST(count * p) + 1` in ascending duration order. */
function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.trunc(sorted.length * fraction)] ?? null
}

function statsOf(turns: DemoTurnRecord[]): MetricsTurnStats {
  const failed = turns.filter((turn) => turn.status !== 'ok').length
  const durations = turns.map((turn) => turn.durationMs).sort((a, b) => a - b)
  return {
    counted: turns.length,
    failed,
    failureRate: turns.length > 0 ? failed / turns.length : 0,
    totalCostUsd: turns.length > 0 ? turns.reduce((total, turn) => total + turn.costUsd, 0) : null,
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: durations.length >= 4 ? percentile(durations, 0.95) : null,
  }
}

function volumeOf(turns: DemoTurnRecord[], from: number, to: number): MetricsTurnVolumeBucket[] {
  const width = (to - from) / TURN_VOLUME_BUCKET_COUNT
  const byIndex = new Map<number, MetricsTurnVolumeBucket>()
  for (const turn of turns) {
    const index = Math.min(TURN_VOLUME_BUCKET_COUNT - 1, Math.trunc((turn.startedAt - from) / width))
    let bucket = byIndex.get(index)
    if (!bucket) {
      bucket = {
        at: from + index * width,
        endAt: from + (index + 1) * width,
        total: 0,
        claudeCode: 0,
        codex: 0,
        unknownProvider: 0,
        costUsd: 0,
        costedCount: 0,
      }
      byIndex.set(index, bucket)
    }
    bucket.total += 1
    // Every recorded turn here ran on Claude Code, which is what the listing's
    // `provider` column states too.
    bucket.claudeCode += 1
    bucket.costUsd += turn.costUsd
    bucket.costedCount += 1
  }
  return [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, bucket]) => bucket)
}

/**
 * The listing the Insights page opens on, paginated and aggregated the way the
 * host's `turnPage` does it: every filter is applied before the page is cut, so
 * the stats and the histogram describe the whole selection rather than the
 * twenty-five rows on screen.
 */
export function turnPageResult(
  turns: DemoTurnRecord[],
  request: MetricsTurnPageRequest,
): MetricsTurnPageResult {
  const { from, to } = request.timeRange
  const scoped = turns.filter((turn) =>
    turn.startedAt >= from
    && turn.startedAt < to
    && (!request.sessionId || turn.sessionId === request.sessionId)
    && (!request.taskId || turn.sessionId === DEMO_SESSION_BY_TASK.get(request.taskId))
    && (!request.search || matchesSearch(turn, request.search)))
  const selected = request.status ? scoped.filter((turn) => turn.status === request.status) : scoped
  const value = SORT_VALUE[request.sort.field]
  const direction = request.sort.dir === 'asc' ? 1 : -1
  const ordered = [...selected].sort((a, b) => {
    const left = value(a)
    const right = value(b)
    if (left === right) return b.startedAt - a.startedAt
    return (left < right ? -1 : 1) * direction
  })
  const lastPage = Math.max(0, Math.ceil(ordered.length / request.pageSize) - 1)
  const pageIndex = Math.min(request.pageIndex, lastPage)
  const offset = pageIndex * request.pageSize
  return {
    page: turnListingResult(ordered.slice(offset, offset + request.pageSize)),
    pageIndex,
    pageSize: request.pageSize,
    totalRows: ordered.length,
    // The status chips count the selection *before* a status filter narrows it,
    // so picking "error" does not empty the chips that offer the way back.
    statusCounts: statusCountsOf(scoped),
    stats: statsOf(selected),
    volume: volumeOf(selected, from, to),
  }
}

/** One turn's span tree. The turn opens with setup, thinks, calls its tools in
 *  order, streams its answer, and settles; the leftover is what the waterfall
 *  reports as unattributed. */
export function demoTurnTrace(turn: DemoTurnRecord): MetricsTurnTrace {
  const span = (
    index: number,
    kind: string,
    name: string,
    startedAt: number,
    durationMs: number,
  ): MetricsSpan => ({
    spanId: `${turn.spanId}-${index}`,
    parentSpanId: turn.spanId,
    traceId: turn.traceId,
    kind,
    name,
    service: 'solus.sessions',
    sessionId: turn.sessionId,
    provider: 'claude',
    model: turn.model,
    projectRoot: DEMO_PROJECT,
    origin: turn.origin,
    startedAt,
    endedAt: startedAt + durationMs,
    durationMs,
    status: 'ok',
    attrs: {},
  })

  const root: MetricsSpan = {
    spanId: turn.spanId,
    parentSpanId: null,
    traceId: turn.traceId,
    kind: 'turn',
    name: 'turn',
    service: 'solus.sessions',
    sessionId: turn.sessionId,
    provider: 'claude',
    model: turn.model,
    projectRoot: DEMO_PROJECT,
    origin: turn.origin,
    startedAt: turn.startedAt,
    endedAt: turn.startedAt + turn.durationMs,
    durationMs: turn.durationMs,
    status: turn.status,
    // Attribute names, not the SQL column names the `turns` view exposes them
    // under: `cost_usd` is `json_extract(attrs, '$.costUsd')`. Child-time sums
    // like `tool_time_ms` are computed from child spans by the view, so they are
    // not attributes at all and the demo's own child spans supply them.
    attrs: {
      prompt: turn.prompt,
      promptSource: turn.promptSource,
      costUsd: turn.costUsd,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      toolCallCount: turn.toolCallCount,
    },
  }

  const setupMs = 1_400
  const thinkingMs = Math.round((turn.durationMs - turn.toolTimeMs - setupMs) * 0.34)
  const settlementMs = 900
  const spans = [root, span(0, 'setup', 'provider startup', turn.startedAt, setupMs)]
  let at = turn.startedAt + setupMs
  spans.push(span(1, 'thinking', 'thinking', at, thinkingMs))
  at += thinkingMs
  turn.tools.forEach(([tool, durationMs], index) => {
    spans.push(span(index + 2, 'tool_call', tool, at, durationMs))
    at += durationMs
  })
  const streamMs = Math.max(0, turn.startedAt + turn.durationMs - settlementMs - at)
  spans.push(span(turn.tools.length + 2, 'response_stream', 'response', at, streamMs))
  at += streamMs
  spans.push(span(turn.tools.length + 3, 'turn_settlement', 'settlement', at, settlementMs))

  return { traceId: turn.traceId, spans, providerWaitMs: 0, gapSegments: [] }
}

export function demoSessionSummary(
  sessionId: string,
  turns: DemoTurnRecord[],
): MetricsSessionSummary {
  const owned = turns
    .filter((turn) => turn.sessionId === sessionId)
    .sort((a, b) => a.startedAt - b.startedAt)
  return {
    sessionId,
    turnCount: owned.length,
    totalDurationMs: owned.reduce((total, turn) => total + turn.durationMs, 0),
    totalCostUsd: owned.length ? owned.reduce((total, turn) => total + turn.costUsd, 0) : null,
    totalInputTokens: owned.reduce((total, turn) => total + turn.inputTokens, 0),
    totalOutputTokens: owned.reduce((total, turn) => total + turn.outputTokens, 0),
    turns: owned.map((turn, index) => ({
      turnNumber: index + 1,
      traceId: turn.traceId,
      prompt: turn.prompt,
      startedAt: turn.startedAt,
      endedAt: turn.startedAt + turn.durationMs,
      durationMs: turn.durationMs,
      status: turn.status,
      model: turn.model,
      origin: turn.origin,
      promptSource: turn.promptSource,
      costUsd: turn.costUsd,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      toolCallCount: turn.toolCallCount,
    })),
  }
}

/** Distinct values the SQL editor offers for a column, so completion is not
 *  empty where the fixture genuinely has values. */
export const DEMO_DISTINCT_VALUES = new Map<string, string[]>([
  ['session_id', [RATELIMIT, WEBHOOKS, BILLING]],
  ['model', [SONNET, OPUS]],
  ['provider', ['claude']],
  ['status', ['ok', 'error', 'interrupted']],
  ['origin', ['chat', 'automation']],
  ['prompt_source', ['user', 'automation']],
  ['project_root', [DEMO_PROJECT]],
  ['kind', ['turn', 'tool_call', 'thinking', 'response_stream', 'setup', 'agent_run']],
  ['tool', ['Bash', 'Read', 'Edit', 'Grep', 'Write']],
  ['service', ['solus.sessions', 'solus.review-guide', 'solus.automations', 'solus.subagents']],
])
