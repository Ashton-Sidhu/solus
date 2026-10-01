import { TextGenerator } from '../../execution/agents/text-generator'
import type { SessionRuntime } from '../../execution/session-runtime'
import { productionLogFilePath } from '../../logger'
import { metricsSchema } from '../../data/insights/field-registry'
import { compileNlToSql, nlCompileSystemPrompt } from '../../data/insights/nl-compile'
import { compileQuerySpec } from '../../data/insights/query-compiler'
import { SPAN_SERVICES } from '../../data/insights/registries'
import { sessionSummary, turnTrace } from '../../data/insights/rollups'
import {
  deleteSavedMetricsQuery,
  listSavedMetricsQueries,
  saveMetricsQuery,
} from '../../data/insights/saved-queries'
import { runCompiledSql, runGuardedSql, validateMetricsSql } from '../../data/insights/sql-guard'
import { solusDir } from '../../platform/paths'
import type { InsightPull } from '../../sync/insight-pull'
import { createLogger } from '../../logger'
import { clearTurnFlag, listTurnFlags, setTurnFlag } from '../../data/insights/turn-flags'
import { turnPage, turnListingSummary } from '../../data/insights/turn-page'
import type { SolusServer } from '../server'

/** Registered low-cardinality columns `metricsDistinctValues` may enumerate.
 *  `tool` scopes to tool_call spans so unrelated span names never pollute it. */
const DISTINCT_COLUMNS = {
  tool: "SELECT DISTINCT name AS value FROM spans WHERE kind = 'tool_call' ORDER BY name LIMIT 200",
  model: 'SELECT DISTINCT model AS value FROM spans WHERE model IS NOT NULL ORDER BY model LIMIT 200',
  provider: 'SELECT DISTINCT provider AS value FROM spans WHERE provider IS NOT NULL ORDER BY provider LIMIT 200',
  status: 'SELECT DISTINCT status AS value FROM spans ORDER BY status LIMIT 200',
  service: 'SELECT DISTINCT service AS value FROM spans ORDER BY service LIMIT 200',
  kind: 'SELECT DISTINCT kind AS value FROM spans ORDER BY kind LIMIT 200',
  origin: 'SELECT DISTINCT origin AS value FROM spans WHERE origin IS NOT NULL ORDER BY origin LIMIT 200',
  user_email: 'SELECT DISTINCT user_email AS value FROM spans WHERE user_email IS NOT NULL ORDER BY user_email LIMIT 200',
  organization_id: 'SELECT DISTINCT organization_id AS value FROM spans WHERE organization_id IS NOT NULL ORDER BY organization_id LIMIT 200',
} as const

function distinctValuesSql(column: string): string | undefined {
  if (!Object.hasOwn(DISTINCT_COLUMNS, column)) return undefined
  // SAFETY: the guard above accepted only keys `DISTINCT_COLUMNS` declares.
  return DISTINCT_COLUMNS[column as keyof typeof DISTINCT_COLUMNS]
}

const NL_TIMEOUT_MS = 60_000
const log = createLogger('main', 'observability-handlers')

export function registerObservabilityHandlers(server: SolusServer, deps: {
  sessionRuntime: SessionRuntime
  /** Pulls the person's turns from other hosts; null while this host is not linked. */
  insightPull: () => InsightPull | null
}): void {
  const textGenerator = new TextGenerator(deps.sessionRuntime)

  server.register('metricsQuery', (args) => {
    const [spec] = args
    const compiled = compileQuerySpec(spec)
    return runCompiledSql(compiled.sql, compiled.params, compiled.sourceView)
  })

  server.register('metricsRunSql', (args) => {
    const [sql] = args
    if (!sql.trim()) throw new Error('metricsRunSql requires SQL text')
    return runGuardedSql(sql)
  })

  // A list read starts a pull and answers from what is here; the turns it
  // writes arrive as `metrics.turnsChanged`, as a turn this host runs does.
  server.register('metricsTurnPage', (args) => {
    const [request] = args
    void deps.insightPull()?.request()
    return turnPage(request)
  })

  server.register('metricsTurnListingSummary', (args) => {
    const [filter] = args
    const pull = deps.insightPull()
    void pull?.request()
    return { ...turnListingSummary(filter), pull: pull?.state() ?? null }
  })

  server.register('metricsValidateSql', (args) => {
    const [sql] = args
    return validateMetricsSql(sql)
  })

  server.register('metricsCompileNl', async (args, handlerCtx) => {
    const [ctx, question] = args
    if (!question.trim()) {
      throw new Error('metricsCompileNl requires a question')
    }
    const cwd = ctx.session.workingDirectory && ctx.session.workingDirectory !== '~'
      ? ctx.session.workingDirectory
      : solusDir()
    const provider = ctx.session.provider ?? ctx.settings.activeAgent
    // The question runs on the caller's own provider login, as their turns do.
    const seat = await deps.sessionRuntime.seatForTurn(handlerCtx.actor, provider) ?? undefined
    return compileNlToSql(question, {
      generate: (prompt) => textGenerator.generate({
        provider,
        model: ctx.statusBar.model,
        seat,
        cwd,
        prompt,
        systemPrompt: nlCompileSystemPrompt(),
        service: SPAN_SERVICES.insights,
        disableReasoning: true,
        unattended: true,
        maxTurns: 1,
        timeoutMs: NL_TIMEOUT_MS,
      }),
      validate: validateMetricsSql,
    })
  })

  server.register('metricsSchema', () => metricsSchema())

  server.register('metricsDistinctValues', (args) => {
    const [columnName] = args
    const sql = distinctValuesSql(columnName)
    if (!sql) throw new Error(`metricsDistinctValues does not serve column: ${columnName}`)
    return runCompiledSql(sql, []).rows.map((row) => row[0])
  })

  server.register('metricsListSavedQueries', () => listSavedMetricsQueries())

  server.register('metricsSaveQuery', (args) => {
    const [query] = args
    return saveMetricsQuery(query)
  })

  server.register('metricsDeleteQuery', (args) => {
    const [id] = args
    if (!id.trim()) throw new Error('metricsDeleteQuery requires an id')
    return deleteSavedMetricsQuery(id)
  })

  server.register('metricsSessionSummary', (args) => {
    const [sessionId] = args
    if (!sessionId.trim()) {
      throw new Error('metricsSessionSummary requires a session id')
    }
    return sessionSummary(sessionId)
  })

  server.register('metricsTurnTrace', async (args) => {
    const [traceId] = args
    if (!traceId.trim()) {
      throw new Error('metricsTurnTrace requires a trace id')
    }
    // A turn another host ran holds only its row until it is opened.
    try {
      await deps.insightPull()?.fetchTree(traceId)
    } catch (error) {
      log.warn('insight_tree_pull_failed', { traceId, error: error instanceof Error ? error.message : String(error) })
    }
    return turnTrace(traceId)
  })

  server.register('metricsListTurnFlags', () => listTurnFlags())

  server.register('metricsSetTurnFlag', (args) => {
    const [flag] = args
    return setTurnFlag(flag)
  })

  server.register('metricsClearTurnFlag', (args) => {
    const [traceId] = args
    if (!traceId.trim()) throw new Error('metricsClearTurnFlag requires a trace id')
    return clearTurnFlag(traceId)
  })

  server.register('logFilePath', () => productionLogFilePath())
}
