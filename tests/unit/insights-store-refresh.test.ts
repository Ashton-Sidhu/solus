import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { MetricsQueryResult, MetricsQuerySpec } from '@solus/contracts/observability-types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const serverConnectionsMock = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: serverConnectionsMock,
}))

const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state

/** Turn rows the histogram and the list both read, newest first. */
function turnResult(traceIds: string[]): MetricsQueryResult {
  return {
    columns: ['trace_id', 'span_id', 'session_id', 'started_at', 'duration_ms', 'status'],
    rows: traceIds.map((traceId, index) => [traceId, traceId, 'session-1', 1_700_000_000_000 + index, 10, 'error']),
    sourceView: 'turns',
  }
}

let sqlRuns: string[] = []
let volumeRuns = 0
let volumeSpecs: MetricsQuerySpec[] = []
let available: string[] = []

function installHost(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      solus: {
        metricsSchema: async () => ({ views: [] }),
        metricsListSavedQueries: async () => [],
        metricsCompileNl: async () => ({
          sql: 'SELECT model, COUNT(*) AS turns FROM turns GROUP BY model ORDER BY turns DESC',
          ok: true,
          attempts: 1,
        }),
        metricsQuery: async (spec: MetricsQuerySpec) => {
          volumeRuns++
          volumeSpecs.push(spec)
          return turnResult(available)
        },
        metricsRunSql: async (sql: string) => {
          sqlRuns.push(sql)
          return turnResult(available)
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
  volumeRuns = 0
  volumeSpecs = []
  available = ['trace-old']
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

    expect(volumeRuns).toBe(2)
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
    expect(sqlRuns.at(-1)).toBe(store.sqlText)
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
    expect(volumeSpecs.at(-1)?.timeRange).toEqual({ from: 1_000, to: 2_000 })
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
    expect(sqlRuns.at(-1)).toBe(store.sqlText)
    expect(sqlRuns.at(-1)).not.toBe(own)
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
