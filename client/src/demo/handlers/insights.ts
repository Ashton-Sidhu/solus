import type {
  MetricsQueryResult,
  MetricsQuerySpec,
  SavedMetricsQuery,
} from '../../../../src/shared/observability-types'
// The field registry is pure data and pure functions — no Node, no database —
// and it is the one description of the schema. The schema sheet in the demo
// reads the real one rather than a hand-copied summary that would drift.
import { metricsSchema } from '../../../../src/main/observability/field-registry'
import {
  DEMO_DISTINCT_VALUES,
  demoSessionSummary,
  demoTurnRecords,
  demoTurnTrace,
  turnListingResult,
  DEMO_SESSION_BY_TASK,
  type DemoTurnRecord,
} from '../fixtures/insights'
import { answerFor, compiledSqlFor, sqlSessionId, sqlTaskId, sqlWindow } from '../fixtures/insights-answers'
import type { DemoServer } from '../fixtures/types'

/**
 * Insights, served from a fixed set of recorded turns.
 *
 * The real page compiles every question to SQL and runs it against the host's
 * `metrics.db`. The demo has neither, so it answers the queries the surface
 * itself ships — the histogram's spec, the explore listing, a session drill-in,
 * and each preset chip — from `fixtures/insights.ts`, and says plainly that a
 * hand-written statement cannot run here rather than returning an empty grid
 * that reads as "you have no data".
 */
export function registerInsightsHandlers(backend: DemoServer): void {
  // One placement per page load, so the histogram, the listing, and every
  // waterfall behind them describe the same instants.
  const turns = demoTurnRecords(Date.now())
  const savedQueries: SavedMetricsQuery[] = []

  const within = (window: { from?: number; to?: number }): DemoTurnRecord[] =>
    turns.filter((turn) =>
      (window.from === undefined || turn.startedAt >= window.from)
      && (window.to === undefined || turn.startedAt < window.to))

  backend.register('metricsSchema', () => metricsSchema())
  backend.register('metricsDistinctValues', (args) => DEMO_DISTINCT_VALUES[args[0] as string] ?? [])
  backend.register('metricsListSavedQueries', () => savedQueries)
  backend.register('metricsSaveQuery', (args) => {
    const query = args[0] as SavedMetricsQuery
    const index = savedQueries.findIndex((saved) => saved.id === query.id)
    if (index === -1) savedQueries.unshift(query)
    else savedQueries[index] = query
    return savedQueries
  })
  backend.register('metricsDeleteQuery', (args) => {
    const index = savedQueries.findIndex((saved) => saved.id === args[0])
    if (index !== -1) savedQueries.splice(index, 1)
    return savedQueries
  })

  backend.register('metricsQuery', (args): MetricsQueryResult => {
    const spec = args[0] as MetricsQuerySpec
    return turnListingResult(within(spec.timeRange ?? {}))
  })

  // Anything else the page runs is a turn listing: the explore statement and
  // the session and task drill-ins all select from `turns`.
  const isTurnListing = (sql: string): boolean => /\bfrom\s+turns\b/i.test(sql)
  const canRun = (sql: string): boolean => !!answerFor(sql) || isTurnListing(sql)

  backend.register('metricsRunSql', (args): MetricsQueryResult => {
    const sql = args[0] as string
    const window = sqlWindow(sql, Date.now())
    const answer = answerFor(sql)
    if (answer) return answer.result(within(window))
    if (!isTurnListing(sql)) {
      throw new Error(
        'The demo answers the queries this page ships. Run Solus on your own machine to ask it anything else.',
      )
    }
    const sessionId = sqlSessionId(sql)
    const taskId = sqlTaskId(sql)
    const listed = within(window)
    // A task's turns are the turns of the sessions that worked it. A task the
    // fixture does not know lists nothing, which is the truth here — answering
    // it with every turn would be worse than answering it with none.
    if (sessionId !== null) return turnListingResult(listed.filter((turn) => turn.sessionId === sessionId))
    if (taskId !== null) {
      return turnListingResult(listed.filter((turn) => turn.sessionId === DEMO_SESSION_BY_TASK[taskId]))
    }
    return turnListingResult(listed)
  })

  backend.register('metricsValidateSql', (args) =>
    canRun(args[0] as string)
      ? { ok: true, columns: [] }
      : { ok: false, error: 'Only the queries this page ships can run in the demo.' })

  backend.register('metricsCompileNl', (args) => ({
    sql: compiledSqlFor(args[1] as string),
    ok: true,
    attempts: 1,
  }))

  backend.register('metricsTurnTrace', (args) => {
    const turn = turns.find((candidate) => candidate.traceId === args[0])
    if (!turn) throw new Error(`No recorded trace: ${String(args[0])}`)
    return demoTurnTrace(turn)
  })
  backend.register('metricsSessionSummary', (args) => demoSessionSummary(args[0] as string, turns))
}
