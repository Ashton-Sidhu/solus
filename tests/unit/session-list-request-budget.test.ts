import { describe, expect, test } from 'bun:test'
import { WorkspaceRequestError } from '@solus/contracts/solus-api/client'
import type { SessionRecord } from '@solus/contracts/types'
import { workspaceRecordMethods } from '@solus/client-core/workspace-records'
import { ThreadDirectory } from '../../apps/mobile/src/features/threads/thread-directory'

// A host's Solus API allows each person a budget of requests. A session list
// must cost a few requests at any history size, and a list the client already
// shows must not turn into an error while the budget refills.

interface ListQuery { limit: number; cursor?: string; order?: 'created' | 'activity' }

/** A host with `count` sessions; session `s<n>` started at n and was last active at 2n. */
function fakeHost(count: number, options: { knowsOrder: boolean }) {
  const queries: ListQuery[] = []
  const session = (n: number) => ({
    id: `s${n}`, createdAt: new Date(n).toISOString(), updatedAt: new Date(n * 2).toISOString(),
    provider: 'codex', projectPath: '-p', parentSessionId: null, rootSessionId: null,
  })
  const client = {
    async request(_operation: 'listSessions', input: { query: ListQuery }) {
      queries.push(input.query)
      if (input.query.order && !options.knowsOrder) throw new WorkspaceRequestError(400, 'INVALID_REQUEST', 'Invalid request.')
      const start = input.query.cursor ? Number(input.query.cursor) : 0
      const end = Math.min(start + input.query.limit, count)
      const items = Array.from({ length: end - start }, (_, i) => session(count - start - i))
      return { items, nextCursor: end < count ? String(end) : null, indexing: false }
    },
  }
  const records = workspaceRecordMethods(client as never, async () => ({}) as never)
  return { records, queries }
}

describe('session record list', () => {
  test('reads only the pages that hold the newest sessions', async () => {
    const host = fakeHost(4_000, { knowsOrder: true })
    const list = await host.records.sessionRecordList({ limit: 500 })
    expect(host.queries).toHaveLength(3)
    expect(host.queries.every((query) => query.order === 'activity')).toBe(true)
    expect(list.records).toHaveLength(500)
    expect(list.records[0].sessionId).toBe('s4000')
  })

  test('reads every page of a host older than activity order', async () => {
    const host = fakeHost(450, { knowsOrder: false })
    const list = await host.records.sessionRecordList({ limit: 100 })
    // One refused request, then every creation-ordered page.
    expect(host.queries.map((query) => query.order)).toEqual(['activity', undefined, undefined, undefined])
    expect(list.records).toHaveLength(100)
    expect(list.records[0].sessionId).toBe('s450')
  })
})

describe('native directory: request budget', () => {
  test('a refused read keeps the list and reads again after the wait the host asks for', async () => {
    const record = (sessionId: string) => ({ sessionId, parentSessionId: null, lastActivityAt: 1, projectPath: '/p' }) as SessionRecord
    let refusals = 0
    const connection = {
      state: { sessionGeneration: 0 },
      api: {
        sessionRecordList: async () => {
          if (refusals > 0) {
            refusals--
            throw new WorkspaceRequestError(429, 'RATE_LIMITED', 'The request budget is exhausted. Try again shortly.', 0.01)
          }
          return { records: [record('a'), record('b')], indexing: false }
        },
        listProjects: async () => [],
      },
    }
    const registry = { host: () => ({ id: 'h', label: 'Mac' }), hosts: () => [{ id: 'h', label: 'Mac' }] }
    const directory = new ThreadDirectory(registry as never, () => connection as never)
    await directory.load('h')

    refusals = 1
    await directory.load('h')
    expect(directory.stateOf('h').kind).toBe('loading')
    expect(directory.threads()).toHaveLength(2)

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(directory.stateOf('h').kind).toBe('loaded')
  })

  test('a host that stays over its budget shows the error with the list it had', async () => {
    const connection = {
      state: { sessionGeneration: 0 },
      api: {
        sessionRecordList: async () => { throw new WorkspaceRequestError(429, 'RATE_LIMITED', 'The request budget is exhausted. Try again shortly.', 0.01) },
        listProjects: async () => [],
      },
    }
    const registry = { host: () => ({ id: 'h', label: 'Mac' }), hosts: () => [{ id: 'h', label: 'Mac' }] }
    const directory = new ThreadDirectory(registry as never, () => connection as never)
    await directory.load('h')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(directory.stateOf('h').kind).toBe('error')
  })
})
