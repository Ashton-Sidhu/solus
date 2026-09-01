import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HostApi } from '@solus/client-core/host-api'
import type { IpcContext } from '@solus/contracts/types'
import type {
  MetricsQueryResult,
  MetricsQuerySpec,
  MetricsSchema,
  MetricsSessionSummary,
  MetricsSqlValidation,
  MetricsTurnPageResult,
  MetricsTurnSortField,
  MetricsTurnStatus,
  MetricsTurnTrace,
  MetricsValue,
  SavedMetricsQuery,
} from '@solus/contracts/observability-types'
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
  replaceRangeCondition,
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

/** How the answer on screen is re-run. An NL answer keeps the range its SQL was
 *  compiled for so the managed predicate can move locally without another NLP
 *  call. */
type LastRun =
  | { form: 'sql'; sql: string }
  | { form: 'nl'; range: TimeRange; sql: string }
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
  /** True from the moment the page's opening load starts until its first answer
   *  lands. The registry and the saved queries are read before any statement
   *  runs, so `running` is still false across two round trips — long enough for
   *  the page to paint a real empty listing between the pane's loading cover and
   *  the answer's. */
  bootstrapping = $state(false)
  /** True while the NL question is with the agent — the slow half of `running`,
   *  named so the console can say "compiling" instead of a generic "running". */
  compiling = $state(false)
  error = $state<string | null>(null)
  result = $state.raw<MetricsQueryResult | null>(null)
  /** Server-paged state for Solus's generated turn listing. Null for arbitrary
   * SQL, event listings, and aggregate answers. */
  turnPage = $state.raw<MetricsTurnPageResult | null>(null)
  turnPageIndex = $state(0)
  turnPageSize = $state(25)
  turnSort = $state.raw<{ field: MetricsTurnSortField; dir: 'asc' | 'desc' }>({
    field: 'started_at',
    dir: 'desc',
  })
  turnStatus = $state<MetricsTurnStatus | null>(null)
  turnSearch = $state('')
  turnSelection = $state.raw<{ from: number; to: number } | null>(null)
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
  private turnPageToken = 0
  private turnSearchTimer: ReturnType<typeof setTimeout> | null = null

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
    this.turnPage = null
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
    this.resetTurnControls()
  }

  /**
   * Returns the surface to a first visit. Insights is a question being asked,
   * not a document being written: leaving the page ends the question, so the
   * next entry starts from the default listing instead of resuming yesterday's
   * answer and its run history.
   *
   * The range and the internals toggle are stated preferences, and the saved
   * queries and the caches are facts about the host — none of them describe
   * this visit, so all of them survive.
   */
  reset(): void {
    // A load or a histogram read still in flight belongs to the visit that is
    // ending; bumping the token makes it land on nothing.
    this.loadToken += 1
    this.form = 'nl'
    this.question = ''
    this.generated = { kind: 'explore' }
    this.sqlText = defaultExploreSql(this.range)
    this.answerWindowStale = false
    this.result = null
    this.turnPage = null
    this.error = null
    this.compiledSql = ''
    this.compileAttempts = 0
    this.lastRunMs = 0
    this.history = []
    this.volumeRows = []
    this.lastRun = null
    this.running = false
    this.compiling = false
    this.bootstrapping = false
    this.resetTurnControls()
  }

  private resetTurnControls(): void {
    this.turnPageIndex = 0
    this.turnPageSize = 25
    this.turnSort = { field: 'started_at', dir: 'desc' }
    this.turnStatus = null
    this.turnSearch = ''
    this.turnSelection = null
    if (this.turnSearchTimer) clearTimeout(this.turnSearchTimer)
    this.turnSearchTimer = null
  }

  private generatedTurnScope(): { sessionId?: string; taskId?: string } | null {
    if (this.generated?.kind === 'explore') return {}
    if (this.generated?.kind === 'session') return { sessionId: this.generated.sessionId }
    if (this.generated?.kind === 'task') return { taskId: this.generated.taskId }
    return null
  }

  get hasPagedTurnListing(): boolean {
    return this.turnPage !== null && this.generatedTurnScope() !== null
  }

  /**
   * Moves the window. Solus's own statements are rewritten at the new range and
   * re-run; SQL the user wrote or saved is left exactly as typed and re-run
   * unchanged, because a filter that edits someone's query is not a filter.
   */
  async setRange(next: TimeRange): Promise<void> {
    if (sameRange(this.range, next)) return
    const last = this.lastRun
    this.range = next
    this.turnPageIndex = 0
    this.turnSelection = null
    try {
      globalThis.localStorage?.setItem(RANGE_KEY, JSON.stringify(next))
    } catch {
      // A client that refuses storage still gets the range for this session.
    }
    const regenerated = this.generated ? generatedSql(this.generated, next) : null
    let didMoveAnswer = regenerated != null
    if (regenerated) {
      this.sqlText = regenerated
      this.lastRun = { form: 'sql', sql: regenerated }
    }
    if (last?.form === 'nl') {
      const rewritten = replaceRangeCondition(last.sql, last.range, next)
      if (rewritten) {
        this.sqlText = rewritten
        this.compiledSql = rewritten
        this.lastRun = { form: 'nl', range: next, sql: rewritten }
        didMoveAnswer = true
      }
    }
    await this.refresh()
    // The histogram now describes the new window. An answer that Solus could
    // not rewrite still describes the old one, and must say so rather than sit
    // under a chart that contradicts it.
    this.answerWindowStale = !didMoveAnswer && this.result != null
  }

  /** Runs one of Solus's own statements, remembering which one so a later range
   *  change can re-emit it.
   *
   *  Asked from off the page — "open this session in Insights" — the statement
   *  is only set, because the page's opening load runs whatever text the editor
   *  holds against the host it resolves. Running it here as well would ask the
   *  same question twice on every entry.
   *
   *  `landOn` is the tab the user is left in. It is the SQL tab by default,
   *  because a generated statement the user cannot read is not one they can
   *  trust; a caller that is ending a question rather than showing one asks
   *  for the question tab instead. */
  async runGenerated(query: GeneratedQuery, landOn: QueryForm = 'sql'): Promise<void> {
    const sql = generatedSql(query, this.range)
    if (!sql) return
    this.generated = query
    this.form = landOn
    this.sqlText = sql
    // Named as the run to repeat before it has run, so the page's opening load
    // and any later refresh re-ask this question rather than the previous one.
    this.lastRun = { form: 'sql', sql }
    this.turnPageIndex = 0
    this.turnSelection = null
    if (this.serverId) {
      if (this.generatedTurnScope()) await this.runTurnPage()
      else await this.runSql(sql)
    }
  }

  /** The way back to the default listing from on the page. The question that
   *  was asked ends with it, so the field is emptied and the visit continues in
   *  the question tab, where the next question starts, rather than in the SQL
   *  the default listing happens to be written as. */
  async resetToDefault(): Promise<void> {
    this.question = ''
    await this.runGenerated({ kind: 'explore' }, 'nl')
  }

  /** The editor's text became the user's. From here the range governs the
   *  histogram only, until a generated query is run again. */
  setUserSql(sql: string): void {
    this.sqlText = sql
    this.generated = null
    this.turnPage = null
  }

  /** Everything the page needs before it can answer anything: the registry, the
   *  user's saved queries, the histogram, and the default result. */
  async load(): Promise<void> {
    const token = ++this.loadToken
    this.bootstrapping = true
    try {
      const [schema, saved] = await Promise.all([
        this.api.metricsSchema().catch(() => null),
        this.api.metricsListSavedQueries().catch((): SavedMetricsQuery[] => []),
      ])
      if (token !== this.loadToken) return
      if (schema) this.schema = schema
      this.savedQueries = saved
      await this.refresh()
    } finally {
      // A newer load owns the flag; this one must not clear it under that one.
      if (token === this.loadToken) this.bootstrapping = false
    }
  }

  /**
   * Re-reads the window: the histogram and the answer under it describe the
   * same turns, so they always move together. Refreshing the histogram alone
   * would leave the list on an older window — a failed turn would appear as a
   * red bar with no row below it to explain it.
   */
  async refresh(): Promise<void> {
    const token = this.loadToken
    if (this.generatedTurnScope()) {
      const window = resolveRange(this.range, Date.now())
      this.windowFrom = window.from
      this.windowTo = window.to
      await this.runTurnPage()
      return
    }
    // Re-running a statement does not re-author it: text that already described
    // an older window still does after a refresh.
    const wasStale = this.answerWindowStale
    await this.refreshVolume()
    if (token !== this.loadToken) return
    const last = this.lastRun
    if (!last) await this.runSql(this.sqlText)
    else if (last.form === 'sql') await this.runSql(last.sql)
    else if (last.form === 'nl') {
      await this.runSql(last.sql)
      // `runSql` records its direct execution shape. Keep the originating
      // question so a later range change can compile it for that new window.
      if (token === this.loadToken) this.lastRun = last
    }
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

  private async runTurnPage(): Promise<void> {
    const scope = this.generatedTurnScope()
    if (!scope) return
    const requestToken = ++this.turnPageToken
    const selectedWindow = this.turnSelection ?? resolveRange(this.range, Date.now())
    this.running = true
    this.error = null
    const startedAt = performance.now()
    try {
      const page = await this.api.metricsTurnPage({
        timeRange: selectedWindow,
        pageIndex: this.turnPageIndex,
        pageSize: this.turnPageSize,
        sort: this.turnSort,
        status: this.turnStatus ?? undefined,
        search: this.turnSearch || undefined,
        ...scope,
      })
      if (requestToken !== this.turnPageToken) return
      this.turnPage = page
      this.turnPageIndex = page.pageIndex
      this.turnPageSize = page.pageSize
      this.result = page.page
      // Detail surfaces use these only as nearby turn context. Keeping the
      // current page bounded avoids rebuilding them from the whole range.
      this.volumeRows = toTurnRows(page.page)
      this.answerWindowStale = false
      this.lastRunMs = Math.round(performance.now() - startedAt)
    } catch (cause) {
      if (requestToken !== this.turnPageToken) return
      this.result = null
      this.turnPage = null
      this.error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (requestToken === this.turnPageToken) this.running = false
    }
  }

  async setTurnPage(pageIndex: number): Promise<void> {
    if (pageIndex === this.turnPageIndex) return
    this.turnPageIndex = pageIndex
    await this.runTurnPage()
  }

  async setTurnPageSize(pageSize: number): Promise<void> {
    if (pageSize === this.turnPageSize) return
    this.turnPageSize = pageSize
    this.turnPageIndex = 0
    await this.runTurnPage()
  }

  async setTurnSort(sort: { field: MetricsTurnSortField; dir: 'asc' | 'desc' }): Promise<void> {
    if (sort.field === this.turnSort.field && sort.dir === this.turnSort.dir) return
    this.turnSort = sort
    this.turnPageIndex = 0
    await this.runTurnPage()
  }

  async setTurnStatus(status: MetricsTurnStatus | null): Promise<void> {
    if (status === this.turnStatus) return
    this.turnStatus = status
    this.turnPageIndex = 0
    await this.runTurnPage()
  }

  setTurnSearch(search: string): void {
    this.turnSearch = search
    this.turnPageIndex = 0
    if (this.turnSearchTimer) clearTimeout(this.turnSearchTimer)
    this.turnSearchTimer = setTimeout(() => {
      this.turnSearchTimer = null
      void this.runTurnPage()
    }, 180)
  }

  async setTurnSelection(selection: { from: number; to: number } | null): Promise<void> {
    this.turnSelection = selection
    this.turnPageIndex = 0
    await this.runTurnPage()
  }

  async runSql(sql: string): Promise<void> {
    const text = sql.trim()
    if (!text) return
    this.running = true
    this.turnPage = null
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
    this.turnPage = null
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
    this.turnPage = null
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
      // The SQL stays editable, but this remains an NL run until the user edits
      // it. A range change can then ask the same question over the new window.
      this.generated = null
      this.compileAttempts = compiled.attempts
      if (!compiled.ok) {
        this.result = null
        this.error = compiled.error ?? 'The generated query did not compile'
        return
      }
      const result = await this.api.metricsRunSql(sql)
      this.result = result
      this.answerWindowStale = false
      this.lastRun = { form: 'nl', range: this.range, sql }
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
