import type { MetricsQueryResult, MetricsValue } from '../../../../src/shared/observability-types'
import type { DemoTurnRecord } from './insights'
import { DEMO_PROJECT } from './types'

// What the demo can answer, and how it recognizes the question.
//
// The page ships a fixed set of statements — the preset chips and the queries
// the console writes for itself — so each one is matched by the shape that
// makes it distinctive and answered from the recorded turns. Nothing here
// parses SQL in general; a statement that matches nothing is refused rather
// than answered wrongly.

const round2 = (value: number): number => Math.round(value * 100) / 100

/** The window a shipped statement constrains `started_at` to. Both forms the
 *  page emits are read: a relative window is written against the database
 *  clock, an absolute one against two instants. */
export function sqlWindow(sql: string, now: number): { from?: number; to?: number } {
  const relative = sql.match(/started_at\s*>\s*\(strftime\('%s','now'\)\s*\*\s*1000\s*-\s*(\d+)\)/i)
  if (relative) return { from: now - Number(relative[1]) }
  const absolute = sql.match(/started_at\s*>=\s*(\d+)\s+and\s+started_at\s*<\s*(\d+)/i)
  if (absolute) return { from: Number(absolute[1]), to: Number(absolute[2]) }
  return {}
}

/** The session a drill-in statement names, if it names one. */
export function sqlSessionId(sql: string): string | null {
  return sql.match(/session_id\s*=\s*'([^']*)'/i)?.[1] ?? null
}

/** The task a drill-in statement names, if it names one. */
export function sqlTaskId(sql: string): string | null {
  return sql.match(/task_id\s*=\s*'([^']*)'/i)?.[1] ?? null
}

function grouped(
  turns: DemoTurnRecord[],
  key: (turn: DemoTurnRecord) => string,
): Map<string, DemoTurnRecord[]> {
  const groups = new Map<string, DemoTurnRecord[]>()
  for (const turn of turns) {
    const name = key(turn)
    const group = groups.get(name)
    if (group) group.push(turn)
    else groups.set(name, [turn])
  }
  return groups
}

function ranked(
  columns: string[],
  rows: MetricsValue[][],
  sortColumn: number,
): MetricsQueryResult {
  return {
    columns,
    rows: rows.slice().sort((a, b) => Number(b[sortColumn] ?? 0) - Number(a[sortColumn] ?? 0)),
    // No `sourceView`: these are rollups, not a listing at any view's grain.
  }
}

interface DemoAnswer {
  id: string
  /** True when this is the statement being run. */
  matches(sql: string): boolean
  /** True when this is what an NL question is asking for. */
  answers(question: string): boolean
  /** The statement an NL question compiles to. */
  sql: string
  result(turns: DemoTurnRecord[]): MetricsQueryResult
}

const TURN_TIME_BY_MODEL_SQL = [
  'select model,',
  '       count(*) as turns,',
  '       round(avg(duration_ms) / 1000.0, 2) as avg_seconds,',
  '       round(max(duration_ms) / 1000.0, 2) as slowest_seconds',
  'from turns',
  'group by model',
  'order by turns desc',
].join('\n')

const SPEND_BY_MODEL_SQL = [
  'select model,',
  '       count(*) as turns,',
  '       round(sum(cost_usd), 2) as spend_usd',
  'from turns',
  'where cost_usd is not null',
  'group by model',
  'order by spend_usd desc',
].join('\n')

const PERMISSION_WAIT_SQL = [
  'select model,',
  '       count(*) as waits,',
  '       round(sum(duration_ms) / 1000.0, 2) as total_seconds',
  'from events',
  "where kind = 'permission_wait'",
  'group by model',
  'order by total_seconds desc',
].join('\n')

/** Rollups the demo has no spans behind — Solus's own background work is not
 *  part of the recorded conversation set, so these tables are stated outright. */
const WHERE_TIME_GOES: MetricsQueryResult = {
  columns: ['kind', 'events', 'total_seconds'],
  rows: [
    ['tool_call', 84, 1_642.3],
    ['thinking', 24, 706.8],
    ['response_stream', 24, 318.4],
    ['setup', 24, 33.6],
    ['permission_wait', 6, 27.9],
    ['turn_settlement', 24, 21.6],
  ],
}

const AGENT_SPEND_BY_SERVICE: MetricsQueryResult = {
  columns: ['service', 'runs', 'avg_seconds', 'total_seconds'],
  rows: [
    ['solus.review-guide', 6, 41.2, 247.2],
    ['solus.automations', 11, 18.7, 205.7],
    ['solus.subagents', 4, 33.5, 134.0],
    ['solus.text-generation', 19, 2.4, 45.6],
  ],
}

const PERMISSION_WAITS: MetricsQueryResult = {
  columns: ['model', 'waits', 'total_seconds'],
  rows: [
    ['claude-sonnet-5', 4, 19.4],
    ['claude-opus-4-8', 2, 8.5],
  ],
}

export const DEMO_ANSWERS: DemoAnswer[] = [
  {
    id: 'tool-time-by-model',
    matches: (sql) => /tool_time_ms/i.test(sql) && /group by model/i.test(sql),
    answers: () => false,
    sql: '',
    result: (turns) =>
      ranked(['model', 'turns', 'avg_tool_seconds', 'total_tool_seconds'],
        [...grouped(turns, (turn) => turn.model)].map(([model, rows]) => {
          const total = rows.reduce((sum, turn) => sum + turn.toolTimeMs, 0)
          return [model, rows.length, round2(total / rows.length / 1000), round2(total / 1000)]
        }), 3),
  },
  {
    id: 'spend-by-model',
    matches: (sql) => /sum\(cost_usd\)/i.test(sql) && /group by model/i.test(sql),
    answers: (question) => /cost|spend|money|\$/i.test(question) && /model/i.test(question),
    sql: SPEND_BY_MODEL_SQL,
    result: (turns) =>
      ranked(['model', 'turns', 'spend_usd'],
        [...grouped(turns, (turn) => turn.model)].map(([model, rows]) => [
          model,
          rows.length,
          round2(rows.reduce((sum, turn) => sum + turn.costUsd, 0)),
        ]), 2),
  },
  {
    id: 'turn-time-by-model',
    matches: (sql) => /avg\(duration_ms\)/i.test(sql) && /group by model/i.test(sql),
    answers: (question) => /slow|long|duration|time/i.test(question) && !/permission/i.test(question),
    sql: TURN_TIME_BY_MODEL_SQL,
    result: (turns) =>
      ranked(['model', 'turns', 'avg_seconds', 'slowest_seconds'],
        [...grouped(turns, (turn) => turn.model)].map(([model, rows]) => [
          model,
          rows.length,
          round2(rows.reduce((sum, turn) => sum + turn.durationMs, 0) / rows.length / 1000),
          round2(Math.max(...rows.map((turn) => turn.durationMs)) / 1000),
        ]), 1),
  },
  {
    id: 'cost-by-project',
    matches: (sql) => /group by project_root/i.test(sql),
    answers: () => false,
    sql: '',
    result: (turns) => ({
      columns: ['project_root', 'turns', 'spend_usd'],
      rows: [[DEMO_PROJECT, turns.length, round2(turns.reduce((sum, turn) => sum + turn.costUsd, 0))]],
    }),
  },
  {
    id: 'slowest-tools',
    matches: (sql) => /group by tool/i.test(sql),
    answers: () => false,
    sql: '',
    result: (turns) => {
      const byTool = new Map<string, { calls: number; totalMs: number }>()
      for (const turn of turns) {
        for (const [tool, durationMs] of turn.tools) {
          const entry = byTool.get(tool) ?? { calls: 0, totalMs: 0 }
          entry.calls += 1
          entry.totalMs += durationMs
          byTool.set(tool, entry)
        }
      }
      return ranked(['tool', 'calls', 'avg_seconds', 'total_seconds'],
        [...byTool].map(([tool, { calls, totalMs }]) => [
          tool,
          calls,
          round2(totalMs / calls / 1000),
          round2(totalMs / 1000),
        ]), 3)
    },
  },
  {
    id: 'where-time-goes',
    matches: (sql) => /group by kind/i.test(sql),
    answers: () => false,
    sql: '',
    result: () => WHERE_TIME_GOES,
  },
  {
    id: 'agent-spend-by-service',
    matches: (sql) => /group by service/i.test(sql),
    answers: () => false,
    sql: '',
    result: () => AGENT_SPEND_BY_SERVICE,
  },
  {
    id: 'permission-waits',
    matches: (sql) => /permission_wait/i.test(sql),
    answers: (question) => /permission/i.test(question),
    sql: PERMISSION_WAIT_SQL,
    result: () => PERMISSION_WAITS,
  },
]

export function answerFor(sql: string): DemoAnswer | null {
  return DEMO_ANSWERS.find((answer) => answer.matches(sql)) ?? null
}

export function compiledSqlFor(question: string): string {
  return DEMO_ANSWERS.find((answer) => answer.answers(question))?.sql ?? TURN_TIME_BY_MODEL_SQL
}
