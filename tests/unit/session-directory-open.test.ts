import { expect, test } from 'bun:test'
import { workspaceSessionQuerySchema } from '@solus/contracts/solus-api'
import { SessionApiOperations } from '@solus/server/data/sessions/api-operations'
import { upsertSessionRecord } from '@solus/server/data/sessions/session-records'
import { togglePinnedSession } from '@solus/server/data/sessions/pinned-sessions'
import { registerPinnedSessionsHandlers } from '@solus/server/transport/handlers/pinned-sessions-handlers'
import { registerSessionDirectoryHandler } from '@solus/server/transport/handlers/session-directory-handler'
import { SolusServer } from '@solus/server/transport/server'
import { hostUserKey } from '@solus/server/host/host-user'
import { ShareManager } from '@solus/server/sharing/share-manager'
import { getDatabase } from '@solus/server/db/database'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'
import { MobileSessionCache } from '../../apps/mobile/solus-core/features/threads/session-cache'
import { ThreadDirectory } from '../../apps/mobile/solus-core/features/threads/thread-directory'
import { memoryPullRequestCacheDatabase, PullRequestCache } from '@solus/client-core/pull-request-cache'

test('one opening response supplies the first 32 rows and older pins, and restores their badges offline', async () => {
  const now = Date.now()
  const personKey = hostUserKey()
  for (let index = 0; index < 45; index++) {
    await upsertSessionRecord('local', {
      sessionId: 'startup-' + index, provider: 'codex', projectPath: '/app', lastActivityAt: now - index,
      codebaseId: 'platform', startedBy: { kind: 'person', personKey },
    }, { organizationId: 'local', ownerKey: personKey })
  }
  for (let index = 32; index < 44; index++) await togglePinnedSession(personKey, { sessionId: 'startup-' + index, pinnedAt: now })
  await togglePinnedSession('user:another', { sessionId: 'startup-44', pinnedAt: now })
  const server = new SolusServer()
  const sessions = new SessionApiOperations(new ShareManager({ db: getDatabase() }))
  const queries: string[] = []
  server.register('solusApiRequest', async ([request], caller) => {
    expect(caller.principal).toBe(TEST_HANDLER_CTX.principal)
    const url = new URL(request.path, 'http://test')
    expect(url.pathname).toBe('/sessions')
    const query = workspaceSessionQuerySchema.parse(Object.fromEntries(url.searchParams))
    queries.push(query.scope)
    const page = await sessions.list({ principal: caller.principal, home: { kind: 'local', hostId: 'test' }, scopes: ['sessions:read'] }, query)
    return { status: 200, body: JSON.stringify(page), etag: null, retryAfter: null }
  })
  server.register('listProjects', () => [])
  server.register('codebaseList', () => [{ id: 'platform', name: 'Platform', roots: [{ installationId: 'machine', path: '/app', name: 'app', container: true }], updatedAt: now, deletedAt: null }])
  server.register('listAttention', () => [])
  server.register('automationList', () => [])
  registerPinnedSessionsHandlers(server)
  const warmed: string[][] = []
  registerSessionDirectoryHandler(server, { warm: async (sessionIds) => { warmed.push([...sessionIds]) } })
  const opening = await server.handle('sessionDirectoryOpen', [], TEST_HANDLER_CTX)
  if ('error' in opening) throw new Error(opening.error.message)
  // The host reads ahead the sessions the person sees first, newest first.
  expect(warmed).toEqual([opening.records.map(row => row.sessionId)])
  expect(queries).toEqual(['list', 'pinned'])
  expect(opening.records).toHaveLength(32)
  expect(opening.pinnedRecords).toHaveLength(12)
  expect(opening.pinnedRecords.some(row => row.sessionId === 'startup-44')).toBe(false)
  expect(opening.nextCursor).toBeTruthy()

  const cache = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => 'account')
  const host = { id: 'h', label: 'Machine' }
  const registry = { host: () => host, hosts: () => [host] }
  const connection = { state: { sessionGeneration: 1 }, api: { sessionRecordList: async () => ({ records: [], indexing: false }) } }
  const directory = new ThreadDirectory(registry as never, () => connection as never, undefined, undefined, undefined, cache)
  await directory.load('h', 0, 'all', Promise.resolve(opening))
  const offline = new ThreadDirectory(registry as never, () => null, undefined, undefined, undefined, cache)
  await offline.restore('h')
  expect(offline.threads()).toHaveLength(44)
  expect(offline.openingCodebase('h', 'platform')?.name).toBe('Platform')
})
