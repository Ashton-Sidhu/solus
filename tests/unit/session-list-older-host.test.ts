import { expect, test } from 'bun:test'
import { WorkspaceRequestError } from '@solus/contracts/solus-api/client'
import { workspaceRecordMethods } from '@solus/client-core/workspace-records'

// A host older than the session list refuses `archived` and `roots`
// (docs/plans/session-archive.md). It archives nothing, so every session it has
// is in the list and none is archived.

interface ListQuery { archived?: string; roots?: string; order?: string }

function olderHost() {
  const queries: ListQuery[] = []
  const session = (id: string, parentSessionId: string | null) => ({
    id, createdAt: new Date(1).toISOString(), updatedAt: new Date(2).toISOString(),
    provider: 'codex', projectPath: '-p', parentSessionId, rootSessionId: parentSessionId,
  })
  const client = {
    async request(_operation: 'listSessions', input: { query: ListQuery }) {
      queries.push(input.query)
      if (input.query.archived || input.query.roots) throw new WorkspaceRequestError(400, 'INVALID_REQUEST', 'Invalid request.')
      return { items: [session('root', null), session('child', 'root')], nextCursor: null, indexing: false }
    },
  }
  return { records: workspaceRecordMethods(client as never, async () => ({}) as never), queries }
}

test('the list of an older host is every root session it has', async () => {
  const host = olderHost()
  const list = await host.records.sessionRecordList({ archived: false, roots: true })
  expect(list.records.map((record) => record.sessionId)).toEqual(['root'])
  expect(host.queries.map((query) => [query.archived, query.roots])).toEqual([['false', 'true'], [undefined, undefined]])
})

test('an older host has no archived session', async () => {
  const host = olderHost()
  expect((await host.records.sessionRecordList({ archived: true })).records).toEqual([])
})
