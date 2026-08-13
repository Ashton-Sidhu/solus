import type { IpcContext } from '../../../shared/types'
import type { MetricsQuerySpec, SavedMetricsQuery } from '../../../shared/observability-types'
import { TextGenerator } from '../../agents/text-generator'
import type { ControlPlane } from '../../control-plane'
import { metricsSchema } from '../../observability/field-registry'
import { compileNlToSql, nlCompileSystemPrompt } from '../../observability/nl-compile'
import { compileQuerySpec } from '../../observability/query-compiler'
import { SPAN_SERVICES } from '../../observability/registries'
import { sessionSummary, turnTrace } from '../../observability/rollups'
import {
  deleteSavedMetricsQuery,
  listSavedMetricsQueries,
  saveMetricsQuery,
} from '../../observability/saved-queries'
import { runCompiledSql, runGuardedSql, validateMetricsSql } from '../../observability/sql-guard'
import { solusDir } from '../../platform/paths'
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
} as const

function distinctValuesSql(column: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(DISTINCT_COLUMNS, column)
    ? DISTINCT_COLUMNS[column as keyof typeof DISTINCT_COLUMNS]
    : undefined
}

const NL_TIMEOUT_MS = 60_000

export function registerObservabilityHandlers(server: SolusServer, deps: { controlPlane: ControlPlane }): void {
  const textGenerator = new TextGenerator(deps.controlPlane)

  server.register('metricsQuery', (args) => {
    const [spec] = args as [MetricsQuerySpec]
    const compiled = compileQuerySpec(spec)
    return runCompiledSql(compiled.sql, compiled.params)
  })

  server.register('metricsRunSql', (args) => {
    const [sql] = args as [string]
    if (typeof sql !== 'string' || !sql.trim()) throw new Error('metricsRunSql requires SQL text')
    return runGuardedSql(sql)
  })

  server.register('metricsValidateSql', (args) => {
    const [sql] = args as [string]
    if (typeof sql !== 'string') throw new Error('metricsValidateSql requires SQL text')
    return validateMetricsSql(sql)
  })

  server.register('metricsCompileNl', async (args) => {
    const [ctx, question] = args as [IpcContext, string]
    if (typeof question !== 'string' || !question.trim()) {
      throw new Error('metricsCompileNl requires a question')
    }
    const cwd = ctx.session.workingDirectory && ctx.session.workingDirectory !== '~'
      ? ctx.session.workingDirectory
      : solusDir()
    return compileNlToSql(question, {
      generate: (prompt) => textGenerator.generate({
        provider: ctx.session.provider ?? ctx.settings.activeAgent,
        model: ctx.statusBar.model,
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
    const [columnName] = args as [string]
    const sql = distinctValuesSql(columnName)
    if (!sql) throw new Error(`metricsDistinctValues does not serve column: ${columnName}`)
    return runCompiledSql(sql, []).rows.map((row) => row[0])
  })

  server.register('metricsListSavedQueries', () => listSavedMetricsQueries())

  server.register('metricsSaveQuery', (args) => {
    const [query] = args as [SavedMetricsQuery]
    return saveMetricsQuery(query)
  })

  server.register('metricsDeleteQuery', (args) => {
    const [id] = args as [string]
    if (typeof id !== 'string' || !id.trim()) throw new Error('metricsDeleteQuery requires an id')
    return deleteSavedMetricsQuery(id)
  })

  server.register('metricsSessionSummary', (args) => {
    const [sessionId] = args as [string]
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new Error('metricsSessionSummary requires a session id')
    }
    return sessionSummary(sessionId)
  })

  server.register('metricsTurnTrace', (args) => {
    const [traceId] = args as [string]
    if (typeof traceId !== 'string' || !traceId.trim()) {
      throw new Error('metricsTurnTrace requires a trace id')
    }
    return turnTrace(traceId)
  })
}
