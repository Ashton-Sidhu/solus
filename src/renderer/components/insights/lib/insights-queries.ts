import type { MetricsQuerySpec } from '../../../../shared/observability-types'

// Shipped queries and the canonical explore query.
//
// A preset is a QuerySpec or SQL shipped in code and shown as a one-click chip;
// it is never a database row. A saved query is the user's, lives in solus.db,
// and arrives through the store.

/** Milliseconds the explore surface looks back by default. */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000

/** Rows the explore list asks for. The guarded executor caps this again. */
export const EXPLORE_ROW_LIMIT = 500

/**
 * The turn columns the explore list renders. Selected by name so the list keeps
 * working when a saved query returns the same shape, and so an attr promoted to
 * a real column later does not change the client.
 */
export const TURN_SELECT_COLUMNS = [
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

/** SQLite has no `now()`; epoch milliseconds are what `started_at` stores. */
export function sinceExpression(windowMs: number): string {
  return `(strftime('%s','now') * 1000 - ${Math.round(windowMs)})`
}

/** The query the explore page runs when nothing else is asked for, and the
 *  text the SQL editor opens with, so what runs is always what is shown. */
export function defaultExploreSql(windowMs: number = DEFAULT_WINDOW_MS): string {
  return [
    `select ${TURN_SELECT_COLUMNS.join(', ')}`,
    'from turns',
    `where started_at > ${sinceExpression(windowMs)}`,
    'order by started_at desc',
    `limit ${EXPLORE_ROW_LIMIT}`,
  ].join('\n')
}

export function sessionTurnsSql(sessionId: string, windowMs: number = DEFAULT_WINDOW_MS): string {
  return [
    `select ${TURN_SELECT_COLUMNS.join(', ')}`,
    'from turns',
    `where session_id = '${sessionId.replace(/'/g, "''")}'`,
    `  and started_at > ${sinceExpression(windowMs)}`,
    'order by started_at desc',
    `limit ${EXPLORE_ROW_LIMIT}`,
  ].join('\n')
}

/** The histogram's own query: turn volume and failures per bucket. Independent
 *  of whatever the user is asking, because it is the context the answer sits
 *  in — narrowing it with the question would flatten the shape being explained. */
export function turnVolumeSpec(windowMs: number = DEFAULT_WINDOW_MS): MetricsQuerySpec {
  return {
    timeRange: { from: Date.now() - windowMs },
    filters: [{ field: 'kind', op: 'eq', value: 'turn' }],
    limit: EXPLORE_ROW_LIMIT,
    orderBy: [{ field: 'started_at', dir: 'desc' }],
  }
}

export interface InsightsPreset {
  id: string
  label: string
  /** What the chip means, shown on hover and in the mobile preset list. */
  description: string
  form: 'sql' | 'nl'
  text: string
  /** Presets naming `internal.*` kinds appear only with the internals toggle on. */
  internal?: boolean
}

const since24h = sinceExpression(DEFAULT_WINDOW_MS)
const since7d = sinceExpression(7 * DEFAULT_WINDOW_MS)

/** The default view's preset pack — the session namespace only, plus agent
 *  spend by service, which names internal services because it is the user's
 *  money. */
export const SQL_PRESETS: InsightsPreset[] = [
  {
    id: 'turn-time-by-model',
    label: 'Turn time by model',
    description: 'Median and p95 turn duration for each model over the last 7 days',
    form: 'sql',
    text: [
      'select model,',
      '       count(*) as turns,',
      '       cast(avg(duration_ms) as int) as avg_ms,',
      '       max(duration_ms) as slowest_ms',
      'from turns',
      `where started_at > ${since7d} and duration_ms is not null`,
      'group by model',
      'order by turns desc',
    ].join('\n'),
  },
  {
    id: 'where-time-goes',
    label: 'Where time goes',
    description: 'Duration share by child span kind across the last 24 hours',
    form: 'sql',
    text: [
      'select kind,',
      '       count(*) as spans,',
      '       sum(duration_ms) as total_ms',
      'from spans',
      `where started_at > ${since24h}`,
      "  and kind not like 'internal.%' and kind != 'turn'",
      'group by kind',
      'order by total_ms desc',
    ].join('\n'),
  },
  {
    id: 'slowest-tools',
    label: 'Slowest tools',
    description: 'Tools ranked by total time spent, with call counts',
    form: 'sql',
    text: [
      'select tool,',
      '       count(*) as calls,',
      '       cast(avg(duration_ms) as int) as avg_ms,',
      '       sum(duration_ms) as total_ms',
      'from tool_calls',
      `where started_at > ${since7d}`,
      'group by tool',
      'order by total_ms desc',
    ].join('\n'),
  },
  {
    id: 'tool-failure-rate',
    label: 'Tool failure rate',
    description: 'Share of each tool’s calls that ended in error',
    form: 'sql',
    text: [
      'select tool,',
      '       count(*) as calls,',
      "       sum(case when status = 'error' then 1 else 0 end) as errors,",
      "       round(100.0 * sum(case when status = 'error' then 1 else 0 end) / count(*), 1) as error_pct",
      'from tool_calls',
      `where started_at > ${since7d}`,
      'group by tool',
      'having calls > 2',
      'order by error_pct desc',
    ].join('\n'),
  },
  {
    id: 'build-latency',
    label: 'Build latency',
    description: 'Duration of every Bash call whose command mentions build',
    form: 'sql',
    // span_id and trace_id ride along unrendered so each row can open its
    // turn's waterfall on that span.
    text: [
      'select span_id, trace_id, started_at, session_id, command, duration_ms, exit_code',
      'from tool_calls',
      `where started_at > ${since7d}`,
      "  and command like '%build%'",
      'order by duration_ms desc',
    ].join('\n'),
  },
  {
    id: 'cost-by-project',
    label: 'Cost by project',
    description: 'Measured spend per project directory (Codex reports none)',
    form: 'sql',
    text: [
      'select project_root,',
      '       count(*) as turns,',
      '       round(sum(cost_usd), 2) as spend_usd',
      'from turns',
      `where started_at > ${since7d} and cost_usd is not null`,
      'group by project_root',
      'order by spend_usd desc',
    ].join('\n'),
  },
  {
    id: 'agent-spend-by-service',
    label: 'Agent spend by service',
    description: 'Ephemeral agent runs by owning subsystem — where the background spend goes',
    form: 'sql',
    text: [
      'select service,',
      '       count(*) as runs,',
      '       cast(avg(duration_ms) as int) as avg_ms,',
      '       sum(duration_ms) as total_ms',
      'from agent_runs',
      `where started_at > ${since7d}`,
      'group by service',
      'order by total_ms desc',
    ].join('\n'),
  },
  {
    id: 'automation-health',
    label: 'Automation health',
    description: 'Turns dispatched by automations and how they ended',
    form: 'sql',
    text: [
      'select automation_id,',
      '       count(*) as turns,',
      "       sum(case when status = 'ok' then 1 else 0 end) as ok,",
      "       sum(case when status = 'error' then 1 else 0 end) as errors,",
      '       cast(avg(duration_ms) as int) as avg_ms',
      'from turns',
      `where started_at > ${since7d} and automation_id is not null`,
      'group by automation_id',
      'order by turns desc',
    ].join('\n'),
  },
  {
    id: 'rpc-p95',
    label: 'RPC latency',
    description: 'Slowest Solus RPC methods by average handling time',
    form: 'sql',
    internal: true,
    text: [
      'select name as method,',
      '       count(*) as calls,',
      '       cast(avg(duration_ms) as int) as avg_ms,',
      '       max(duration_ms) as slowest_ms',
      'from internal_rpc',
      `where started_at > ${since24h}`,
      'group by name',
      'order by avg_ms desc',
    ].join('\n'),
  },
  {
    id: 'worktree-ops',
    label: 'Worktree ops',
    description: 'Git worktree operations and how long they took',
    form: 'sql',
    internal: true,
    text: [
      'select name as operation, count(*) as ops, cast(avg(duration_ms) as int) as avg_ms',
      'from internal_worktree_ops',
      `where started_at > ${since7d}`,
      'group by name',
      'order by avg_ms desc',
    ].join('\n'),
  },
]

/** Shipped questions for the natural-language tab. They exist to show the shape
 *  of a question that compiles well, not to hide the SQL — the compiled query
 *  always lands in the editor. */
export const NL_PRESETS: InsightsPreset[] = [
  {
    id: 'nl-slowest',
    label: 'Slowest turns',
    description: 'Which turns took longest in the last day?',
    form: 'nl',
    text: 'Which turns took the longest in the last 24 hours?',
  },
  {
    id: 'nl-spend',
    label: 'Spend by model',
    description: 'How much did each model cost today?',
    form: 'nl',
    text: 'How much did each model cost today?',
  },
  {
    id: 'nl-denied',
    label: 'Denied permissions',
    description: 'Which tool permissions did I deny this week?',
    form: 'nl',
    text: 'Which tool permission requests were denied this week, and for which tools?',
  },
  {
    id: 'nl-waiting',
    label: 'Time waiting on me',
    description: 'How long did turns spend waiting for a permission decision?',
    form: 'nl',
    text: 'How much time did turns spend waiting on permission decisions this week?',
  },
]

export function presetsFor(form: 'sql' | 'nl', showInternals: boolean): InsightsPreset[] {
  const all = form === 'sql' ? SQL_PRESETS : NL_PRESETS
  return showInternals ? all : all.filter((preset) => !preset.internal)
}
