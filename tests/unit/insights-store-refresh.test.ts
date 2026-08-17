import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { MetricsQueryResult } from '../../src/shared/observability-types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const serverConnectionsMock = singleHostServerConnections()
mock.module('@client-core/server-connections', () => ({
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
let available: string[] = []

function installHost(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      solus: {
        metricsSchema: async () => ({ views: [] }),
        metricsListSavedQueries: async () => [],
        metricsQuery: async () => {
          volumeRuns++
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
    const { InsightsStore } = await import('../../src/renderer/components/insights/insights.store.svelte')
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
    const { InsightsStore } = await import('../../src/renderer/components/insights/insights.store.svelte')
    const store = new InsightsStore()
    store.useHost('local')

    await store.load()
    const question = 'select trace_id from turns where status = \'error\''
    await store.runSql(question)
    await store.refresh()

    expect(sqlRuns.at(-1)).toBe(question)
  })
})
