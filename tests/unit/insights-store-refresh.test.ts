import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test'
import type { HostEventMap } from '@solus/contracts/host-events'
import type { MetricsQueryResult, MetricsQuerySpec, MetricsTurnPageRequest, MetricsTurnPageResult } from '@solus/contracts/observability-types'
import type { DiffRequest, IpcContext, TurnSnapshot } from '@solus/contracts/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const serverConnectionsMock = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: serverConnectionsMock,
}))

type TurnsChanged = HostEventMap['metrics.turnsChanged']
type TitleChanged = HostEventMap['session.titleChanged']
const turnsChangedHandlers = new Set<(serverId: string, change: TurnsChanged) => void>()
const titleChangedHandlers = new Set<(serverId: string, change: TitleChanged) => void>()
mock.module('@solus/client-core/host-events', () => ({
  subscribeAllHosts: (topic: string, handler: (serverId: string, change: never) => void) => {
    const handlers: Set<(serverId: string, change: never) => void> = topic === 'metrics.turnsChanged'
      ? turnsChangedHandlers
      : titleChangedHandlers
    handlers.add(handler)
    return () => handlers.delete(handler)
  },
}))

function announceTurn(serverId: string, change: TurnsChanged): void {
  for (const handler of turnsChangedHandlers) handler(serverId, change)
}

function announceTitle(serverId: string, change: TitleChanged): void {
  for (const handler of titleChangedHandlers) handler(serverId, change)
}

const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state

/** Turn rows the histogram and the list both read, newest first. */
function turnResult(traceIds: string[]): MetricsQueryResult {
  return {
    columns: ['trace_id', 'span_id', 'session_id', 'started_at', 'duration_ms', 'status']
      .map((name) => ({ name })),
    rows: traceIds.map((traceId, index) => [traceId, traceId, 'session-1', 1_700_000_000_000 + index, 10, 'error']),
    sourceView: 'turns',
  }
}

let sqlRuns: string[] = []
let compiledQuestions: string[] = []
let pageRequests: MetricsTurnPageRequest[] = []
let available: string[] = []
let sessionTitles = new Map<string, string>()
let snapshots: TurnSnapshot[] = []
let diffRequests: DiffRequest[] = []

function snapshot(index: number, traceId: string | undefined, filesChanged = 2): TurnSnapshot {
  return {
    index,
    fromTreeSha: 'from',
    toTreeSha: 'to',
    sha: 'sha',
    timestamp: 1,
    partial: false,
    userMessagePreview: '',
    ...(traceId ? { traceId } : {}),
    filesChanged,
    additions: 3,
    deletions: 1,
  }
}

/** What the page passes: the turn's session, named by its Solus id alone. */
const recordContext = {
  session: { sessionId: 'session-1', agentSessionId: null, workingDirectory: '', gitContext: null },
  settings: {},
  statusBar: {},
} as unknown as IpcContext

function installHost(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      solus: {
        metricsSchema: async () => ({ views: [] }),
        metricsListSavedQueries: async () => [],
        getSessionInfo: async (sessionId: string) => ({ sessionId, customTitle: sessionTitles.get(sessionId) ?? null }),
        metricsCompileNl: async (_ctx: unknown, question: string) => {
          compiledQuestions.push(question)
          return {
            sql: "SELECT model, COUNT(*) AS turns FROM turns WHERE started_at > (strftime('%s','now') * 1000 - 86400000) GROUP BY model ORDER BY turns DESC",
            ok: true,
            attempts: 1,
          }
        },
        metricsTurnPage: async (request: MetricsTurnPageRequest): Promise<MetricsTurnPageResult> => {
          pageRequests.push(request)
          return {
            page: turnResult(available),
            pageIndex: request.pageIndex,
            pageSize: request.pageSize,
            totalRows: available.length,
            statusCounts: { ok: 0, error: available.length, interrupted: 0 },
            stats: { counted: available.length, failed: available.length, failureRate: 1, totalCostUsd: 0, p50DurationMs: 10, p95DurationMs: 10 },
            volume: [],
          }
        },
        metricsQuery: async (_spec: MetricsQuerySpec) => {
          return turnResult(available)
        },
        metricsRunSql: async (sql: string) => {
          sqlRuns.push(sql)
          return turnResult(available)
        },
        listTurnSnapshots: async (_ctx: IpcContext) => {
          return snapshots
        },
        diff: async (_ctx: IpcContext, request: DiffRequest) => {
          diffRequests.push(request)
          return { patch: `patch for ${request.scope.kind === 'turn' ? request.scope.index : '?'}` }
        },
      },
    },
  })
}

function installStateRune(): void {
  const state = Object.assign(<T>(value: T) => value, {
    snapshot: <T>(value: T) => value,
    raw: <T>(value: T) => value,
  })
  ;(globalThis as unknown as { $state: unknown }).$state = state
}

beforeEach(() => {
  sqlRuns = []
  compiledQuestions = []
  pageRequests = []
  available = ['trace-old']
  sessionTitles = new Map()
  snapshots = []
  diffRequests = []
  installStateRune()
  installHost()
})

afterEach(() => {
  serverConnectionsMock.reset()
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

describe('Insights window refresh', () => {
  test('re-asks the question whenever the histogram is re-read', async () => {
    // WHY: the histogram and the list under it must describe the same window.
    // Advancing the chart alone showed a failed turn as a bar with no row
    // beneath it to explain — the list still held the pre-failure answer.
    const { InsightsStore } = await import('@solus/workspace-ui/components/insights/insights.store.svelte')
    const store = new InsightsStore()
    store.useHost('local')

    await store.load()
    expect(store.result?.rows.length).toBe(1)

    available = ['trace-new', 'trace-old']
    await store.refresh()

    expect(pageRequests).toHaveLength(2)
    expect(store.volumeRows.length).toBe(2)
    expect(store.result?.rows.length).toBe(2)
  })

  test('a refresh re-runs the question on screen, not the default query', async () => {
    // WHY: refreshing must not silently replace what the user asked with the
    // default explore query — the answer would change without them asking.
    const { InsightsStore } = await import('@solus/workspace-ui/components/insights/insights.store.svelte')
    const store = new InsightsStore()
    store.useHost('local')

    await store.load()
    const question = 'select trace_id from turns where status = \'error\''
    await store.runSql(question)
    await store.refresh()

    expect(sqlRuns.at(-1)).toBe(question)
  })

  test('moving the range rewrites Solus’s own query but never the user’s', async () => {
    // WHY: the time filter owns the statements Solus wrote — the explore query
    // and the preset chips — so the list and the histogram describe the same
    // window. SQL the user typed is theirs: a filter that edits someone's query
    // behind their back is worse than one that admits it cannot.
    const { InsightsStore } = await import('@solus/workspace-ui/components/insights/insights.store.svelte')
    const store = new InsightsStore()
    store.useHost('local')
    await store.load()

    await store.setRange({ kind: 'absolute', from: 1_000, to: 2_000 })
    expect(store.sqlText).toContain('started_at >= 1000 and started_at < 2000')
    expect(pageRequests.at(-1)?.timeRange).toEqual({ from: 1_000, to: 2_000 })
    expect(store.answerWindowStale).toBe(false)

    const own = "select trace_id from turns where status = 'error'"
    store.setUserSql(own)
    await store.runSql(own)
    await store.setRange({ kind: 'relative', ms: 60_000 })

    expect(store.sqlText).toBe(own)
    expect(sqlRuns.at(-1)).toBe(own)
    // The histogram moved and the answer could not, so the surface says so.
    expect(store.answerWindowStale).toBe(true)
  })

  test('moving the range updates and reruns compiled NL SQL without another model call', async () => {
    // WHY: NLP authors the query once. The time filter owns the exact range
    // predicate it requested and must update that SQL locally.
    const { InsightsStore } = await import('@solus/workspace-ui/components/insights/insights.store.svelte')
    const store = new InsightsStore()
    store.useHost('local')

    // SAFETY: this host mock ignores the renderer context argument.
    await store.compileAndRun(null as never, 'turn count by model')
    await store.setRange({ kind: 'absolute', from: 1_000, to: 2_000 })

    expect(compiledQuestions).toHaveLength(1)
    expect(sqlRuns).toHaveLength(2)
    expect(sqlRuns.at(-1)).toContain('started_at >= 1000 and started_at < 2000')
    expect(store.sqlText).toBe(sqlRuns.at(-1) ?? '')
    expect(store.answerWindowStale).toBe(false)
  })

  test('the histogram is read over the selected window', async () => {
    // WHY: the chart's own query is independent of the question, so the range
    // is the only thing that can move it.
    const { InsightsStore } = await import('@solus/workspace-ui/components/insights/insights.store.svelte')
    const store = new InsightsStore()
    store.useHost('local')
    await store.load()

    await store.setRange({ kind: 'absolute', from: 1_000, to: 2_000 })

    expect(store.windowFrom).toBe(1_000)
    expect(store.windowTo).toBe(2_000)
    expect(pageRequests.at(-1)?.timeRange).toEqual({ from: 1_000, to: 2_000 })
  })

  test('the opening load says it is busy before the first statement runs', async () => {
    // WHY: the registry and the saved queries are read before any statement, so
    // `running` is still false across those round trips. The page gated its
    // loading cover on `running` alone and painted a real empty listing in the
    // gap — the reader saw a skeleton, an empty page, then a skeleton again.
    const { InsightsStore } = await import('@solus/workspace-ui/components/insights/insights.store.svelte')
    const store = new InsightsStore()
    store.useHost('local')

    let releaseSchema: () => void = () => {}
    const held = new Promise<void>((resolve) => (releaseSchema = resolve))
    const solus = (globalThis.window as unknown as { solus: { metricsSchema: () => Promise<unknown> } }).solus
    solus.metricsSchema = async () => {
      await held
      return { views: [] }
    }

    const loading = store.load()
    expect(store.bootstrapping).toBe(true)
    expect(store.running).toBe(false)
    expect(store.result).toBe(null)

    releaseSchema()
    await loading

    expect(store.bootstrapping).toBe(false)
    expect(store.result?.rows.length).toBe(1)
  })

  test('leaving the page drops the visit, so the next entry asks the default question', async () => {
    // WHY: the store outlives the surface, so a closed and reopened page used to
    // resume the previous visit's answer, editor text, and run history. Entering
    // Insights must state what the host is doing now, not what was asked last.
    const { InsightsStore } = await import('@solus/workspace-ui/components/insights/insights.store.svelte')
    const store = new InsightsStore()
    store.useHost('local')
    await store.load()

    await store.setRange({ kind: 'absolute', from: 1_000, to: 2_000 })
    const own = "select trace_id from turns where status = 'error'"
    store.form = 'sql'
    store.setUserSql(own)
    await store.runSql(own)
    expect(store.history.length).toBeGreaterThan(0)

    store.reset()

    expect(store.form).toBe('nl')
    expect(store.result).toBe(null)
    expect(store.history).toEqual([])
    expect(store.sqlText).not.toBe(own)
    // The window is a stated preference, not this visit's state.
    expect(store.range).toEqual({ kind: 'absolute', from: 1_000, to: 2_000 })
    expect(store.sqlText).toContain('started_at >= 1000 and started_at < 2000')

    // The re-entry re-asks Solus's own statement rather than the closed one.
    await store.load()
    expect(pageRequests.at(-1)?.timeRange).toEqual({ from: 1_000, to: 2_000 })
    expect(store.result?.rows).toEqual(turnResult(available).rows)
  })

  test('the reset lands in the question tab with an empty field', async () => {
    // WHY: Reset ends the question that was asked. Landing in the SQL tab left
    // the reader in the statement the default happens to be written as, with
    // the answered question still in the Ask field waiting to be re-run.
    const { InsightsStore } = await import('@solus/workspace-ui/components/insights/insights.store.svelte')
    const store = new InsightsStore()
    store.useHost('local')
    await store.load()

    store.form = 'sql'
    store.question = 'which sessions were slowest?'

    await store.resetToDefault()

    expect(store.form).toBe('nl')
    expect(store.question).toBe('')
    expect(pageRequests).toHaveLength(2)
    expect(store.result?.rows).toEqual(turnResult(available).rows)

    // A generated query shown from elsewhere still lands where it can be read.
    await store.runGenerated({ kind: 'session', sessionId: 'session-1' })
    expect(store.form).toBe('sql')
  })

  test('a turn starting or ending on the host re-reads the listing in place', async () => {
    // WHY: the listing is live by event, not by polling. A running turn must
    // appear, and a finished one must stop saying "Running", without the reader
    // pressing refresh — and without the page flashing its loading state.
    const { InsightsStore } = await import('@solus/workspace-ui/components/insights/insights.store.svelte')
    const store = new InsightsStore()
    store.useHost('local')
    await store.load()
    const stop = store.watchTurns()
    jest.useFakeTimers()
    try {
      available = ['trace-live', 'trace-old']
      // Two turns that change together cause one read.
      announceTurn('local', { traceId: 'trace-live', sessionId: 'session-1', status: 'unknown' })
      announceTurn('local', { traceId: 'trace-old', sessionId: 'session-1', status: 'ok' })
      // Another host's turns are another database.
      announceTurn('remote', { traceId: 'trace-far', sessionId: null, status: 'unknown' })
      jest.advanceTimersByTime(1_000)
      expect(store.running).toBe(false)
      await Promise.resolve()
      await Promise.resolve()
    } finally {
      jest.useRealTimers()
      stop()
    }
    expect(pageRequests).toHaveLength(2)
    expect(store.result?.rows.length).toBe(2)
  })

  test('a turn with no task is listed under its session name, and follows a rename', async () => {
    // WHY: a session with no task showed as a bare short id, which reads as
    // noise. A new session is named only after its first turn, so the name the
    // listing asked for too early must still arrive.
    const { InsightsStore } = await import('@solus/workspace-ui/components/insights/insights.store.svelte')
    const store = new InsightsStore()
    store.useHost('local')
    await store.load()
    await Promise.resolve()
    expect(store.sessionName('session-1')).toBeNull()

    const stop = store.watchTurns()
    try {
      announceTitle('local', { sessionId: 'session-1', title: 'Fix the flaky test', source: 'generated' })
      expect(store.sessionName('session-1')).toBe('Fix the flaky test')
      // A session this page never listed is not read into the cache.
      announceTitle('local', { sessionId: 'session-9', title: 'Elsewhere', source: 'generated' })
      expect(store.sessionName('session-9')).toBeNull()
    } finally {
      stop()
    }
  })

  test('a turn event never re-runs SQL the user wrote', async () => {
    // WHY: the user's statement can be expensive, and re-running it unasked
    // would change the answer under them.
    const { InsightsStore } = await import('@solus/workspace-ui/components/insights/insights.store.svelte')
    const store = new InsightsStore()
    store.useHost('local')
    await store.load()
    const own = "select trace_id from turns where status = 'error'"
    store.setUserSql(own)
    await store.runSql(own)
    const stop = store.watchTurns()
    jest.useFakeTimers()
    try {
      announceTurn('local', { traceId: 'trace-live', sessionId: 'session-1', status: 'unknown' })
      jest.advanceTimersByTime(1_000)
    } finally {
      jest.useRealTimers()
      stop()
    }
    expect(sqlRuns).toEqual([own])
    expect(pageRequests).toHaveLength(1)
  })

  test('an NL compile enters the editor and executor as formatted SQL', async () => {
    // WHY: generated SQL is the editable explanation of the answer. A dense
    // agent response is hard to audit even when the database can execute it.
    const { InsightsStore } = await import('@solus/workspace-ui/components/insights/insights.store.svelte')
    const store = new InsightsStore()
    store.useHost('local')

    // SAFETY: this host mock ignores the renderer context argument.
    await store.compileAndRun(null as never, 'turn count by model')

    expect(store.sqlText).toContain('select\n  model,')
    expect(store.compiledSql).toBe(store.sqlText)
    expect(sqlRuns.at(-1)).toBe(store.sqlText)
  })
})

describe('what a turn changed', () => {
  // WHY: a snapshot's index counts snapshots, not turns. A turn that skipped its
  // snapshot shifts every later index, so opening the Nth snapshot for the Nth
  // turn shows another turn's change. The trace id is the only exact join.
  test('reads the diff of the snapshot that carries the trace, whatever its index', async () => {
    const { InsightsStore } = await import('@solus/workspace-ui/components/insights/insights.store.svelte')
    const store = new InsightsStore()
    store.useHost('local')
    snapshots = [snapshot(0, 'trace-1'), snapshot(1, 'trace-3')]

    await store.loadTurnChange(recordContext, 'trace-3')

    expect(diffRequests).toEqual([{ scope: { kind: 'turn', index: 1 } }])
    expect(store.turnChange('trace-3')).toMatchObject({ status: 'ready', patch: 'patch for 1' })
  })

  test('a turn with no snapshot of its own is missing, and a turn with no file change reads no diff', async () => {
    const { InsightsStore } = await import('@solus/workspace-ui/components/insights/insights.store.svelte')
    const store = new InsightsStore()
    store.useHost('local')
    snapshots = [snapshot(0, undefined), snapshot(1, 'trace-quiet', 0)]

    await store.loadTurnChange(recordContext, 'trace-old')
    await store.loadTurnChange(recordContext, 'trace-quiet')

    expect(store.turnChange('trace-old')).toEqual({ status: 'missing' })
    expect(store.turnChange('trace-quiet')).toMatchObject({ status: 'ready', patch: '' })
    expect(diffRequests).toEqual([])
  })

  test('a turn read while it ran is read again once the host announces it', async () => {
    const { InsightsStore } = await import('@solus/workspace-ui/components/insights/insights.store.svelte')
    const store = new InsightsStore()
    store.useHost('local')
    const stop = store.watchTurns()

    await store.loadTurnChange(recordContext, 'trace-live')
    expect(store.turnChange('trace-live')).toEqual({ status: 'missing' })

    snapshots = [snapshot(0, 'trace-live')]
    announceTurn('local', { traceId: 'trace-live', sessionId: 'session-1' } as TurnsChanged)
    await store.loadTurnChange(recordContext, 'trace-live')

    expect(store.turnChange('trace-live')).toMatchObject({ status: 'ready' })
    stop()
  })
})
