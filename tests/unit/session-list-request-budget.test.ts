import { describe, expect, test } from 'bun:test'
import { WorkspaceRequestError } from '@solus/contracts/solus-api/client'
import type { SessionRecord, SessionRecordListFilter } from '@solus/contracts/types'
import { workspaceRecordMethods } from '@solus/client-core/workspace-records'
import { ThreadDirectory } from '../../apps/mobile/solus-core/features/threads/thread-directory'

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
  const records = workspaceRecordMethods(client as never)
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

  test('publishes the newest page before requesting the remaining sessions', async () => {
    const host = fakeHost(450, { knowsOrder: true })
    const pages: string[][] = []
    const list = await host.records.sessionRecordList({}, page => {
      expect(host.queries).toHaveLength(1)
      pages.push(page.records.map(record => record.sessionId))
    })
    expect(pages).toEqual([list.records.slice(0, 32).map(record => record.sessionId)])
    expect(host.queries.map(query => query.limit)).toEqual([32, 200, 200, 200])
    expect(list.records).toHaveLength(450)
    expect(new Set(list.records.map(record => record.sessionId)).size).toBe(450)
  })

  test('an older host finishes sorting its history before publishing any rows', async () => {
    const host = fakeHost(450, { knowsOrder: false })
    let partialReads = 0
    const list = await host.records.sessionRecordList({}, () => { partialReads++ })
    expect(partialReads).toBe(0)
    expect(list.records).toHaveLength(450)
    expect(list.records[0].sessionId).toBe('s450')
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
  test('publishes projects, codebases and pinned rows before reading older sessions', async () => {
    const record = (sessionId: string) => ({ sessionId, codebaseId: 'cb', lastActivityAt: 1 }) as SessionRecord
    const host = { id: 'h', label: 'Mac' }
    const registry = { host: () => host, hosts: () => [host] }
    const reads: string[] = []
    const connection = { state: { sessionGeneration: 1 }, api: {
      sessionRecordList: async (filter: SessionRecordListFilter) => {
        reads.push(filter.scope ?? 'list')
        expect(directory.threads().map(row => row.record.sessionId)).toEqual(['a', 'p'])
        expect(directory.projects()[0]?.project.path).toBe('/project')
        expect(directory.openingCodebase('h', 'cb')?.name).toBe('Platform')
        return { records: [], indexing: false }
      },
    } }
    const directory = new ThreadDirectory(registry as never, () => connection as never)
    const opening = { records: [record('a')], pinnedRecords: [record('p')], indexing: false, nextCursor: null,
      projects: [{ path: '/project' }], codebases: [{ id: 'cb', name: 'Platform', updatedAt: 1, deletedAt: null, roots: [{ installationId: 'h', path: '/src', name: 'src', container: true }] }], pins: [], automations: [], attention: [] }
    await directory.load('h', 0, 'all', Promise.resolve(opening) as never)
    expect(directory.stateOf('h').kind).toBe('loaded')
    expect(reads).toEqual(['all'])
  })

  test('a refused read keeps the list and reads again after the wait the host asks for', async () => {
    const record = (sessionId: string) => ({ sessionId, parentSessionId: null, lastActivityAt: 1, projectPath: '/p' }) as SessionRecord
    let refusals = 0
    const connection = {
      state: { sessionGeneration: 0 },
      api: {
        sessionRecordList: async (filter: SessionRecordListFilter) => {
          if (refusals > 0) {
            refusals--
            throw new WorkspaceRequestError(429, 'RATE_LIMITED', 'The request budget is exhausted. Try again shortly.', 0.01)
          }
          return { records: filter.scope === 'all' ? [] : [record('a'), record('b')], indexing: false }
        },
        listProjects: async () => [],
        pinnedSessionsList: async () => [],
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

  test('the list is read whole; recent sessions out of it are read apart and open by id', async () => {
    // WHY: the host bounds a person's list (docs/plans/session-archive.md). A
    // count limit would drop sessions and, with them, their shelves.
    const record = (sessionId: string, lastActivityAt: number) => ({ sessionId, parentSessionId: null, lastActivityAt, projectPath: '/p' }) as SessionRecord
    const filters: SessionRecordListFilter[] = []
    const connection = {
      state: { sessionGeneration: 0 },
      api: {
        sessionRecordList: async (filter: SessionRecordListFilter) => {
          filters.push(filter)
          return { records: filter.scope === 'all' ? [{ ...record('old', 1), listed: false }, { ...record('a', 2), listed: true }] : [record('a', 2)], indexing: false }
        },
        listProjects: async () => [],
        pinnedSessionsList: async () => [],
      },
    }
    const registry = { host: () => ({ id: 'h', label: 'Mac' }), hosts: () => [{ id: 'h', label: 'Mac' }] }
    const directory = new ThreadDirectory(registry as never, () => connection as never)
    await directory.load('h')
    expect(filters).toEqual([{ includeWorktrees: true }, { includeWorktrees: true, scope: 'all', limit: 200 }])
    expect(directory.threads().map((thread) => thread.record.sessionId)).toEqual(['a'])
    expect(directory.unlistedThreads().map((thread) => thread.record.sessionId)).toEqual(['old'])
    expect(directory.thread('h', 'old')?.record.sessionId).toBe('old')
  })

  test('a host that stays over its budget shows the error with the list it had', async () => {
    const connection = {
      state: { sessionGeneration: 0 },
      api: {
        sessionRecordList: async () => { throw new WorkspaceRequestError(429, 'RATE_LIMITED', 'The request budget is exhausted. Try again shortly.', 0.01) },
        listProjects: async () => [],
        pinnedSessionsList: async () => [],
      },
    }
    const registry = { host: () => ({ id: 'h', label: 'Mac' }), hosts: () => [{ id: 'h', label: 'Mac' }] }
    const directory = new ThreadDirectory(registry as never, () => connection as never)
    await directory.load('h')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(directory.stateOf('h').kind).toBe('error')
  })
})

describe('native directory: reads after a session event', () => {
  test('a sessions read keeps the projects and pins of the last whole read', async () => {
    // WHY: every status, title, and share event on a host read its whole
    // list again: two record lists, the projects, and the pins. Those events
    // change only session records, so a sessions read sends the two record
    // lists alone, and still shows the pinned session out of recent history.
    const record = (sessionId: string) => ({ sessionId, parentSessionId: null, lastActivityAt: 1, projectPath: '/p' }) as SessionRecord
    const reads: string[] = []
    const connection = {
      state: { sessionGeneration: 0 },
      api: {
        sessionRecordList: async (filter: SessionRecordListFilter) => {
          reads.push(filter.scope === 'all' ? 'unlisted' : 'list')
          return { records: filter.scope === 'all' ? [] : [record('a')], indexing: false }
        },
        listProjects: async () => { reads.push('projects'); return [] },
        sessionRecordGet: async (sessionId: string) => { reads.push('pinned record'); return record(sessionId) },
      },
    }
    const registry = { host: () => ({ id: 'h', label: 'Mac' }), hosts: () => [{ id: 'h', label: 'Mac' }] }
    const readPins = async () => { reads.push('pins'); return [{ sessionId: 'old', serverId: 'h', provider: 'codex' as const, title: 'Old', cwd: '/p', pinnedAt: 1 }] }
    const directory = new ThreadDirectory(registry as never, () => connection as never, undefined, undefined, readPins)
    await directory.load('h')
    expect(reads.sort()).toEqual(['list', 'pinned record', 'pins', 'projects', 'unlisted'])

    reads.length = 0
    await directory.load('h', 0, 'sessions')
    expect(reads.sort()).toEqual(['list', 'pinned record', 'unlisted'])
    expect(directory.unlistedThreads().map((thread) => thread.record.sessionId)).toEqual(['old'])
  })

  test('a sessions read before any whole read reads everything', async () => {
    const reads: string[] = []
    const connection = {
      state: { sessionGeneration: 0 },
      api: {
        sessionRecordList: async () => { reads.push('list'); return { records: [], indexing: false } },
        listProjects: async () => { reads.push('projects'); return [] },
      },
    }
    const registry = { host: () => ({ id: 'h', label: 'Mac' }), hosts: () => [{ id: 'h', label: 'Mac' }] }
    const directory = new ThreadDirectory(registry as never, () => connection as never, undefined, undefined, async () => { reads.push('pins'); return [] })
    await directory.load('h', 0, 'sessions')
    expect(reads.sort()).toEqual(['list', 'list', 'pins', 'projects'])
  })
})
