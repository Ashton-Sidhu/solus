import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import type { HostApi } from '@solus/client-core/host-api'
import type { IpcContext, TurnSnapshot } from '@solus/contracts/types'
import type {
  InsightPullState,
  MetricsQueryResult,
  MetricsQuerySpec,
  MetricsSchema,
  MetricsSessionSummary,
  MetricsSqlValidation,
  MetricsTurnFilter,
  MetricsTurnPageRequest,
  MetricsTurnPageResult,
  MetricsTurnSortField,
  MetricsTurnStatus,
  MetricsTurnListingSummary,
  MetricsTurnTrace,
  MetricsValue,
  SavedMetricsQuery,
  TurnFlag,
  TurnFlagKind,
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
import { toTurnRows, type TurnRow } from './lib/turn-rows'
import { repoFileLoader } from '../diff/lib/repo-file-loader'

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
const TURNS_CHANGED_DEBOUNCE_MS = 300

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

/** The workspace imports this store at startup, so the formatter loads only
 *  when a question compiles. Formatting is cosmetic: a chunk that fails to load
 *  leaves the statement as the host compiled it. */
async function formatGeneratedSqlLazily(sql: string): Promise<string> {
  try {
    const { formatGeneratedSql } = await import('./lib/sql-format')
    return formatGeneratedSql(sql)
  } catch {
    return sql
  }
}

/**
 * What a turn changed, as git recorded it: the snapshot the host wrote when the
 * turn ended, and that snapshot's patch. `missing` is an answer — no snapshot
 * carries this trace, because the project is not a git repository or the turn
 * ran before snapshots recorded their trace.
 */
/** What the turn page reads of a change: a shared report carries the patch alone. */
export type TurnChangeReading =
  | { status: 'loading' }
  | { status: 'ready'; patch: string }
  | { status: 'missing' }
  | { status: 'failed' }
  /** A turn pulled from another host: git recorded its change there. */
  | { status: 'elsewhere'; host: string }

export type TurnChange =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: TurnSnapshot; patch: string }
  | { status: 'missing' }
  | { status: 'failed' }

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
   * SQL, event listings, and aggregate answers. The summary — the count, the
   * status chips, the stats, and the histogram — is read apart from the page,
   * because a page or sort change does not change it. */
  turnListingSummary = $state.raw<MetricsTurnListingSummary | null>(null)
  turnPage = $state.raw<MetricsTurnPageResult | null>(null)
  /** True while a page, page-size, or sort change reads new rows. The rows on
   *  screen stay until the new ones land; only `running` replaces the answer. */
  turnRowsLoading = $state(false)
  turnPageIndex = $state(0)
  turnPageSize = $state(25)
  turnSort = $state.raw<{ field: MetricsTurnSortField; dir: 'asc' | 'desc' }>({
    field: 'started_at',
    dir: 'desc',
  })
  turnStatus = $state<MetricsTurnStatus | null>(null)
  /** Absent is every host; null is the host being read; an id is one host its turns were pulled from. */
  turnHost = $state<string | null | undefined>(undefined)
  /** The host's pull of this person's turns from other hosts, or null when it does not pull. */
  insightPull = $state.raw<InsightPullState | null>(null)
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

  /** A person's marks on turns, by trace. Read once per host: the list is
   *  small and every surface that shows a chip reads the same map. */
  readonly turnFlags = new SvelteMap<string, TurnFlag>()
  private turnFlagsLoaded = false

  private valuesByColumn = new SvelteMap<string, CachedValues>()
  private valuesInFlight = new Set<string>()
  private traces = new SvelteMap<string, MetricsTurnTrace>()
  private sessionSummaries = new SvelteMap<string, MetricsSessionSummary>()
  /** Null is an answer: the host has no session by that id, or it was deleted
   *  after its spans were recorded. Re-asking on every render would then be one
   *  RPC per frame. */
  private sessionNames = new SvelteMap<string, string | null>()
  /** By trace. A finished turn's change never moves, so one read is enough. */
  private turnChanges = new SvelteMap<string, TurnChange>()
  private lastRun: LastRun | null = null
  private loadToken = 0
  /** A filter change reads the summary and the rows; a page change reads the
   *  rows alone. Each kind of read is superseded only by a newer read of it. */
  private turnAnswerToken = 0
  private turnRowsToken = 0
  /** The answer read that set `running`, or 0. A read that is dropped must
   *  still give `running` back, and must not clear it for a newer owner. */
  private runningTurnAnswer = 0
  /** The filter of the latest answer read, landed or still out. A page read
   *  reuses it, so the rows and the summary always describe the same turns and
   *  a relative window does not move between the chart and the table. */
  private turnFilter: MetricsTurnFilter | null = null
  private turnSearchTimer: ReturnType<typeof setTimeout> | null = null
  private turnsChangedTimer: ReturnType<typeof setTimeout> | null = null

  private get hostId(): string | null {
    return this.serverId ?? serverConnections.defaultMachineId()
  }

  private get api(): HostApi {
    const serverId = this.hostId
    if (!serverId) throw new Error('No Solus connection has been registered')
    return serverConnections.apiFor(serverId)
  }

  /**
   * Keeps the turn listing live while the page is open. The host announces a
   * turn's row when the turn starts and again when it ends, after the write,
   * so a re-read here always sees the new row. Only Solus's own paged listing
   * is re-read: SQL the user wrote can be expensive, and re-running it without
   * being asked would change the answer under them.
   */
  watchTurns(): () => void {
    // A new session is named after its first turn, so a name the listing asked
    // for too early arrives here rather than never.
    const unsubscribeTitles = subscribeAllHosts('session.titleChanged', (serverId, change) => {
      if (serverId !== this.hostId || !this.sessionNames.has(change.sessionId)) return
      const name = change.title?.trim()
      if (name) this.sessionNames.set(change.sessionId, name)
      else this.sessionNames.delete(change.sessionId)
    })
    const unsubscribePull = subscribeAllHosts('metrics.insightPullChanged', (serverId, state) => {
      if (serverId === this.hostId) this.insightPull = state
    })
    const unsubscribe = subscribeAllHosts('metrics.turnsChanged', (serverId, change) => {
      if (serverId !== this.hostId) return
      // A cached trace or session total that counted this turn is now old. The
      // trace is re-read in place, not dropped, so a panel showing it keeps it.
      // A change read while the turn ran found no snapshot yet; the next read
      // after it ends finds it.
      this.turnChanges.delete(change.traceId)
      if (this.traces.has(change.traceId)) void this.reloadTrace(change.traceId)
      else if (change.sessionId) this.sessionSummaries.delete(change.sessionId)
      this.scheduleTurnsReload()
    })
    return () => {
      unsubscribe()
      unsubscribePull()
      unsubscribeTitles()
      if (this.turnsChangedTimer) clearTimeout(this.turnsChangedTimer)
      this.turnsChangedTimer = null
    }
  }

  /** Several turns that end together cause one read. A read the user started
   *  is left to finish; the reload waits for it rather than replacing it. */
  private scheduleTurnsReload(): void {
    if (this.turnsChangedTimer) clearTimeout(this.turnsChangedTimer)
    this.turnsChangedTimer = setTimeout(() => {
      this.turnsChangedTimer = null
      if (!this.generatedTurnScope() || !this.turnPage) return
      if (this.running || this.turnRowsLoading) this.scheduleTurnsReload()
      else void this.runTurnListing({ quiet: true })
    }, TURNS_CHANGED_DEBOUNCE_MS)
  }

  /** Points the store at a host. A different host is a different database, so
   *  every cache is dropped rather than shown against the new one. */
  useHost(serverId: string | null): void {
    if (this.serverId === serverId) return
    this.serverId = serverId
    this.result = null
    this.clearTurnListing()
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
    this.turnChanges.clear()
    this.turnFlags.clear()
    this.turnFlagsLoaded = false
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
    this.clearTurnListing()
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
    this.turnHost = undefined
    this.insightPull = null
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
    return this.turnPage !== null && this.turnListingSummary !== null && this.generatedTurnScope() !== null
  }

  /** Bumping both tokens makes a read still in flight land on nothing. A
   *  caller that runs a new statement clears first, then sets `running`. */
  private clearTurnListing(): void {
    this.turnAnswerToken += 1
    this.turnRowsToken += 1
    if (this.runningTurnAnswer !== 0) {
      this.running = false
      this.runningTurnAnswer = 0
    }
    this.turnListingSummary = null
    this.turnPage = null
    this.turnRowsLoading = false
    this.turnFilter = null
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
      if (this.generatedTurnScope()) await this.runTurnListing()
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
    this.clearTurnListing()
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
      await this.runTurnListing()
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

  private turnPageRequest(filter: MetricsTurnFilter): MetricsTurnPageRequest {
    return { ...filter, pageIndex: this.turnPageIndex, pageSize: this.turnPageSize, sort: this.turnSort }
  }

  /** Shows a page and the session names its rows need. */
  private showTurnRows(page: MetricsTurnPageResult): void {
    this.turnPage = page
    this.turnPageIndex = page.pageIndex
    this.turnPageSize = page.pageSize
    this.result = page.page
    // Detail surfaces use these only as nearby turn context. Keeping the
    // current page bounded avoids rebuilding them from the whole range.
    this.volumeRows = toTurnRows(page.page)
    // A turn with no task is listed under its session's name. A page is a
    // bounded set of sessions, and each name is read once per host.
    for (const row of this.volumeRows) {
      if (row.sessionId && !row.taskTitle) void this.loadSessionName(row.sessionId)
    }
  }

  /** A failed read leaves no listing, rather than a chart and a table that
   *  describe different filters. */
  private failTurnListing(cause: unknown): void {
    this.result = null
    this.clearTurnListing()
    this.error = cause instanceof Error ? cause.message : String(cause)
  }

  /** Reads a new answer: the summary and the rows together, because a filter
   *  change moves both. `quiet` is a re-read the user did not ask for: the
   *  answer changes in place, with no loading state, and a failure keeps the
   *  answer already on screen. */
  private async runTurnListing({ quiet = false }: { quiet?: boolean } = {}): Promise<void> {
    const scope = this.generatedTurnScope()
    if (!scope) return
    const answerToken = ++this.turnAnswerToken
    const rowsToken = ++this.turnRowsToken
    const filter: MetricsTurnFilter = {
      timeRange: this.turnSelection ?? resolveRange(this.range, Date.now()),
      status: this.turnStatus ?? undefined,
      search: this.turnSearch || undefined,
      ...scope,
    }
    if (this.turnHost !== undefined) filter.hostId = this.turnHost
    this.turnFilter = filter
    if (!quiet) {
      this.running = true
      this.runningTurnAnswer = answerToken
      this.error = null
    }
    const startedAt = performance.now()
    try {
      const [summary, page] = await Promise.all([
        this.api.metricsTurnListingSummary(filter),
        this.api.metricsTurnPage(this.turnPageRequest(filter)),
      ])
      if (answerToken !== this.turnAnswerToken) return
      this.turnListingSummary = summary
      if (summary.pull !== undefined) this.insightPull = summary.pull
      // A page or sort change made while this read was out has newer rows.
      if (rowsToken === this.turnRowsToken) this.showTurnRows(page)
      this.answerWindowStale = false
      if (!quiet) this.lastRunMs = Math.round(performance.now() - startedAt)
    } catch (cause) {
      if (answerToken !== this.turnAnswerToken || quiet) return
      this.failTurnListing(cause)
    } finally {
      if (this.runningTurnAnswer === answerToken) {
        this.running = false
        this.runningTurnAnswer = 0
      }
      if (rowsToken === this.turnRowsToken) this.turnRowsLoading = false
    }
  }

  /** Reads only the rows, for a page, page-size, or sort change. The summary
   *  and the chart above the table do not depend on them, so they stay. */
  private async runTurnRows(): Promise<void> {
    const filter = this.turnFilter
    if (!filter) return
    const rowsToken = ++this.turnRowsToken
    this.turnRowsLoading = true
    this.error = null
    try {
      const page = await this.api.metricsTurnPage(this.turnPageRequest(filter))
      if (rowsToken === this.turnRowsToken) this.showTurnRows(page)
    } catch (cause) {
      if (rowsToken === this.turnRowsToken) this.failTurnListing(cause)
    } finally {
      if (rowsToken === this.turnRowsToken) this.turnRowsLoading = false
    }
  }

  async setTurnPage(pageIndex: number): Promise<void> {
    if (pageIndex === this.turnPageIndex) return
    this.turnPageIndex = pageIndex
    await this.runTurnRows()
  }

  async setTurnPageSize(pageSize: number): Promise<void> {
    if (pageSize === this.turnPageSize) return
    this.turnPageSize = pageSize
    this.turnPageIndex = 0
    await this.runTurnRows()
  }

  async setTurnSort(sort: { field: MetricsTurnSortField; dir: 'asc' | 'desc' }): Promise<void> {
    if (sort.field === this.turnSort.field && sort.dir === this.turnSort.dir) return
    this.turnSort = sort
    this.turnPageIndex = 0
    await this.runTurnRows()
  }

  async setTurnStatus(status: MetricsTurnStatus | null): Promise<void> {
    if (status === this.turnStatus) return
    this.turnStatus = status
    this.turnPageIndex = 0
    await this.runTurnListing()
  }

  async setTurnHost(hostId: string | null | undefined): Promise<void> {
    if (hostId === this.turnHost) return
    this.turnHost = hostId
    this.turnPageIndex = 0
    await this.runTurnListing()
  }

  setTurnSearch(search: string): void {
    this.turnSearch = search
    this.turnPageIndex = 0
    if (this.turnSearchTimer) clearTimeout(this.turnSearchTimer)
    this.turnSearchTimer = setTimeout(() => {
      this.turnSearchTimer = null
      void this.runTurnListing()
    }, 180)
  }

  async setTurnSelection(selection: { from: number; to: number } | null): Promise<void> {
    this.turnSelection = selection
    this.turnPageIndex = 0
    await this.runTurnListing()
  }

  async runSql(sql: string): Promise<void> {
    const text = sql.trim()
    if (!text) return
    this.clearTurnListing()
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
    this.clearTurnListing()
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
    this.clearTurnListing()
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
      const sql = await formatGeneratedSqlLazily(compiled.sql)
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

  // ── Turn flags ──

  private replaceTurnFlags(flags: TurnFlag[]): void {
    this.turnFlags.clear()
    for (const flag of flags) this.turnFlags.set(flag.traceId, flag)
    this.turnFlagsLoaded = true
  }

  async loadTurnFlags(): Promise<void> {
    if (this.turnFlagsLoaded) return
    // Claimed before the await so two surfaces mounting together ask once.
    this.turnFlagsLoaded = true
    try {
      this.replaceTurnFlags(await this.api.metricsListTurnFlags())
    } catch {
      this.turnFlagsLoaded = false
    }
  }

  async setTurnFlag(traceId: string, kind: TurnFlagKind, note: string): Promise<void> {
    this.replaceTurnFlags(await this.api.metricsSetTurnFlag({ traceId, kind, note }))
  }

  async clearTurnFlag(traceId: string): Promise<void> {
    this.replaceTurnFlags(await this.api.metricsClearTurnFlag(traceId))
  }

  // ── Trace and session rollups ──

  trace(traceId: string): MetricsTurnTrace | null {
    return this.traces.get(traceId) ?? null
  }

  async loadTrace(traceId: string): Promise<MetricsTurnTrace | null> {
    const cached = this.traces.get(traceId)
    if (cached) return cached
    return this.reloadTrace(traceId)
  }

  /** Re-reads a trace the host is still writing — a running turn's spans
   *  arrive as it works — and drops the session rollup that counted it, so the
   *  session card's totals move with it. */
  async reloadTrace(traceId: string): Promise<MetricsTurnTrace | null> {
    try {
      const trace = await this.api.metricsTurnTrace(traceId)
      this.traces.set(traceId, trace)
      const sessionId = trace.spans.find((span) => span.sessionId)?.sessionId
      if (sessionId) this.sessionSummaries.delete(sessionId)
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

  // ── What a turn changed ──

  turnChange(traceId: string): TurnChange | null {
    return this.turnChanges.get(traceId) ?? null
  }

  /**
   * Finds the snapshot the host wrote for this trace and reads its patch. The
   * snapshot index counts snapshots, not turns, so the trace id is the join —
   * never the turn's position in the session. `ctx` names the turn's session
   * alone (`ctxForSessionRecord`): the host resolves its thread and checkout.
   */
  /** The change map's repository listing, read on this store's host. */
  repoFileLoader(ctx: IpcContext): (repoRoot: string) => Promise<readonly string[] | null> {
    return repoFileLoader(() => this.api, () => ctx)
  }

  async loadTurnChange(ctx: IpcContext, traceId: string): Promise<void> {
    if (this.turnChanges.has(traceId)) return
    const hostId = this.hostId
    // Claimed before the await so two mounts of one turn read once.
    this.turnChanges.set(traceId, { status: 'loading' })
    const settle = (change: TurnChange) => {
      // A host switch cleared the cache; this answer is about the other host.
      if (this.hostId === hostId) this.turnChanges.set(traceId, change)
    }
    try {
      const snapshot = (await this.api.listTurnSnapshots(ctx)).find((turn) => turn.traceId === traceId)
      if (!snapshot) return settle({ status: 'missing' })
      const diff = snapshot.filesChanged > 0
        ? await this.api.diff(ctx, { scope: { kind: 'turn', index: snapshot.index } })
        : null
      settle({ status: 'ready', snapshot, patch: diff?.patch ?? '' })
    } catch {
      settle({ status: 'failed' })
    }
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
