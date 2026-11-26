import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { HostEvent } from '@solus/contracts/host-events'
import { workspaceSessionQuerySchema } from '@solus/contracts/solus-api'
import type { SessionShellChanges, SessionShellOpenResult, SessionShellRow } from '@solus/contracts/session-shell'
import type { SessionRecord } from '@solus/contracts/types'
import { actorFor, ownerKeyOf } from '@solus/server/admission/actor'
import type { Principal } from '@solus/server/admission/principal'
import { SolusApiError } from '@solus/server/admission/workspace-error'
import { SessionApiOperations } from '@solus/server/data/sessions/api-operations'
import { togglePinnedSession } from '@solus/server/data/sessions/pinned-sessions'
import { upsertSessionRecord } from '@solus/server/data/sessions/session-records'
import { getDatabase } from '@solus/server/db/database'
import { hostUserKey } from '@solus/server/host/host-user'
import { eventResource, eventVisibleTo } from '@solus/server/sharing/event-audience'
import { ShareManager } from '@solus/server/sharing/share-manager'
import { SESSION_SHELL_COALESCE_MS, SESSION_SHELL_LOG_AGE_MS, SESSION_SHELL_LOG_LIMIT, SessionShell, sessionShellScopeKey, type SessionShellReads } from '@solus/server/transport/events/session-shell'
import { registerPinnedSessionsHandlers } from '@solus/server/transport/handlers/pinned-sessions-handlers'
import { registerSessionDirectoryHandler } from '@solus/server/transport/handlers/session-directory-handler'
import { registerSessionShellHandler, sessionShellReads } from '@solus/server/transport/handlers/session-shell-handler'
import { SolusServer, type CallerCtx } from '@solus/server/transport/server'
import { useActingIdentities } from '@solus/server/execution/seats/acting-identity'
import { installTestIdentities } from './helpers/acting-identities'

// A member's calls run as that member (plans/019-acting-identity.md).
beforeAll(() => { installTestIdentities() })
afterAll(() => { useActingIdentities(null) })

const OWNER: Principal = { kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Phone' }
const member = (userId: string): Principal => ({
  kind: 'org-member', userId, organizationId: 'org-shell', organizationRole: 'member', teamIds: [], hostKind: 'personal',
  displayName: userId, deviceId: `d-${userId}`, expiresAt: Date.now() + 3_600_000, deviceLabel: 'Phone',
})
const callerOf = (clientId: string, principal: Principal): CallerCtx => ({ clientId, principal })
const settle = () => new Promise(resolve => setTimeout(resolve, SESSION_SHELL_COALESCE_MS * 3))

/** A host with the handlers `sessionDirectoryOpen` reads, and the Solus API answered from this host's records for the calling principal. */
function hostServer(shares: ShareManager): SolusServer {
  const server = new SolusServer()
  const sessions = new SessionApiOperations(shares)
  server.register('solusApiRequest', async ([request], caller) => {
    const url = new URL(request.path, 'http://test')
    const context = { principal: caller.principal, home: { kind: 'local' as const, hostId: 'test' }, scopes: ['sessions:read' as const] }
    try {
      const body = url.pathname === '/sessions'
        ? await sessions.list(context, workspaceSessionQuerySchema.parse(Object.fromEntries(url.searchParams)))
        : await sessions.get(context, decodeURIComponent(url.pathname.slice('/sessions/'.length)))
      return { status: 200, body: JSON.stringify(body), etag: null, retryAfter: null }
    } catch (error) {
      if (!(error instanceof SolusApiError)) throw error
      return { status: error.status, body: JSON.stringify({ error: { code: error.code, message: error.message } }), etag: null, retryAfter: null }
    }
  })
  server.register('listProjects', () => [])
  server.register('codebaseList', () => [])
  server.register('listAttention', () => [])
  server.register('automationList', () => [])
  registerPinnedSessionsHandlers(server)
  return server
}

function shellFor(server: SolusServer, published: { clientId: string; changes: SessionShellChanges }[]): SessionShell {
  return new SessionShell({
    reads: sessionShellReads(server),
    publish: (clientId, changes) => { published.push({ clientId, changes }) },
    hostProjects: async () => [],
    sessionsStartedBy: async () => [],
  })
}

function snapshotOf(result: SessionShellOpenResult) {
  if (result.kind !== 'snapshot') throw new Error('expected a snapshot')
  return result.snapshot
}

describe('session shell rows', () => {
  test('a snapshot holds every row that sessionDirectoryOpen and its later pages give the same caller', async () => {
    const now = Date.now()
    const personKey = hostUserKey()
    for (let index = 0; index < 70; index++) {
      await upsertSessionRecord('local', {
        sessionId: 'shell-' + index, provider: 'codex', projectPath: '/app', lastActivityAt: now - index,
        startedBy: { kind: 'person', personKey },
      }, { organizationId: 'local', ownerKey: personKey })
    }
    // Old and quiet: out of the list, but pinned, so the list shows it.
    await upsertSessionRecord('local', {
      sessionId: 'shell-old-pinned', provider: 'codex', projectPath: '/app', lastActivityAt: now - 400 * 24 * 3_600_000,
      startedBy: { kind: 'person', personKey },
    }, { organizationId: 'local', ownerKey: personKey })
    await togglePinnedSession(personKey, { sessionId: 'shell-old-pinned', pinnedAt: now })
    await togglePinnedSession(personKey, { sessionId: 'shell-3', pinnedAt: now - 1 })
    const server = hostServer(new ShareManager({ db: getDatabase() }))
    registerSessionDirectoryHandler(server, { warm: async () => {} })
    const caller = callerOf('phone', OWNER)

    const opening = await server.handle('sessionDirectoryOpen', [], caller)
    if ('error' in opening) throw new Error(opening.error.message)
    const directory: SessionRecord[] = [...opening.records]
    let cursor = opening.nextCursor
    while (cursor) {
      const response = await server.handle('solusApiRequest', [{ method: 'GET', path: `/sessions?includeWorktrees=true&order=activity&limit=32&cursor=${encodeURIComponent(cursor)}` }], caller)
      const page = JSON.parse(response.body) as { items: { id: string }[]; nextCursor: string | null }
      directory.push(...page.items.map(item => ({ sessionId: item.id }) as SessionRecord))
      cursor = page.nextCursor
    }
    directory.push(...opening.pinnedRecords)

    const shell = shellFor(server, [])
    registerSessionShellHandler(server, shell)
    const snapshot = snapshotOf(await server.handle('sessionShellOpen', [{}], caller))
    expect(snapshot.rows.map(row => row.record.sessionId)).toEqual(directory.map(record => record.sessionId))
    expect(snapshot.rows.length).toBeGreaterThan(32)
    expect(snapshot.rows.find(row => row.record.sessionId === 'shell-old-pinned')?.pinnedAt).toBe(now)
    expect(snapshot.rows.find(row => row.record.sessionId === 'shell-3')?.pinnedAt).toBe(now - 1)
    expect(snapshot.rows.find(row => row.record.sessionId === 'shell-4')?.pinnedAt).toBeNull()
    expect(snapshot.cursor).toEqual({ epoch: shell.epoch, scopeKey: sessionShellScopeKey(OWNER), sequence: expect.any(Number) })
  })

  test('a revoked share becomes row.removed for the person who lost it, and for no one else', async () => {
    const shares = new ShareManager({ db: getDatabase() })
    const alice = member('alice')
    const bob = member('bob')
    const aliceKey = ownerKeyOf(actorFor(alice))
    if (!aliceKey) throw new Error('a member is a person')
    await upsertSessionRecord('org-shell', {
      sessionId: 'shell-shared', provider: 'codex', projectPath: '/app', lastActivityAt: Date.now(),
      startedBy: { kind: 'person', personKey: aliceKey },
    }, { organizationId: 'org-shell', ownerKey: aliceKey })
    await shares.setEntries({ resource: { kind: 'session', id: 'shell-shared' }, entries: [{ subject: { kind: 'user', id: 'bob' }, role: 'viewer' }] }, alice)
    const published: { clientId: string; changes: SessionShellChanges }[] = []
    const shell = shellFor(hostServer(shares), published)
    expect(snapshotOf(await shell.open(callerOf('alice-phone', alice), undefined)).rows.map(row => row.record.sessionId)).toContain('shell-shared')
    expect(snapshotOf(await shell.open(callerOf('bob-phone', bob), undefined)).rows.map(row => row.record.sessionId)).toContain('shell-shared')

    await shares.setEntries({ resource: { kind: 'session', id: 'shell-shared' }, entries: [] }, alice)
    shell.observe({ type: 'share.changed', payload: { resource: { kind: 'session', id: 'shell-shared' }, removedUserIds: ['bob'] }, occurredAt: Date.now() } as HostEvent)
    await settle()

    const changesOf = (clientId: string) => published.filter(entry => entry.clientId === clientId).flatMap(entry => entry.changes.changes)
    expect(changesOf('bob-phone')).toEqual([{ kind: 'row.removed', sessionId: 'shell-shared' }])
    expect(changesOf('alice-phone')).toEqual([{ kind: 'row.updated', row: expect.objectContaining({ record: expect.objectContaining({ sessionId: 'shell-shared' }) }) }])
  })
})

/** Reads that answer each caller from a table of who may see what. */
function fakeReads(visible: (principal: Principal, sessionId: string) => boolean, calls: string[][] = []): SessionShellReads {
  const row = (sessionId: string, principal: Principal): SessionShellRow => ({
    record: { sessionId, title: `${sessionId} for ${principal.kind === 'org-member' ? principal.userId : principal.kind}` } as SessionRecord,
    pinnedAt: null, attention: null, automationName: null, agentActivity: null,
  })
  return {
    snapshot: async (caller) => ({ rows: ['a', 'b'].filter(id => visible(caller.principal, id)).map(id => row(id, caller.principal)), projects: [], codebases: [], indexing: false }),
    sessions: async (caller, sessionIds) => {
      calls.push([...sessionIds])
      return new Map(sessionIds.filter(id => visible(caller.principal, id)).map(id => [id, row(id, caller.principal)]))
    },
    projects: async () => [],
    codebases: async () => [],
    indexing: () => false,
  }
}

function fakeShell(reads: SessionShellReads, published: { clientId: string; changes: SessionShellChanges }[] = [], now?: () => number): SessionShell {
  return new SessionShell({ reads, publish: (clientId, changes) => { published.push({ clientId, changes }) }, hostProjects: async () => [], sessionsStartedBy: async () => [], now })
}

describe('session shell cursor', () => {
  test('a cursor gets only the keys that changed after it', async () => {
    const calls: string[][] = []
    const shell = fakeShell(fakeReads(() => true, calls))
    shell.sessionChanged('a')
    const first = snapshotOf(await shell.open(callerOf('phone', OWNER), undefined))
    shell.sessionChanged('b')
    shell.disconnected('phone')
    const resumed = await shell.open(callerOf('phone', OWNER), first.cursor)
    expect(resumed.kind).toBe('changes')
    if (resumed.kind !== 'changes') return
    expect(calls).toEqual([['b']])
    expect(resumed.fromSequence).toBe(first.cursor.sequence)
    expect(resumed.cursor.sequence).toBe(first.cursor.sequence + 1)
    expect(resumed.changes.map(change => change.kind === 'row.updated' ? change.row.record.sessionId : change.kind)).toEqual(['b'])
  })

  test('a cursor from another process, another scope, or before the log gets a snapshot', async () => {
    let now = 1_000_000
    const shell = fakeShell(fakeReads(() => true), [], () => now)
    const first = snapshotOf(await shell.open(callerOf('phone', OWNER), undefined))
    expect((await shell.open(callerOf('phone', OWNER), { ...first.cursor, epoch: 'another-process' })).kind).toBe('snapshot')
    expect((await shell.open(callerOf('phone', member('bob')), first.cursor)).kind).toBe('snapshot')
    expect((await shell.open(callerOf('phone', OWNER), first.cursor)).kind).toBe('changes')

    // A change the log let go by age: the cursor before it cannot be continued.
    shell.sessionChanged('a')
    now += SESSION_SHELL_LOG_AGE_MS + 1
    shell.sessionChanged('b')
    expect((await shell.open(callerOf('phone', OWNER), first.cursor)).kind).toBe('snapshot')

    // A change the log let go by count.
    const second = snapshotOf(await shell.open(callerOf('phone', OWNER), undefined))
    for (let index = 0; index <= SESSION_SHELL_LOG_LIMIT; index++) shell.sessionChanged('many-' + index)
    expect((await shell.open(callerOf('phone', OWNER), second.cursor)).kind).toBe('snapshot')
  })
})

describe('session shell live changes', () => {
  test('two callers get their own payloads, and only for rows they hold or can read', async () => {
    const published: { clientId: string; changes: SessionShellChanges }[] = []
    const visible = (principal: Principal, sessionId: string) => principal.kind === 'owner' || sessionId === 'a'
    const shell = fakeShell(fakeReads(visible), published)
    await shell.open(callerOf('owner-phone', OWNER), undefined)
    await shell.open(callerOf('bob-phone', member('bob')), undefined)
    shell.sessionChanged('a')
    shell.sessionChanged('b')
    await settle()
    const owner = published.find(entry => entry.clientId === 'owner-phone')?.changes
    const bob = published.find(entry => entry.clientId === 'bob-phone')?.changes
    expect(owner?.changes.map(change => change.kind === 'row.updated' && change.row.record.title)).toEqual(['a for owner', 'b for owner'])
    // Bob never held `b` and cannot read it: he learns nothing about it, not even its id.
    expect(bob?.changes).toEqual([{ kind: 'row.updated', row: expect.objectContaining({ record: expect.objectContaining({ title: 'a for bob' }) }) }])
    expect(owner?.cursor.scopeKey).not.toBe(bob?.cursor.scopeKey)
  })

  test('changes inside the coalescing window go out once, and continue the copy the client holds', async () => {
    const published: { clientId: string; changes: SessionShellChanges }[] = []
    const calls: string[][] = []
    const shell = fakeShell(fakeReads(() => true, calls), published)
    const snapshot = snapshotOf(await shell.open(callerOf('phone', OWNER), undefined))
    shell.sessionChanged('a')
    shell.observe({ type: 'session.activityChanged', payload: { sessionId: 'b', activity: 'edit', at: 1 }, occurredAt: 1 } as HostEvent)
    shell.sessionChanged('a')
    await settle()
    expect(published).toHaveLength(1)
    expect(calls).toEqual([['b', 'a']])
    const [{ changes }] = published
    expect(changes.fromSequence).toBe(snapshot.cursor.sequence)
    expect(changes.cursor.sequence).toBe(snapshot.cursor.sequence + 3)
    expect(changes.changes.map(change => change.kind === 'row.updated' && [change.row.record.sessionId, change.row.agentActivity])).toEqual([['b', 'edit'], ['a', null]])

    shell.sessionChanged('b')
    await settle()
    expect(published[1]?.changes.fromSequence).toBe(changes.cursor.sequence)
  })

  test('a client whose connection closed gets nothing, also when it closed while its open read', async () => {
    const published: { clientId: string; changes: SessionShellChanges }[] = []
    const shell = fakeShell(fakeReads(() => true), published)
    await shell.open(callerOf('phone', OWNER), undefined)
    shell.disconnected('phone')
    const opening = shell.open(callerOf('tablet', OWNER), undefined)
    shell.disconnected('tablet')
    await opening
    shell.sessionChanged('a')
    await settle()
    expect(published).toEqual([])
  })

  test('the audience admits the per-caller event to a person, and the topic names no shared resource', async () => {
    const event = { type: 'sessionShell.changed', payload: { fromSequence: 0, cursor: { epoch: 'e', scopeKey: 's', sequence: 1 }, changes: [] }, occurredAt: 1 } as HostEvent
    const shares = new ShareManager({ db: getDatabase() })
    expect(eventResource(event)).toBeNull()
    expect(await eventVisibleTo(OWNER, event, shares)).toBe(true)
    expect(await eventVisibleTo(member('bob'), event, shares)).toBe(true)
  })
})
