import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { sql } from 'drizzle-orm'
import { resetTestDatabase } from './helpers/test-db'
import type { WorkspaceRequestContext } from '@solus/server/admission/workspace-credentials'
import type { WorkspaceOperations } from '@solus/server/data/workspace/operations'
import { workspaceWorkSchema, workspaceTranscriptPageSchema } from '@solus/contracts/solus-api'
import { installTestIdentities } from './helpers/acting-identities'
import type { SolusApiRequest } from '@solus/contracts/solus-api/request'
import type { Principal } from '@solus/server/admission/principal'
mock.module('node:sqlite', () => ({ DatabaseSync }))
let operations: WorkspaceOperations
let dataDir: string
let database: typeof import('@solus/server/db/database')
let shares: import('@solus/server/sharing/share-manager').ShareManager
const previous = process.env.SOLUS_DATA_DIR
const context: WorkspaceRequestContext = { principal: { kind: 'org-member', userId: 'alice', organizationId: 'A', organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName: 'Alice', deviceId: 'alice-device', deviceLabel: 'Browser', expiresAt: Date.now() + 300000 }, home: { kind: 'organization', organizationId: 'A', serviceId: 'api' }, scopes: ['tasks:read', 'tasks:write', 'works:read', 'works:write', 'sessions:read'] }
const bob: WorkspaceRequestContext = { ...context, principal: { ...context.principal, kind: 'org-member', userId: 'bob', organizationId: 'A', organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName: 'Bob', deviceId: 'bob-device', deviceLabel: 'Browser', expiresAt: Date.now() + 300000 } }
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-api-records-')); process.env.SOLUS_DATA_DIR = dataDir
  database = await import('@solus/server/db/database')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  shares = new ShareManager({ db: database.getDatabase() })
  operations = (await import('@solus/server/data/workspace/service')).createWorkspaceOperations(shares)
})
afterAll(async () => { await resetTestDatabase(); rmSync(dataDir, { recursive: true, force: true }); if (previous === undefined) delete process.env.SOLUS_DATA_DIR; else process.env.SOLUS_DATA_DIR = previous })

// Members act from homes of their own, as on a booted server (plans/019).
installTestIdentities()

test('create retries return one work; conflicting input and stale writes cannot change it', async () => {
  const input = { title: 'One work', type: 'doc' as const, content: 'Original' }
  const first = await operations.createWork(context, input, 'create-work-key-001')
  expect(workspaceWorkSchema.parse(first).title).toBe(input.title)
  const replay = await operations.createWork(context, input, 'create-work-key-001')
  expect(replay.id).toBe(first.id)
  await expect(operations.createWork(context, { ...input, title: 'Different' }, 'create-work-key-001')).rejects.toThrow('different input')
  const updated = await operations.updateWork(context, first.id, { title: 'Updated' }, first.version)
  expect(updated.version).not.toBe(first.version)
  await expect(operations.updateWork(context, first.id, { title: 'Lost update' }, first.version)).rejects.toThrow('latest version')
  await expect(operations.deleteWork(context, first.id, first.version)).rejects.toThrow('latest version')
  expect((await operations.getWork(context, first.id)).title).toBe('Updated')
})

test('private records are excluded before LIMIT and individual reads do not reveal them', async () => {
  for (let i = 0; i < 4; i++) await operations.createWork(context, { title: 'Private ' + i, type: 'doc', content: '' }, 'alice-private-key-' + i)
  const visible = await operations.createWork(bob, { title: 'Visible', type: 'doc', content: '' }, 'bob-visible-key-01')
  const page = await operations.listWorks(bob, { limit: 1 })
  expect(page.items.map(item => item.id)).toEqual([visible.id]); expect(page.nextCursor).toBeNull()
  const alice = await operations.listWorks(context, { limit: 1 })
  await expect(operations.getWork(bob, alice.items[0].id)).rejects.toThrow('not found')
  const continued = await operations.listWorks(bob, { limit: 50, cursor: alice.nextCursor! })
  expect(continued.items.every(item => item.ownerKey === 'bob')).toBe(true)
})

test('work writes preserve read-only provider rules and versions', async () => {
  const work = await operations.createWork(context, { title: 'Notes', type: 'doc', content: '# One' }, 'work-create-key-001')
  expect(workspaceWorkSchema.parse(work).content).toBe('# One')
  // WHY: a record version can be fetched at write time; only the body version the writer read proves it saw the body.
  await expect(operations.updateWork(context, work.id, { content: '# Blind' }, work.version)).rejects.toMatchObject({ status: 400 })
  const updated = await operations.updateWork(context, work.id, { content: '# Two', expectedContentVersion: work.contentVersion }, work.version)
  expect(updated.content).toBe('# Two')
  await expect(operations.updateWork(context, work.id, { content: '# Three', expectedContentVersion: work.contentVersion }, work.version)).rejects.toThrow('latest version')
  await expect(operations.getWork(bob, work.id)).rejects.toThrow('not found')
  const { Work } = await import('@solus/server/data/works/work')
  await (await Work.byId('A', work.id)).setMirroredDoc({ provider: 'gdrive', externalKey: 'root', externalId: 'doc', url: 'https://docs.google.com/document/d/doc/edit', scope: 'root', syncState: 'ok' })
  const linked = await operations.getWork(context, work.id)
  expect(linked.editable).toBe(false)
  await expect(operations.updateWork(context, work.id, { content: 'Forbidden', expectedContentVersion: linked.contentVersion }, linked.version)).rejects.toThrow('Google Docs')
})

test('an artifact keeps its session and is not filed on the task of that session', async () => {
  // WHY: the session shows what it made. A task shows what a person or an agent
  // deliberately put on it, so a saved render does not fill the task page.
  const { taskAttachments } = await import('@solus/server/data/tasks/task-attachments')
  const taskKey = 'github:I_session_context'
  await database.getDatabase().run(sql`INSERT INTO session_records(session_id,organization_id,created_by,provider,project_path,status,created_at,last_activity_at,size,started_at) VALUES ('task-session-alice','A','alice','codex','/project','idle',1,2,100,1)`)
  await operations.putLink(context, { from: { kind: 'task', id: taskKey }, to: { kind: 'session', id: 'task-session-alice' } })

  const artifact = await operations.createWork(context, {
    title: 'Saved chart', type: 'artifact', content: '<p>Chart</p>', originSessionId: 'task-session-alice',
  }, 'session-artifact-context')
  expect(artifact.sessionIds).toContain('task-session-alice')
  expect((await taskAttachments('A', taskKey)).links.map(link => link.targetKey)).not.toContain(artifact.id)
})

test('transcript paging reconstructs Unicode text without loading an unbounded message', async () => {
  const db = database.getDatabase(), sessionId = 'text-session'
  await db.run(sql`INSERT INTO session_records(session_id,organization_id,created_by,provider,project_path,status,created_at,last_activity_at,size,started_at) VALUES (${sessionId},'A','alice','codex','/project','idle',1,2,100,1)`)
  const content = 'Hello 😃 '.repeat(14000)
  await db.run(sql`INSERT INTO session_transcripts(organization_id,session_id,position,runner_host_id,message,updated_at) VALUES ('A',${sessionId},0,'host',${JSON.stringify({ messageId: 'message-1', role: 'assistant', content, timestamp: 1000 })},1)`)
  let cursor: string | undefined, result = '', offset = 0
  do {
    const page = await operations.listSessionMessages(context, sessionId, { limit: 1, cursor })
    workspaceTranscriptPageSchema.parse(page)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024 * 1024)
    for (const part of page.items) { expect(part.contentOffset).toBe(offset); result += part.content; offset += Array.from(part.content).length }
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  expect(result).toBe(content)
  await expect(operations.listSessionMessages(bob, sessionId, { limit: 1 })).rejects.toThrow('not found')
})

test('HTTP works without a socket; the bearer binds scope and strict inputs reject organization overrides', async () => {
  const { Hono } = await import('hono')
  const { createSolusApiRouter } = await import('@solus/server/transport/solus-api/router')
  const { solusApiOpenApi } = await import('@solus/contracts/solus-api/openapi')
  const { SOLUS_API_ORGANIZATION_HEADER } = await import('@solus/contracts/solus-api/request')
  // The bearer is admitted directly (docs/plans/simplify-auth-and-sync.md §4.2); this one may read and write works only.
  const admitted: Array<string | undefined> = []
  const admission = {
    socket: async () => null,
    bearer: async (bearer: string, organizationId: string | undefined): Promise<WorkspaceRequestContext | null> => {
      admitted.push(organizationId)
      return bearer === 'paired-source' ? { principal: context.principal, home: context.home, scopes: ['works:read', 'works:write'] } : null
    },
  }
  const router = createSolusApiRouter({ admission, operations, capabilities: { serviceId: 'api', mode: 'solus-api', apiVersion: '1', capabilities: ['works', 'session-records', 'insights'], events: { transport: 'websocket', relativePath: '/ws', protocolVersion: 1 } }, openApi: () => JSON.stringify(solusApiOpenApi()) })
  const app = new Hono().route('/v1', router)
  expect((await app.request('/v1/works')).status).toBe(401)
  const headers = { Authorization: 'Bearer paired-source', 'Content-Type': 'application/json', 'Idempotency-Key': 'http-create-key-001' }
  const created = await app.request('/v1/works', { method: 'POST', headers, body: JSON.stringify({ title: 'Over HTTP', type: 'doc', content: '' }) })
  expect(created.status).toBe(201)
  const work = workspaceWorkSchema.parse(await created.json())
  expect(created.headers.get('ETag')).toBe(JSON.stringify(work.version))
  expect((await app.request('/v1/works?organizationId=B', { headers })).status).toBe(400)
  expect((await app.request('/v1/works?limit=201', { headers })).status).toBe(400)
  expect((await app.request('/v1/works?limit=1&limit=2', { headers })).status).toBe(400)
  expect((await app.request('/v1/sessions', { headers })).status).toBe(403)
  expect((await app.request('/v1/works/' + work.id, { method: 'PATCH', headers, body: JSON.stringify({ title: 'No version' }) })).status).toBe(400)
  expect((await app.request('/v1/works', { method: 'POST', headers, body: JSON.stringify({ title: 'Override', type: 'doc', content: '', organizationId: 'B' }) })).status).toBe(400)
  const metadata = (await import('@solus/contracts/solus-api')).solusApiOperations
  const actual = new Set(router.routes.filter(route => route.method !== 'ALL').map(route => route.method.toLowerCase() + ' ' + route.path))
  expect(actual).toEqual(new Set(Object.values(metadata).map(route => route.method + ' ' + route.path)))

  // The HTTP client presents its own token on each request, in the organization it names.
  const { SolusApiClient, SolusApiHttp } = await import('@solus/contracts/solus-api/client')
  const seen: Array<{ path: string; authorization: string | null; organization: string | null }> = []
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const request = new Request(String(input), init)
    seen.push({ path: new URL(request.url).pathname, authorization: request.headers.get('authorization'), organization: request.headers.get(SOLUS_API_ORGANIZATION_HEADER) })
    return app.fetch(request)
  }
  const client = new SolusApiClient(new SolusApiHttp({ baseUrl: () => 'https://api.example', contextKey: () => 'A', acquireSource: async () => 'paired-source', organizationId: () => 'A', fetchImpl }))
  expect((await client.request('getWork', { id: work.id })).id).toBe(work.id)
  expect(seen).toEqual([{ path: '/v1/works/' + work.id, authorization: 'Bearer paired-source', organization: 'A' }])
  expect(admitted.at(-1)).toBe('A')
})

test('the API has no task record: GitHub or Jira holds each task, so no task path answers', async () => {
  // WHY (provider-owned-tasks.md decision 6): the organization's API keeps what
  // Solus attaches to a task. A task route that answered would be a second store.
  const { Hono } = await import('hono')
  const { createSolusApiRouter } = await import('@solus/server/transport/solus-api/router')
  const { solusApiOperations } = await import('@solus/contracts/solus-api')
  const admission = { socket: async () => null, bearer: async (): Promise<WorkspaceRequestContext | null> => context }
  const router = createSolusApiRouter({ admission, operations, capabilities: { serviceId: 'api', mode: 'solus-api', apiVersion: '1', capabilities: ['works'], events: { transport: 'websocket', relativePath: '/ws', protocolVersion: 1 } }, openApi: () => '{}' })
  const app = new Hono().route('/v1', router)
  const headers = { Authorization: 'Bearer any', 'Content-Type': 'application/json', 'Idempotency-Key': 'no-task-route-key-01' }
  expect((await app.request('/v1/tasks', { headers })).status).toBe(404)
  expect((await app.request('/v1/tasks', { method: 'POST', headers, body: JSON.stringify({ title: 'A task' }) })).status).toBe(404)
  expect((await app.request('/v1/tasks/github:I_1', { headers })).status).toBe(404)
  expect(Object.values(solusApiOperations).filter(route => route.path.startsWith('/tasks'))).toEqual([])
  // The attachment of a task still has its route: a link from a task key.
  const link = { from: { kind: 'task', id: 'github:I_1' }, to: { kind: 'pr', url: 'https://github.com/acme/app/pull/3' } }
  expect((await app.request('/v1/links', { method: 'PUT', headers, body: JSON.stringify(link) })).status).toBe(204)
})

// A client with a socket sends its records there: the socket's principal is their
// authority, so a cold request costs one round trip and no credential exchange.
test('records over a socket take its principal as authority and never exchange a credential', async () => {
  const { Hono } = await import('hono')
  const { revokeDevice } = await import('@solus/server/admission/auth')
  const { createDoors } = await import('@solus/server/admission/doors')
  const { workspaceAdmissionFor } = await import('@solus/server/transport/solus-api/admission')
  const { answerSocketRequest, createSolusApiRouter } = await import('@solus/server/transport/solus-api/router')
  const { SolusApiClient } = await import('@solus/contracts/solus-api/client')
  revokeDevice('revoked-device')
  const admission = workspaceAdmissionFor({ isApiMode: true, solusApi: { operations, serviceId: 'api' } }, createDoors({ place: 'api', pairingDisabled: true }))
  const router = createSolusApiRouter({ admission, operations, capabilities: { serviceId: 'api', mode: 'solus-api', apiVersion: '1', capabilities: ['works'], events: { transport: 'websocket', relativePath: '/ws', protocolVersion: 1 } }, openApi: () => '{}' })
  // Mounted at /v1 over HTTP too: the socket must not open a door HTTP keeps shut.
  const http = new Hono().route('/v1', router)
  const requests = (request: SolusApiRequest, principal: Principal) => answerSocketRequest(router, request, principal)
  const client = new SolusApiClient({ contextKey: () => 'A', send: request => requests(request, context.principal) })

  const work = await client.request('createWork', { body: { title: 'Socket notes', type: 'doc', content: '# One' }, key: 'socket-work-key-0001' })
  expect(work.role).toBe('owner')
  expect(await client.request('getWork', { id: work.id, ifNoneMatch: work.version })).toBeUndefined()
  const renamed = await client.request('updateWork', { id: work.id, body: { title: 'Renamed' }, version: work.version })
  expect(renamed.title).toBe('Renamed')

  // The socket's principal is held to the API's rules: a revoked device, an expired
  // token, and the host itself are refused, as an exchange would refuse them.
  const listWorks: SolusApiRequest = { method: 'GET', path: '/works?limit=1' }
  expect((await requests(listWorks, { ...context.principal, deviceId: 'revoked-device' })).status).toBe(401)
  expect((await requests(listWorks, { ...context.principal, expiresAt: Date.now() - 1 })).status).toBe(401)
  expect((await requests(listWorks, { kind: 'system' })).status).toBe(401)
  // An admitted socket request leaves no authority behind for an HTTP request.
  expect((await http.request('/v1/works?limit=1')).status).toBe(401)
})

test('rolled-back writes emit no work change and reserve no retry receipt', async () => {
  const { onWorksChanged } = await import('@solus/server/data/works/work-events')
  const changed: string[] = []
  const stop = onWorksChanged(change => { changed.push(change.workId) })
  try {
    await expect(database.getDatabase().transaction(async () => {
      await operations.createWork(context, { title: 'Roll back', type: 'doc', content: '' }, 'rollback-create-key-01')
      throw new Error('Rollback')
    })).rejects.toThrow('Rollback')
    expect(changed).toEqual([])
    const work = await operations.createWork(context, { title: 'Roll back', type: 'doc', content: '' }, 'rollback-create-key-01')
    expect(changed).toEqual([work.id])
  } finally { stop() }
})

test('in-process callers cannot bypass request bounds', async () => {
  await expect(operations.listWorks(context, { limit: 100000 })).rejects.toThrow()
  await expect(operations.createWork(context, { title: 'x'.repeat(501), type: 'doc', content: '' }, 'bounded-create-key-01')).rejects.toThrow()
})

test('an editor can save a shared work but only its owner can delete it', async () => {
  const work = await operations.createWork(context, { title: 'Shared', type: 'doc', content: 'One' }, 'shared-work-key-001')
  await shares.setEntries({ resource: { kind: 'work', id: work.id }, entries: [{ subject: { kind: 'user', id: 'bob' }, role: 'editor' }] }, context.principal)
  expect((await operations.listWorks(bob, { limit: 50 })).items.map(item => item.id)).toContain(work.id)
  // Every record carries the reader's role (access-model.md §2.7): the owner owns it, the editor edits it.
  expect(work.role).toBe('owner')
  expect((await operations.listWorks(bob, { limit: 50 })).items.find(item => item.id === work.id)?.role).toBe('editor')
  expect((await operations.getWork(bob, work.id)).role).toBe('editor')
  const changed = await operations.updateWork(bob, work.id, { content: 'Two', expectedContentVersion: work.contentVersion }, work.version)
  await expect(operations.deleteWork(bob, work.id, changed.version)).rejects.toThrow('not found')
  await operations.deleteWork(context, work.id, changed.version)
  await expect(operations.getWork(context, work.id)).rejects.toThrow('not found')
})

test('a work made in a shared session opens for its readers at the session\'s role', async () => {
  // WHY (decision 2026-10-30): an artifact an agent made in a session is part of
  // that session. Bob, an editor of Alice's session, must list, read, and save it;
  // without that his transcript shows artifact cards that never load.
  const { seedResource } = await import('./helpers/resource-rows')
  const { sql } = await import('drizzle-orm')
  await seedResource(database.getDatabase(), 'session', 'artifact-session', 'alice', 'A')
  const work = await operations.createWork(context, { title: 'Chart', type: 'artifact', content: '<p>One</p>' }, 'session-work-key-001')
  const other = await operations.createWork(context, { title: 'Private', type: 'doc', content: '' }, 'session-work-key-002')
  await database.getDatabase().run(sql`UPDATE works SET session_id = 'artifact-session' WHERE id = ${work.id}`)
  await expect(operations.getWork(bob, work.id)).rejects.toThrow('not found')

  await shares.setEntries({ resource: { kind: 'session', id: 'artifact-session' }, entries: [{ subject: { kind: 'user', id: 'bob' }, role: 'editor' }] }, context.principal)
  const listed = (await operations.listWorks(bob, { limit: 50 })).items
  expect(listed.map(item => item.id)).toContain(work.id)
  expect(listed.map(item => item.id)).not.toContain(other.id)
  expect(listed.find(item => item.id === work.id)?.role).toBe('editor')
  expect((await operations.getWork(bob, work.id)).role).toBe('editor')
  const saved = await operations.updateWork(bob, work.id, { content: '<p>Two</p>', expectedContentVersion: work.contentVersion }, work.version)
  expect(saved.content).toBe('<p>Two</p>')
})

test('a paired session token works offline, is revocable, and cannot open the cloud service', async () => {
  const auth = await import('@solus/server/admission/auth')
  const { createDoors } = await import('@solus/server/admission/doors')
  const { workspaceAdmissionFor } = await import('@solus/server/transport/solus-api/admission')
  const paired = auth.issueSessionToken('Test desktop')
  let grantLookups = 0
  const local = workspaceAdmissionFor({ solusApi: { operations, serviceId: 'test-host' } },
    createDoors({ place: 'host', verifyAccessToken: async () => { grantLookups++; return { ok: false, reason: 'not-linked' } } }))
  expect((await local.bearer(paired.token, undefined))?.home).toEqual({ kind: 'local', hostId: 'test-host' })
  expect(grantLookups).toBe(0)
  const cloud = workspaceAdmissionFor({ isApiMode: true, solusApi: { operations, serviceId: 'cloud' } }, createDoors({ place: 'api', pairingDisabled: true }))
  expect(await cloud.bearer(paired.token, undefined)).toBeNull()
  auth.revokeDevice(paired.deviceId)
  expect(await local.bearer(paired.token, undefined)).toBeNull()
})

// docs/plans/host-sharing.md §9.8: the link secret is the whole credential, at the host and the
// Solus API alike. A guest admitted with it (in its socket's handshake) opens the one shared
// resource with the link's role as it stands now, and loses it when the link is regenerated or removed.
test('a link guest opens only its shared work with the secret alone, with the link\'s current role', async () => {
  const { createDoors, guestPrincipalFor } = await import('@solus/server/admission/doors')
  const { workspaceAdmissionFor } = await import('@solus/server/transport/solus-api/admission')
  const { answerSocketRequest, createSolusApiRouter } = await import('@solus/server/transport/solus-api/router')
  const { SolusApiClient } = await import('@solus/contracts/solus-api/client')
  const resolveShareSecret = (secret: string) => shares.resolveLinkSecret(secret)
  const admission = workspaceAdmissionFor({ isApiMode: true, solusApi: { operations, serviceId: 'api' } }, createDoors({ place: 'api', pairingDisabled: true, resolveShareSecret }))
  const router = createSolusApiRouter({ admission, operations, capabilities: { serviceId: 'api', mode: 'solus-api', apiVersion: '1', capabilities: ['works'], events: { transport: 'websocket', relativePath: '/ws', protocolVersion: 1 } }, openApi: () => '{}' })
  const guestOf = async (shareSecret: string) => {
    const admitted = await guestPrincipalFor(resolveShareSecret, shareSecret, 'maya-guest-0000001', 'Maya')
    if (!admitted.ok) return null
    return new SolusApiClient({ contextKey: () => 'maya', send: request => answerSocketRequest(router, request, admitted.principal) })
  }

  const work = await operations.createWork(context, { title: 'Linked', type: 'doc', content: 'One' }, 'linked-work-key-0001')
  const other = await operations.createWork(context, { title: 'Not linked', type: 'doc', content: 'Secret' }, 'linked-work-key-0002')
  const resource = { kind: 'work', id: work.id } as const
  const link = (await shares.setLink({ resource, role: 'viewer' }, context.principal))!
  const maya = (await guestOf(link.secret))!

  expect((await maya.request('getWork', { id: work.id })).content).toBe('One')
  expect((await maya.request('listWorks')).items.map(item => item.id)).toEqual([work.id])
  await expect(maya.request('getWork', { id: other.id })).rejects.toMatchObject({ status: 404 })
  await expect(maya.request('updateWork', { id: work.id, body: { content: 'Viewer edit', expectedContentVersion: work.contentVersion }, version: work.version })).rejects.toMatchObject({ status: 404 })
  await expect(maya.request('createWork', { body: { title: 'Guest root', type: 'doc', content: '' }, key: 'guest-root-work-key-01' })).rejects.toMatchObject({ status: 403 })

  // A role change keeps the secret and applies at once, to the admission she already holds.
  expect((await shares.setLink({ resource, role: 'editor' }, context.principal))?.secret).toBe(link.secret)
  const saved = await maya.request('updateWork', { id: work.id, body: { content: 'Maya was here', expectedContentVersion: work.contentVersion }, version: work.version })
  expect(saved.content).toBe('Maya was here')

  // A regenerated link ends what the old secret opened, and the old secret admits no one new.
  const rotated = (await shares.setLink({ resource, role: 'editor', regenerate: true }, context.principal))!
  await expect(maya.request('getWork', { id: work.id })).rejects.toMatchObject({ status: 404 })
  expect(await guestOf(link.secret)).toBeNull()
  const again = (await guestOf(rotated.secret))!
  expect((await again.request('getWork', { id: work.id })).content).toBe('Maya was here')
  await shares.setLink({ resource, role: null }, context.principal)
  await expect(again.request('getWork', { id: work.id })).rejects.toMatchObject({ status: 404 })
})

test.skipIf(process.env.SOLUS_DB !== 'postgres')('a database timeout cancels the request and returns a retryable API error', async () => {
  const { withWorkspaceBudget } = await import('@solus/server/data/workspace/request-budget')
  const query = withWorkspaceBudget(async () => database.getDatabase().all(sql`SELECT pg_sleep(6)`))
  await expect(query()).rejects.toMatchObject({ status: 503, code: 'CAPABILITY_UNAVAILABLE', retryAfter: 1 })
  expect((await operations.listWorks(context, { limit: 1 })).items.length).toBeLessThanOrEqual(1)
}, 10000)
