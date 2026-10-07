import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import { resetTestDatabase } from './helpers/test-db'
import type { WorkspaceRequestContext } from '@solus/server/admission/workspace-credentials'
import type { WorkspaceOperations } from '@solus/server/data/workspace/operations'
import { workspaceTaskSchema, workspaceWorkSchema, workspaceTranscriptPageSchema } from '@solus/contracts/solus-api'
import { installTestIdentities } from './helpers/acting-identities'
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
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

test('create retries return one task; conflicting input and stale writes cannot change it', async () => {
  const input = { title: 'One task', body: 'Original' }
  const first = await operations.createTask(context, input, 'create-task-key-001')
  expect(workspaceTaskSchema.parse(first).title).toBe(input.title)
  const replay = await operations.createTask(context, input, 'create-task-key-001')
  expect(replay.id).toBe(first.id)
  await expect(operations.createTask(context, { title: 'Different' }, 'create-task-key-001')).rejects.toThrow('different input')
  const updated = await operations.updateTask(context, first.id, { title: 'Updated' }, first.version)
  expect(updated.version).not.toBe(first.version)
  await expect(operations.updateTask(context, first.id, { title: 'Lost update' }, first.version)).rejects.toThrow('latest version')
  await expect(operations.deleteTask(context, first.id, first.version)).rejects.toThrow('latest version')
  expect((await operations.getTask(context, first.id)).title).toBe('Updated')
})

test('private records are excluded before LIMIT and individual reads do not reveal them', async () => {
  for (let i = 0; i < 4; i++) await operations.createTask(context, { title: 'Private ' + i }, 'alice-private-key-' + i)
  const visible = await operations.createTask(bob, { title: 'Visible' }, 'bob-visible-key-01')
  const page = await operations.listTasks(bob, { limit: 1 })
  expect(page.items.map(item => item.id)).toEqual([visible.id]); expect(page.nextCursor).toBeNull()
  const alice = await operations.listTasks(context, { limit: 1 })
  await expect(operations.getTask(bob, alice.items[0].id)).rejects.toThrow('not found')
  const continued = await operations.listTasks(bob, { limit: 50, cursor: alice.nextCursor! })
  expect(continued.items.every(item => item.ownerUserId === 'bob')).toBe(true)
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

test('transcript paging reconstructs Unicode text without loading an unbounded message', async () => {
  const db = database.getDatabase(), sessionId = 'text-session'
  await db.run(sql`INSERT INTO session_records(session_id,organization_id,provider,project_path,status,created_at,last_activity_at,size) VALUES (${sessionId},'A','codex','/project','idle',1,2,100)`)
  await shares.claimOwner({ kind: 'session', id: sessionId }, context.principal, { shareWithOrganization: false })
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

test('HTTP works without a socket; credentials bind scope and strict inputs reject organization overrides', async () => {
  const { Hono } = await import('hono')
  const { WorkspaceCredentials } = await import('@solus/server/admission/workspace-credentials')
  const { createSolusApiRouter } = await import('@solus/server/transport/solus-api/router')
  const { solusApiOpenApi } = await import('@solus/contracts/solus-api/openapi')
  const credentials = new WorkspaceCredentials({ audience: 'api', authenticateSource: async source => source === 'paired-source' ? { principal: context.principal, expiresAt: Date.now() + 300000 } : null,
    isRevoked: async () => false, homeFor: () => context.home })
  const router = createSolusApiRouter({ credentials, operations, capabilities: { serviceId: 'api', mode: 'solus-api', apiVersion: '1', capabilities: ['tasks', 'works', 'session-records', 'insights'], events: { transport: 'socket.io', relativePath: '/ws', protocolVersion: 1 } }, openApi: () => JSON.stringify(solusApiOpenApi()) })
  const app = new Hono().route('/v1', router)
  expect((await app.request('/v1/tasks')).status).toBe(401)
  const exchange = await app.request('/v1/auth/session', { method: 'POST', headers: { Authorization: 'Bearer paired-source', 'Content-Type': 'application/json' }, body: JSON.stringify({ scopes: ['tasks:read', 'tasks:write'] }) })
  expect(exchange.status).toBe(200)
  const { accessToken } = await exchange.json()
  const headers = { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Idempotency-Key': 'http-create-key-001' }
  const created = await app.request('/v1/tasks', { method: 'POST', headers, body: JSON.stringify({ title: 'Over HTTP' }) })
  expect(created.status).toBe(201)
  const task = workspaceTaskSchema.parse(await created.json())
  expect(created.headers.get('ETag')).toBe(JSON.stringify(task.version))
  expect((await app.request('/v1/tasks?organizationId=B', { headers })).status).toBe(400)
  expect((await app.request('/v1/tasks?limit=201', { headers })).status).toBe(400)
  expect((await app.request('/v1/tasks?limit=1&limit=2', { headers })).status).toBe(400)
  expect((await app.request('/v1/works', { headers })).status).toBe(403)
  expect((await app.request('/v1/tasks/' + task.id, { method: 'PATCH', headers, body: JSON.stringify({ title: 'No version' }) })).status).toBe(400)
  expect((await app.request('/v1/tasks', { method: 'POST', headers, body: JSON.stringify({ title: 'Override', organizationId: 'B' }) })).status).toBe(400)
  const metadata = (await import('@solus/contracts/solus-api')).solusApiOperations
  const actual = new Set(router.routes.filter(route => route.method !== 'ALL').map(route => route.method.toLowerCase() + ' ' + route.path))
  expect(actual).toEqual(new Set(Object.values(metadata).map(route => route.method + ' ' + route.path)))

  const { SolusApiClient } = await import('@solus/contracts/solus-api/client')
  const original = globalThis.fetch
  let exchanges = 0, selected = 'A'
  globalThis.fetch = mock(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/auth/session')) exchanges++
    return app.fetch(new Request(url, init))
  }) as typeof fetch
  try {
    const client = new SolusApiClient({ baseUrl: () => 'https://api.example', contextKey: () => selected, acquireSource: async () => 'paired-source' })
    const [first, second] = await Promise.all([client.request('getTask', { id: task.id }), client.request('getTask', { id: task.id })])
    expect(first.id).toBe(second.id); expect(exchanges).toBe(1)
    const work = await client.request('createWork', { body: { title: 'Poll', type: 'doc', content: '# Content' }, key: 'conditional-work-key-01' })
    expect(await client.request('getWork', { id: work.id, ifNoneMatch: work.version })).toBeUndefined()
    await client.request('updateWork', { id: work.id, body: { content: '# Changed', expectedContentVersion: work.contentVersion }, version: work.version })
    expect((await client.request('getWork', { id: work.id, ifNoneMatch: work.version }))?.content).toBe('# Changed')
    selected = 'B'
    await client.request('getTask', { id: task.id })
    expect(exchanges).toBe(2)
  } finally { globalThis.fetch = original }
})

test('rolled-back writes emit no task change and reserve no retry receipt', async () => {
  const { onTasksChanged } = await import('@solus/server/data/tasks/task-store')
  const changed: string[] = []
  const stop = onTasksChanged(id => { if (id) changed.push(id) })
  try {
    await expect(database.getDatabase().transaction(async () => {
      await operations.createTask(context, { title: 'Roll back' }, 'rollback-create-key-01')
      throw new Error('Rollback')
    })).rejects.toThrow('Rollback')
    expect(changed).toEqual([])
    const task = await operations.createTask(context, { title: 'Roll back' }, 'rollback-create-key-01')
    expect(changed).toEqual([task.id])
  } finally { stop() }
})

test('in-process callers cannot bypass request bounds', async () => {
  await expect(operations.listTasks(context, { limit: 100000 })).rejects.toThrow()
  await expect(operations.createTask(context, { title: 'x'.repeat(501) }, 'bounded-create-key-01')).rejects.toThrow()
})

test('an editor can save a shared work but only its owner can delete it', async () => {
  const work = await operations.createWork(context, { title: 'Shared', type: 'doc', content: 'One' }, 'shared-work-key-001')
  await shares.setGrants({ resource: { kind: 'work', id: work.id }, grants: [{ subject: { kind: 'user', id: 'bob' }, role: 'editor' }] }, context.principal)
  expect((await operations.listWorks(bob, { limit: 50 })).items.map(item => item.id)).toContain(work.id)
  const changed = await operations.updateWork(bob, work.id, { content: 'Two', expectedContentVersion: work.contentVersion }, work.version)
  await expect(operations.deleteWork(bob, work.id, changed.version)).rejects.toThrow('not found')
  await operations.deleteWork(context, work.id, changed.version)
  await expect(operations.getWork(context, work.id)).rejects.toThrow('not found')
})

test('real paired credentials work offline, are revocable, and cannot open the cloud service', async () => {
  const auth = await import('@solus/server/admission/auth')
  const { workspaceCredentialsForHttp } = await import('@solus/server/transport/solus-api/admission')
  const paired = auth.issueSessionToken('Test desktop')
  let grantLookups = 0
  const local = workspaceCredentialsForHttp({ solusApi: { operations, serviceId: 'test-host' },
    verifyAccessToken: async () => { grantLookups++; return { ok: false, reason: 'not-linked' } } })
  const session = await local.exchange(paired.token, { scopes: ['tasks:read'] })
  expect(session?.home).toEqual({ kind: 'local', hostId: 'test-host' })
  expect(grantLookups).toBe(0)
  expect(await local.verify(session!.accessToken)).not.toBeNull()
  const cloud = workspaceCredentialsForHttp({ isApiMode: true, solusApi: { operations, serviceId: 'cloud' } })
  expect(await cloud.exchange(paired.token, { scopes: ['tasks:read'] })).toBeNull()
  auth.revokeDevice(paired.deviceId)
  expect(await local.verify(session!.accessToken)).toBeNull()
})

test.skipIf(process.env.SOLUS_DB !== 'postgres')('a database timeout cancels the request and returns a retryable API error', async () => {
  const { withWorkspaceBudget } = await import('@solus/server/data/workspace/request-budget')
  const query = withWorkspaceBudget(async () => database.getDatabase().all(sql`SELECT pg_sleep(6)`))
  await expect(query()).rejects.toMatchObject({ status: 503, code: 'CAPABILITY_UNAVAILABLE', retryAfter: 1 })
  expect((await operations.listTasks(context, { limit: 1 })).items.length).toBeLessThanOrEqual(1)
}, 10000)
