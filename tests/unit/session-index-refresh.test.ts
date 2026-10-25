import { afterEach, beforeAll, describe, expect, jest, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { ActivityLeases } from '@solus/server/execution/activity-leases'
import { refreshingSessionIndexOnList } from '@solus/server/transport/solus-api/session-index-refresh'
import type { WorkspaceOperations } from '@solus/server/data/workspace/operations'

mock.module('node:sqlite', () => ({ DatabaseSync }))

let CodexBackend: typeof import('@solus/server/execution/agents/codex/codex-backend')['CodexBackend']
beforeAll(async () => {
  ;({ CodexBackend } = await import('@solus/server/execution/agents/codex/codex-backend'))
})
afterEach(() => jest.useRealTimers())

type BackendInternals = {
  client: { hasStarted: boolean }
  sessionIndexRefreshTimer: ReturnType<typeof setTimeout> | null
  refreshSessionIndexOnce: () => Promise<void>
}

function codexBackend(hasStarted: boolean) {
  const backend = new CodexBackend()
  const internals = backend as unknown as BackendInternals
  internals.client = { hasStarted }
  let sweeps = 0
  internals.refreshSessionIndexOnce = async () => { sweeps++ }
  return { backend, internals, sweeps: () => sweeps }
}

// WHY: the index of sessions started in the Codex CLI was kept current by a
// 60 s poll that woke an idle host for nothing. It now follows events: a
// client that connects, comes to the front, or reads its list.
describe('session index refresh', () => {
  test('nothing is armed while no one asks', () => {
    jest.useFakeTimers()
    const { internals, sweeps } = codexBackend(true)
    jest.advanceTimersByTime(10 * 60_000)
    expect(internals.sessionIndexRefreshTimer).toBeNull()
    expect(sweeps()).toBe(0)
  })

  test('three requests in one window cost one thread/list sweep', async () => {
    jest.useFakeTimers()
    const { backend, sweeps } = codexBackend(true)
    backend.requestSessionIndexRefresh()
    backend.requestSessionIndexRefresh()
    jest.advanceTimersByTime(1_000)
    backend.requestSessionIndexRefresh()
    jest.advanceTimersByTime(1_000)
    await Promise.resolve()
    expect(sweeps()).toBe(1)

    // The next window pays for its own sweep.
    backend.requestSessionIndexRefresh()
    jest.advanceTimersByTime(2_000)
    await Promise.resolve()
    expect(sweeps()).toBe(2)
  })

  test('a Codex client that has not started is not started to refresh', async () => {
    // WHY: a Claude-only host must not become a two-process Codex host.
    jest.useFakeTimers()
    const { backend, internals, sweeps } = codexBackend(false)
    backend.requestSessionIndexRefresh()
    expect(internals.sessionIndexRefreshTimer).toBeNull()
    jest.advanceTimersByTime(2_000)
    await Promise.resolve()
    expect(sweeps()).toBe(0)
  })

  test('a session list read asks once per read; its next pages do not ask again', async () => {
    let requests = 0
    const operations = refreshingSessionIndexOnList({
      listSessions: async () => ({ items: [], nextCursor: null, indexing: false }),
      searchSessions: async () => ({ items: [] }),
    } as unknown as WorkspaceOperations, () => { requests++ })
    const context = {} as Parameters<WorkspaceOperations['listSessions']>[0]

    await operations.listSessions(context, { scope: 'list', limit: 50 })
    expect(requests).toBe(1)
    await operations.listSessions(context, { scope: 'list', limit: 50, cursor: 'next' })
    expect(requests).toBe(1)
    await operations.searchSessions(context, { q: 'codex' } as Parameters<WorkspaceOperations['searchSessions']>[1])
    expect(requests).toBe(2)
  })

  test('a client comes to the front once per return, not on each heartbeat', () => {
    const leases = new ActivityLeases()
    expect(leases.report('client-a', true, 1_000)).toBe(true)
    expect(leases.report('client-a', true, 11_000)).toBe(false)
    expect(leases.report('client-a', false, 12_000)).toBe(false)
    expect(leases.report('client-a', true, 13_000)).toBe(true)
    // A lease that ran out is a return too: the client stopped beating.
    expect(leases.report('client-a', true, 40_000)).toBe(true)
    // Another client's return is its own.
    expect(leases.report('client-b', true, 40_000)).toBe(true)
  })
})
