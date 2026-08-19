import type { MetricsQuerySpec } from '@solus/contracts/observability-types'
import { rangeCondition, type ResolvedRange, type TimeRange } from './time-range'

// Shipped queries and the canonical explore query.
//
// A preset is a QuerySpec or SQL shipped in code and shown as a one-click chip;
// it is never a database row. A saved query is the user's, lives in solus.db,
// and arrives through the store.
//
// Every statement written here is a function of the selected time range. A
// preset that kept its own baked window would answer a different question from
// the histogram above it, which is the one thing a time filter must never
// allow.

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

/** The query the explore page runs when nothing else is asked for, and the
 *  text the SQL editor opens with, so what runs is always what is shown. */
export function defaultExploreSql(range: TimeRange): string {
  return [
    `select ${TURN_SELECT_COLUMNS.join(', ')}`,
    'from turns',
    `where ${rangeCondition(range)}`,
    'order by started_at desc',
    `limit ${EXPLORE_ROW_LIMIT}`,
  ].join('\n')
}

export function sessionTurnsSql(sessionId: string, range: TimeRange): string {
  return [
    `select ${TURN_SELECT_COLUMNS.join(', ')}`,
    'from turns',
    `where session_id = '${sessionId.replace(/'/g, "''")}'`,
    `  and ${rangeCondition(range)}`,
    'order by started_at desc',
    `limit ${EXPLORE_ROW_LIMIT}`,
  ].join('\n')
}

/** Every turn a task's work produced, across every session that ran it — the
 *  task is the unit of work, and one task is often several attempts. */
export function taskTurnsSql(taskId: string, range: TimeRange): string {
  return [
    `select ${TURN_SELECT_COLUMNS.join(', ')}`,
    'from turns',
    `where task_id = '${taskId.replace(/'/g, "''")}'`,
    `  and ${rangeCondition(range)}`,
    'order by started_at desc',
    `limit ${EXPLORE_ROW_LIMIT}`,
  ].join('\n')
}

/** The histogram's own query: turn volume split by provider. Independent
 *  of whatever the user is asking, because it is the context the answer sits
 *  in — narrowing it with the question would flatten the shape being explained. */
export function turnVolumeSpec(window: ResolvedRange): MetricsQuerySpec {
  return {
    timeRange: { from: window.from, to: window.to },
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
}

/** The default view's preset pack — the session namespace only, plus agent
 *  spend by service, which names internal services because it is the user's
 *  money. */
export function sqlPresets(range: TimeRange): InsightsPreset[] {
  const within = rangeCondition(range)
  return [
    {
      id: 'turn-time-by-model',
      label: 'Turn time by model',
      description: 'Average and slowest turn duration for each model in the selected range',
      form: 'sql',
      text: [
        'select model,',
        '       count(*) as turns,',
        '       round(avg(duration_ms) / 1000.0, 2) as avg_seconds,',
        '       round(max(duration_ms) / 1000.0, 2) as slowest_seconds',
        'from turns',
        `where ${within} and duration_ms is not null`,
        'group by model',
        'order by turns desc',
      ].join('\n'),
    },
    {
      id: 'where-time-goes',
      label: 'Where time goes',
      description: 'Duration share by event kind across the selected range',
      form: 'sql',
      text: [
        'select kind,',
        '       count(*) as events,',
        '       round(sum(duration_ms) / 1000.0, 2) as total_seconds',
        'from events',
        `where ${within}`,
        'group by kind',
        'order by total_seconds desc',
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
        '       round(avg(duration_ms) / 1000.0, 2) as avg_seconds,',
        '       round(sum(duration_ms) / 1000.0, 2) as total_seconds',
        'from events',
        `where ${within} and kind = 'tool_call'`,
        'group by tool',
        'order by total_seconds desc',
      ].join('\n'),
    },
    {
      id: 'tool-time-by-model',
      label: 'Tool time by model',
      description:
        'Time each model spends in tools — read straight off turns, no join needed',
      form: 'sql',
      // Was the one join preset. tool_time_ms is pre-summed on turns now, so
      // the same question is a plain GROUP BY — and its result stays a rollup
      // grid because it aggregates, exactly as before.
      text: [
        'select model,',
        '       count(*) as turns,',
        '       round(avg(tool_time_ms) / 1000.0, 2) as avg_tool_seconds,',
        '       round(sum(tool_time_ms) / 1000.0, 2) as total_tool_seconds',
        'from turns',
        `where ${within} and tool_time_ms is not null`,
        'group by model',
        'order by total_tool_seconds desc',
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
        `where ${within} and cost_usd is not null`,
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
        '       round(avg(duration_ms) / 1000.0, 2) as avg_seconds,',
        '       round(sum(duration_ms) / 1000.0, 2) as total_seconds',
        'from events',
        `where ${within} and kind = 'agent_run'`,
        'group by service',
        'order by total_seconds desc',
      ].join('\n'),
    },
  ]
}

/** Shipped questions for the natural-language tab. They exist to show the shape
 *  of a question that compiles well, not to hide the SQL — the compiled query
 *  always lands in the editor. A question names no period: the selected range
 *  is what the compile is told to constrain to. */
export const NL_PRESETS: InsightsPreset[] = [
  {
    id: 'nl-slowest',
    label: 'Slowest turns',
    description: 'Which turns took longest?',
    form: 'nl',
    text: 'Which turns took the longest?',
  },
  {
    id: 'nl-spend',
    label: 'Spend by model',
    description: 'How much did each model cost?',
    form: 'nl',
    text: 'How much did each model cost?',
  },
  {
    id: 'nl-waiting',
    label: 'Time waiting on me',
    description: 'How long did turns spend waiting for a permission decision?',
    form: 'nl',
    text: 'How much time did turns spend waiting on permission decisions?',
  },
]

export function presetsFor(
  form: 'sql' | 'nl',
  range: TimeRange,
): InsightsPreset[] {
  return form === 'sql' ? sqlPresets(range) : NL_PRESETS
}

/**
 * A statement Solus wrote, named by what it asks rather than by its text.
 *
 * Changing the range must rewrite these — they are the surface's own queries —
 * while leaving SQL the user typed or saved exactly as written. Keeping the
 * description rather than the string is what makes that distinction possible.
 */
export type GeneratedQuery =
  | { kind: 'explore' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'preset'; presetId: string }

/** Re-emits a generated statement at the given range. Returns null when a
 *  preset id no longer exists, so a stale descriptor cannot blank the editor. */
export function generatedSql(query: GeneratedQuery, range: TimeRange): string | null {
  if (query.kind === 'explore') return defaultExploreSql(range)
  if (query.kind === 'session') return sessionTurnsSql(query.sessionId, range)
  if (query.kind === 'task') return taskTurnsSql(query.taskId, range)
  return sqlPresets(range).find((preset) => preset.id === query.presetId)?.text ?? null
}
