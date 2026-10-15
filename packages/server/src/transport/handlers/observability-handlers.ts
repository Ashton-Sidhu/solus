import { TextGenerator } from '../../execution/agents/text-generator'
import { contextPreferences } from '../../execution/agents/run-input'
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
import { traceVisible, visibleInsights, type InsightFilter } from '../../data/insights/visibility'
import type { SolusServer } from '../server'
import { RpcAccessError } from '../../admission/access-policy'

/** Registered low-cardinality columns `metricsDistinctValues` may enumerate,
 *  with the condition each reads under. `tool` scopes to tool_call spans so
 *  unrelated span names never pollute it. */
const DISTINCT_COLUMNS = {
  tool: { expression: 'name', where: "kind = 'tool_call'" },
  model: { expression: 'model', where: 'model IS NOT NULL' },
  provider: { expression: 'provider', where: 'provider IS NOT NULL' },
  status: { expression: 'status', where: '1 = 1' },
  service: { expression: 'service', where: '1 = 1' },
  kind: { expression: 'kind', where: '1 = 1' },
  origin: { expression: 'origin', where: 'origin IS NOT NULL' },
  user_email: { expression: 'user_email', where: 'user_email IS NOT NULL' },
  organization_id: { expression: 'organization_id', where: 'organization_id IS NOT NULL' },
} as const

/** The distinct values of a registered column among the spans the reader may see. */
function distinctValuesSql(column: string, visible: InsightFilter): InsightFilter | undefined {
  if (!Object.hasOwn(DISTINCT_COLUMNS, column)) return undefined
  // SAFETY: the guard above accepted only keys `DISTINCT_COLUMNS` declares.
  const { expression, where } = DISTINCT_COLUMNS[column as keyof typeof DISTINCT_COLUMNS]
  return {
    sql: `SELECT DISTINCT ${expression} AS value FROM spans WHERE ${where} AND (${visible.sql}) ORDER BY ${expression} LIMIT 200`,
    params: visible.params,
  }
}

const NL_TIMEOUT_MS = 60_000
const log = createLogger('main', 'observability-handlers')

export function registerObservabilityHandlers(server: SolusServer, deps: {
  sessionRuntime: SessionRuntime
  /** Pulls the person's turns from other hosts; null while this host is not linked. */
  insightPull: () => InsightPull | null
}): void {
  const textGenerator = new TextGenerator(deps.sessionRuntime)

  // Insights reads hold the reader's own turns, or every turn for a host
  // administrator (docs/plans/access-model.md §4 D2). Arbitrary SQL cannot be held
  // to that, so `metricsRunSql` is an administrator's (`host.admin`).
  server.register('metricsQuery', (args, ctx) => {
    const [spec] = args
    const compiled = compileQuerySpec(spec, visibleInsights(ctx.actor))
    return runCompiledSql(compiled.sql, compiled.params, compiled.sourceView)
  })

  server.register('metricsRunSql', (args) => {
    const [sql] = args
    if (!sql.trim()) throw new Error('metricsRunSql requires SQL text')
    return runGuardedSql(sql)
  })

  // A list read starts a pull and answers from what is here; the turns it
  // writes arrive as `metrics.turnsChanged`, as a turn this host runs does.
  server.register('metricsTurnPage', (args, ctx) => {
    const [request] = args
    void deps.insightPull()?.request()
    return turnPage(request, visibleInsights(ctx.actor))
  })

  server.register('metricsTurnListingSummary', (args, ctx) => {
    const [filter] = args
    const pull = deps.insightPull()
    void pull?.request()
    return { ...turnListingSummary(filter, visibleInsights(ctx.actor)), pull: pull?.state() ?? null }
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
        executionPreferences: contextPreferences(ctx),
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

  server.register('metricsDistinctValues', (args, ctx) => {
    const [columnName] = args
    const query = distinctValuesSql(columnName, visibleInsights(ctx.actor))
    if (!query) throw new Error(`metricsDistinctValues does not serve column: ${columnName}`)
    return runCompiledSql(query.sql, query.params).rows.map((row) => row[0])
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

  server.register('metricsTurnTrace', async (args, ctx) => {
    const [traceId] = args
    if (!traceId.trim()) {
      throw new Error('metricsTurnTrace requires a trace id')
    }
    // The turn's own row is here before its tree: a list read pulled it.
    if (!traceVisible(traceId, visibleInsights(ctx.actor))) throw new RpcAccessError('metricsTurnTrace', ctx.principal.kind, 'This turn is not yours to open.')
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
