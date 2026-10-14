import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'
import type { WorkspaceRequestContext } from '@solus/server/admission/workspace-credentials'
import { sessionPullRequestId } from '@solus/contracts/session-pull-requests'
import { installTestIdentities } from './helpers/acting-identities'
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// A session's home keeps its list state and its pull requests behind one set of
// `/v1` resources (docs/plans/session-archive.md): the organization's Solus API
// for an organization session, the machine for a personal one. Both serve the
// same routes, so a client and a runner use one path for every session.

let dataDir: string
const previous = process.env.SOLUS_DATA_DIR
const alice: WorkspaceRequestContext = { principal: { kind: 'org-member', userId: 'alice', organizationId: 'A', organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName: 'Alice', deviceId: 'alice-device', deviceLabel: 'Browser', expiresAt: Date.now() + 300000 }, home: { kind: 'organization', organizationId: 'A', serviceId: 'api' }, scopes: ['sessions:read', 'sessions:write'] }
let app: { request(path: string, init?: RequestInit): Promise<Response> }
let token = ''

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-home-')); process.env.SOLUS_DATA_DIR = dataDir
  const database = await import('@solus/server/db/database')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  const shares = new ShareManager({ db: database.getDatabase() })
  const operations = (await import('@solus/server/data/workspace/service')).createWorkspaceOperations(shares)
  const { Hono } = await import('hono')
  const { WorkspaceCredentials } = await import('@solus/server/admission/workspace-credentials')
  const { createSolusApiRouter } = await import('@solus/server/transport/solus-api/router')
  const { solusApiOpenApi } = await import('@solus/contracts/solus-api/openapi')
  const credentials = new WorkspaceCredentials({ audience: 'api', authenticateSource: async source => source === 'alice' ? { principal: alice.principal, expiresAt: Date.now() + 300000 } : null,
    isRevoked: async () => false, homeFor: () => alice.home })
  const router = createSolusApiRouter({ credentials, operations, capabilities: { serviceId: 'api', mode: 'solus-api', apiVersion: '1', capabilities: ['session-records'], events: { transport: 'socket.io', relativePath: '/ws', protocolVersion: 1 } }, openApi: () => JSON.stringify(solusApiOpenApi()) })
  app = new Hono().route('/v1', router)
  const { upsertSessionRecord } = await import('@solus/server/data/sessions/session-records')
  await upsertSessionRecord('A', { sessionId: 's1', provider: 'codex', projectPath: '-repo', lastActivityAt: Date.now(), ownerUserId: 'alice' }, { organizationId: 'A', published: true })
  // As runner intake does for the session a runner reports.
  await shares.claimOwner({ kind: 'session', id: 's1' }, alice.principal)
  const exchange = await app.request('/v1/auth/session', { method: 'POST', headers: { Authorization: 'Bearer alice', 'Content-Type': 'application/json' }, body: JSON.stringify({ scopes: ['sessions:read', 'sessions:write'] }) })
  token = (await exchange.json()).accessToken
})
afterAll(async () => { await resetTestDatabase(); rmSync(dataDir, { recursive: true, force: true }); if (previous === undefined) delete process.env.SOLUS_DATA_DIR; else process.env.SOLUS_DATA_DIR = previous })

installTestIdentities()

const call = (method: string, path: string, body?: object) => app.request('/v1' + path, {
  method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
})

test("a session's pull requests are one resource: put links, the same put changes nothing, delete removes", async () => {
  const id = encodeURIComponent(sessionPullRequestId({ repository: 'github.com/acme/web', number: 12 }))
  const url = 'https://github.com/acme/web/pull/12'
  const put = await call('PUT', `/sessions/s1/pull-requests/${id}`, { url })
  expect(put.status).toBe(200)
  expect(await put.json()).toMatchObject({ sessionId: 's1', repository: 'github.com/acme/web', number: 12, source: 'manual' })
  expect((await call('PUT', `/sessions/s1/pull-requests/${id}`, { url })).status).toBe(200)
  expect((await (await call('GET', '/sessions/s1/pull-requests')).json()).items).toHaveLength(1)
  // The URL must name the pull request the path names.
  expect((await call('PUT', `/sessions/s1/pull-requests/${id}`, { url: 'https://github.com/acme/web/pull/13' })).status).toBe(400)
  // The session record carries its links.
  expect((await (await call('GET', '/sessions/s1')).json()).pullRequests).toHaveLength(1)

  expect((await call('DELETE', `/sessions/s1/pull-requests/${id}`)).status).toBe(204)
  expect((await (await call('GET', '/sessions/s1/pull-requests')).json()).items).toEqual([])
})

test("one PATCH archives in the caller's list and settles for everyone", async () => {
  const archived = await call('PATCH', '/sessions/s1', { archived: true })
  expect(archived.status).toBe(200)
  expect((await archived.json()).view.archivedAt).toEqual(expect.any(Number))
  const items = async (scope: 'list' | 'all') => (await (await call('GET', `/sessions?limit=50&scope=${scope}`)).json()).items as Array<{ id: string; listed: boolean }>
  const inList = async () => (await items('list')).map((item) => item.id)
  const outOfList = async () => (await items('all')).filter((item) => !item.listed).map((item) => item.id)
  expect(await inList()).toEqual([])
  expect(await outOfList()).toEqual(['s1'])
  await call('PATCH', '/sessions/s1', { archived: false })
  expect(await inList()).toEqual(['s1'])

  const settled = await call('PATCH', '/sessions/s1', { settled: true })
  expect((await settled.json()).state).toMatchObject({ settledBy: 'person' })
  // The view route is gone: a person's view is a field of the session.
  expect((await call('PATCH', '/me/sessions/s1', { archived: true })).status).toBe(404)
})

test('only a host acting for a person reports a turn', async () => {
  expect((await call('POST', '/sessions/s1/turns', {})).status).toBe(403)
})
