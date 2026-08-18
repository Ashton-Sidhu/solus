import type {
  MetricsQueryResult,
  MetricsSessionSummary,
  MetricsSpan,
  MetricsTurnTrace,
} from '../../../../src/shared/observability-types'
import { TURN_SELECT_COLUMNS } from '../../../../src/renderer/components/insights/lib/insights-queries'
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

const TURN_CELL: Record<(typeof TURN_SELECT_COLUMNS)[number], (turn: DemoTurnRecord) => string | number | null> = {
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
}

/** The turn listing, in the column order the explore query selects. */
export function turnListingResult(turns: DemoTurnRecord[]): MetricsQueryResult {
  return {
    columns: [...TURN_SELECT_COLUMNS],
    rows: turns.map((turn) => TURN_SELECT_COLUMNS.map((column) => TURN_CELL[column](turn))),
    sourceView: 'turns',
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
    attrs: {
      prompt: turn.prompt,
      prompt_source: turn.promptSource,
      cost_usd: turn.costUsd,
      input_tokens: turn.inputTokens,
      output_tokens: turn.outputTokens,
      tool_call_count: turn.toolCallCount,
      tool_time_ms: turn.toolTimeMs,
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

  return { traceId: turn.traceId, spans, unattributedMs: 0, gapSegments: [] }
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
export const DEMO_DISTINCT_VALUES: Record<string, string[]> = {
  session_id: [RATELIMIT, WEBHOOKS, BILLING],
  model: [SONNET, OPUS],
  provider: ['claude'],
  status: ['ok', 'error', 'interrupted'],
  origin: ['chat', 'automation'],
  prompt_source: ['user', 'automation'],
  project_root: [DEMO_PROJECT],
  kind: ['turn', 'tool_call', 'thinking', 'response_stream', 'setup', 'agent_run'],
  tool: ['Bash', 'Read', 'Edit', 'Grep', 'Write'],
  service: ['solus.sessions', 'solus.review-guide', 'solus.automations', 'solus.subagents'],
}
