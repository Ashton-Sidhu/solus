import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@client-core/server-connections'
import type { HostApi } from '@client-core/host-api'
import type { IpcContext } from '../../../shared/types'
import type {
  MetricsQueryResult,
  MetricsQuerySpec,
  MetricsSchema,
  MetricsSessionSummary,
  MetricsSqlValidation,
  MetricsTurnTrace,
  MetricsValue,
  SavedMetricsQuery,
} from '../../../shared/observability-types'
import {
  defaultExploreSql,
  generatedSql,
  turnVolumeSpec,
  type GeneratedQuery,
} from './lib/insights-queries'
import {
  DEFAULT_TIME_RANGE,
  parseStoredRange,
  rangeInstruction,
  resolveRange,
  sameRange,
  type TimeRange,
} from './lib/time-range'
import { formatGeneratedSql } from './lib/sql-format'
import { toTurnRows, type TurnRow } from './lib/turn-rows'

/**
 * Insights query state, owned in one place.
 *
 * Everything durable the surface reads — the field registry, distinct column
 * values, saved queries, turn traces, the histogram's rows — is cached here,
 * so the page and the turn detail read the same facts and the SQL editor's
 * completion resolves synchronously instead of issuing an RPC per keystroke.
 *
 * `metrics.db` is host-local: each host records its own runs. The store is
 * therefore keyed by host, and pointing it at a different host clears every
 * cache rather than mixing two machines' spans into one answer.
 */

const HISTORY_LIMIT = 24
const VALUES_TTL_MS = 60_000
const RANGE_KEY = 'solus.insights.timeRange'
const SOLUS_INTERNALS_KEY = 'solus.insights.showSolusInternals'

export type QueryForm = 'nl' | 'sql'

export interface QueryRunRecord {
  id: string
  form: QueryForm
  /** The question for an NL run, the statement for a SQL run. */
  text: string
  rowCount: number
  tookMs: number
  at: number
}

interface CachedValues {
  values: MetricsValue[]
  at: number
}

/** How the answer on screen is re-run. An NL question re-runs the SQL it
 *  compiled to, never the compile: the question is already answered, and a
 *  second agent call would charge the user to ask it again. */
type LastRun =
  | { form: 'sql'; sql: string }
  | { form: 'spec'; spec: MetricsQuerySpec }

/** The range outlives the page: a user investigating one afternoon should not
 *  re-pick it on every entry. An unreadable or malformed value falls back to
 *  the default rather than throwing the surface away. */
function readRangePreference(): TimeRange {
  try {
    return parseStoredRange(globalThis.localStorage?.getItem(RANGE_KEY) ?? null) ?? DEFAULT_TIME_RANGE
  } catch {
    return DEFAULT_TIME_RANGE
  }
}

export class InsightsStore {
  /** Which host's `metrics.db` is being read. */
  serverId = $state<string | null>(null)

  /** The window every answer on this page is asked in. */
  range = $state.raw<TimeRange>(readRangePreference())

  /** Whether a trace draws the work Solus did around the agent's — dispatch and
   *  its steps, the queue, settlement. Off by default: the ordinary question a
   *  reader opens a turn with is what the agent did. It outlives the page for
   *  the same reason the range does — someone investigating Solus's own
   *  overhead is doing it across many turns, not one. */
  showSolusInternals = $state(globalThis.localStorage?.getItem(SOLUS_INTERNALS_KEY) === 'true')

  setShowSolusInternals(next: boolean): void {
    this.showSolusInternals = next
    try {
      globalThis.localStorage?.setItem(SOLUS_INTERNALS_KEY, String(next))
    } catch {
      // A client that refuses storage still gets the choice for this session.
    }
  }

  form = $state<QueryForm>('nl')
  question = $state('')
  sqlText = $state(defaultExploreSql(this.range))
  /** Which of Solus's own statements the editor currently holds, or null once
   *  the text is the user's — theirs is never rewritten by a range change. */
  generated = $state.raw<GeneratedQuery | null>({ kind: 'explore' })
  /** True when the range moved under an answer Solus could not rewrite — the
   *  result on screen describes an older window than the histogram. */
  answerWindowStale = $state(false)

  running = $state(false)
  /** True while the NL question is with the agent — the slow half of `running`,
   *  named so the console can say "compiling" instead of a generic "running". */
  compiling = $state(false)
  error = $state<string | null>(null)
  result = $state.raw<MetricsQueryResult | null>(null)
  lastRunMs = $state(0)
  /** SQL the NL compile produced for the current question. It is written into
   *  the editor too, so the SQL tab is where it is read; this is what a save
   *  from the question tab stores. */
  compiledSql = $state('')
  compileAttempts = $state(0)

  history = $state.raw<QueryRunRecord[]>([])
  savedQueries = $state.raw<SavedMetricsQuery[]>([])
  schema = $state.raw<MetricsSchema | null>(null)

  /** The histogram's own rows: turn volume over the window, independent of the
   *  question being asked. */
  volumeRows = $state.raw<TurnRow[]>([])
  /** The selected range resolved to instants, refreshed on each load so a
   *  relative window's bucket edges do not drift while the page sits open. */
  windowFrom = $state(resolveRange(this.range, Date.now()).from)
  windowTo = $state(Date.now())

  private valuesByColumn = new SvelteMap<string, CachedValues>()
  private valuesInFlight = new Set<string>()
  private traces = new SvelteMap<string, MetricsTurnTrace>()
  private sessionSummaries = new SvelteMap<string, MetricsSessionSummary>()
  /** Null is an answer: the host has no session by that id, or it was deleted
   *  after its spans were recorded. Re-asking on every render would then be one
   *  RPC per frame. */
  private sessionNames = new SvelteMap<string, string | null>()
  private lastRun: LastRun | null = null
  private loadToken = 0

  private get api(): HostApi {
    const serverId = this.serverId ?? serverConnections.defaultServerId()
    if (!serverId) throw new Error('No Solus connection has been registered')
    return serverConnections.apiFor(serverId)
  }

  /** Points the store at a host. A different host is a different database, so
   *  every cache is dropped rather than shown against the new one. */
  useHost(serverId: string | null): void {
    if (this.serverId === serverId) return
    this.serverId = serverId
    this.result = null
    this.error = null
    this.compiledSql = ''
    this.answerWindowStale = false
    this.lastRun = null
    this.volumeRows = []
    this.schema = null
    this.savedQueries = []
    this.history = []
    this.valuesByColumn.clear()
    this.traces.clear()
    this.sessionSummaries.clear()
    this.sessionNames.clear()
  }

  /**
   * Moves the window. Solus's own statements are rewritten at the new range and
   * re-run; SQL the user wrote or saved is left exactly as typed and re-run
   * unchanged, because a filter that edits someone's query is not a filter.
   */
  async setRange(next: TimeRange): Promise<void> {
    if (sameRange(this.range, next)) return
    this.range = next
    try {
      globalThis.localStorage?.setItem(RANGE_KEY, JSON.stringify(next))
    } catch {
      // A client that refuses storage still gets the range for this session.
    }
    const regenerated = this.generated ? generatedSql(this.generated, next) : null
    if (regenerated) {
      this.sqlText = regenerated
      this.lastRun = { form: 'sql', sql: regenerated }
    }
    await this.refresh()
    // The histogram now describes the new window. An answer that Solus could
    // not rewrite still describes the old one, and must say so rather than sit
    // under a chart that contradicts it.
    this.answerWindowStale = !regenerated && this.result != null
  }

  /** Runs one of Solus's own statements, remembering which one so a later range
   *  change can re-emit it. */
  async runGenerated(query: GeneratedQuery): Promise<void> {
    const sql = generatedSql(query, this.range)
    if (!sql) return
    this.generated = query
    this.form = 'sql'
    this.sqlText = sql
    await this.runSql(sql)
  }

  /** The editor's text became the user's. From here the range governs the
   *  histogram only, until a generated query is run again. */
  setUserSql(sql: string): void {
    this.sqlText = sql
    this.generated = null
  }

  /** Everything the page needs before it can answer anything: the registry, the
   *  user's saved queries, the histogram, and the default result. */
  async load(): Promise<void> {
    const token = ++this.loadToken
    const [schema, saved] = await Promise.all([
      this.api.metricsSchema().catch(() => null),
      this.api.metricsListSavedQueries().catch(() => [] as SavedMetricsQuery[]),
    ])
    if (token !== this.loadToken) return
    if (schema) this.schema = schema
    this.savedQueries = saved
    await this.refresh()
  }

  /**
   * Re-reads the window: the histogram and the answer under it describe the
   * same turns, so they always move together. Refreshing the histogram alone
   * would leave the list on an older window — a failed turn would appear as a
   * red bar with no row below it to explain it.
   */
  async refresh(): Promise<void> {
    const token = this.loadToken
    // Re-running a statement does not re-author it: text that already described
    // an older window still does after a refresh.
    const wasStale = this.answerWindowStale
    await this.refreshVolume()
    if (token !== this.loadToken) return
    const last = this.lastRun
    if (!last) await this.runSql(this.sqlText)
    else if (last.form === 'sql') await this.runSql(last.sql)
    else await this.runSpec(last.spec)
    this.answerWindowStale = wasStale
  }

  /** The histogram's query. Kept separate from the user's question so the shape
   *  the answer sits in does not collapse when the question narrows. */
  private async refreshVolume(): Promise<void> {
    const token = this.loadToken
    const window = resolveRange(this.range, Date.now())
    this.windowFrom = window.from
    this.windowTo = window.to
    try {
      const result = await this.api.metricsQuery(turnVolumeSpec(window))
      if (token !== this.loadToken) return
      this.volumeRows = toTurnRows(result)
    } catch {
      if (token === this.loadToken) this.volumeRows = []
    }
  }

  private record(form: QueryForm, text: string, rowCount: number, tookMs: number): void {
    const entry: QueryRunRecord = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      form,
      text,
      rowCount,
      tookMs,
      at: Date.now(),
    }
    this.history = [entry, ...this.history.filter((run) => run.text !== text)].slice(0, HISTORY_LIMIT)
  }

  async runSql(sql: string): Promise<void> {
    const text = sql.trim()
    if (!text) return
    this.running = true
    this.error = null
    const startedAt = performance.now()
    try {
      const result = await this.api.metricsRunSql(text)
      this.result = result
      this.answerWindowStale = false
      this.lastRun = { form: 'sql', sql: text }
      this.lastRunMs = Math.round(performance.now() - startedAt)
      this.record('sql', text, result.rows.length, this.lastRunMs)
    } catch (cause) {
      this.result = null
      this.error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      this.running = false
    }
  }

  async runSpec(spec: MetricsQuerySpec): Promise<void> {
    this.running = true
    this.error = null
    const startedAt = performance.now()
    try {
      this.result = await this.api.metricsQuery(spec)
      this.answerWindowStale = false
      this.lastRun = { form: 'spec', spec }
      this.lastRunMs = Math.round(performance.now() - startedAt)
    } catch (cause) {
      this.result = null
      this.error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      this.running = false
    }
  }

  /**
   * Compiles the question to SQL and runs it. The generated statement lands in
   * the editor either way: a question that compiled to the wrong query is only
   * fixable if the user can see it.
   *
   * The selected window rides along with the question, so an answer and the
   * histogram above it describe the same turns. It is an instruction, not a
   * rewrite: a question that names its own period still wins, and the resulting
   * `where` clause is visible in the compiled SQL.
   */
  async compileAndRun(ctx: IpcContext, question: string): Promise<void> {
    const text = question.trim()
    if (!text) return
    this.running = true
    this.compiling = true
    this.error = null
    const startedAt = performance.now()
    try {
      const compiled = await this.api.metricsCompileNl(
        ctx,
        `${text}\n\n${rangeInstruction(this.range)}`,
      )
      this.compiling = false
      const sql = formatGeneratedSql(compiled.sql)
      this.compiledSql = sql
      this.sqlText = sql
      // The compiled statement is text like any other the user could edit, so a
      // later range change re-runs it rather than rewriting it — and says so.
      this.generated = null
      this.compileAttempts = compiled.attempts
      if (!compiled.ok) {
        this.result = null
        this.error = compiled.error ?? 'The generated query did not compile'
        return
      }
      const result = await this.api.metricsRunSql(sql)
      this.result = result
      this.lastRun = { form: 'sql', sql }
      this.lastRunMs = Math.round(performance.now() - startedAt)
      this.record('nl', text, result.rows.length, this.lastRunMs)
    } catch (cause) {
      this.result = null
      this.error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      this.running = false
      this.compiling = false
    }
  }

  validateSql(sql: string): Promise<MetricsSqlValidation> {
    return this.api.metricsValidateSql(sql)
  }

  // ── Distinct values, for the editor's value completion ──

  cachedValues(column: string): MetricsValue[] | null {
    const cached = this.valuesByColumn.get(column)
    if (!cached || Date.now() - cached.at > VALUES_TTL_MS) return null
    return cached.values
  }

  requestValues(column: string): void {
    if (this.valuesInFlight.has(column)) return
    this.valuesInFlight.add(column)
    void this.api
      .metricsDistinctValues(column)
      .then((values) => this.valuesByColumn.set(column, { values, at: Date.now() }))
      .catch(() => {
        // A column with nothing recorded yet is not an error worth surfacing —
        // completion simply offers nothing.
      })
      .finally(() => this.valuesInFlight.delete(column))
  }

  // ── Saved queries ──

  async saveCurrent(name: string): Promise<void> {
    const now = Date.now()
    const query: SavedMetricsQuery = {
      id: `sq_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      form: 'sql',
      sql: this.form === 'sql' ? this.sqlText : this.compiledSql || this.sqlText,
      createdAt: now,
      updatedAt: now,
    }
    this.savedQueries = await this.api.metricsSaveQuery(query)
  }

  async deleteSaved(id: string): Promise<void> {
    this.savedQueries = await this.api.metricsDeleteQuery(id)
  }

  // ── Trace and session rollups ──

  trace(traceId: string): MetricsTurnTrace | null {
    return this.traces.get(traceId) ?? null
  }

  async loadTrace(traceId: string): Promise<MetricsTurnTrace | null> {
    const cached = this.traces.get(traceId)
    if (cached) return cached
    try {
      const trace = await this.api.metricsTurnTrace(traceId)
      this.traces.set(traceId, trace)
      return trace
    } catch {
      return null
    }
  }

  sessionSummary(sessionId: string): MetricsSessionSummary | null {
    return this.sessionSummaries.get(sessionId) ?? null
  }

  async loadSessionSummary(sessionId: string): Promise<MetricsSessionSummary | null> {
    const cached = this.sessionSummaries.get(sessionId)
    if (cached) return cached
    try {
      const summary = await this.api.metricsSessionSummary(sessionId)
      this.sessionSummaries.set(sessionId, summary)
      return summary
    } catch {
      return null
    }
  }

  /**
   * The name a session is listed under, when the host still holds the session.
   *
   * `metrics.db` records ids, never names — a name is editable and a recorded
   * span is not — so the name is read from the host that owns the session and
   * cached beside the rollup. A turn whose session has been deleted keeps its
   * id, which is what every other insights surface shows.
   */
  sessionName(sessionId: string): string | null {
    return this.sessionNames.get(sessionId) ?? null
  }

  async loadSessionName(sessionId: string): Promise<void> {
    if (this.sessionNames.has(sessionId)) return
    // Claimed before the await so two mounts of one turn do not both ask.
    this.sessionNames.set(sessionId, null)
    try {
      const meta = await this.api.getSessionInfo(sessionId)
      const name = meta?.customTitle?.trim() || meta?.slug?.trim() || ''
      if (name) this.sessionNames.set(sessionId, name)
    } catch {
      // A host that cannot answer leaves the id showing, which is correct.
    }
  }
}

export const insightsStore = new InsightsStore()
