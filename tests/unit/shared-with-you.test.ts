import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'
import type { Principal } from '@solus/server/admission/principal'
import type { ShareManager } from '@solus/server/sharing/share-manager'
import type { ShareRole } from '@solus/contracts/sharing'
import { installTestIdentities } from './helpers/acting-identities'
mock.module('node:sqlite', () => ({ DatabaseSync }))

// A direct share puts another person's session in your list; an organization
// share or a link only gives access. You archive it like your own, and a later
// grant or a higher role brings it back (docs/plans/shared-with-you.md §2).

let dataDir: string
const previous = process.env.SOLUS_DATA_DIR
const member = (userId: string, teamIds: string[] = []): Principal => ({ kind: 'org-member', userId, organizationId: 'A', organizationRole: 'member', teamIds, hostKind: 'personal', displayName: userId, deviceId: `${userId}-device`, deviceLabel: 'Browser', expiresAt: Date.now() + 300000 })
const BOB = member('bob')
let shares: ShareManager
let app: { request(path: string, init?: RequestInit): Promise<Response> }
const readers = new Map<string, Principal>([['alice', member('alice', ['platform'])], ['bob', BOB]])
let now = Date.now()

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-shared-with-you-')); process.env.SOLUS_DATA_DIR = dataDir
  const database = await import('@solus/server/db/database')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  shares = new ShareManager({ db: database.getDatabase(), now: () => now })
  const operations = (await import('@solus/server/data/workspace/service')).createWorkspaceOperations(shares)
  const { Hono } = await import('hono')
  const { createSolusApiRouter } = await import('@solus/server/transport/solus-api/router')
  const { solusApiOpenApi } = await import('@solus/contracts/solus-api/openapi')
  const admission = { socket: async () => null, bearer: async (bearer: string) => {
    const principal = readers.get(bearer)
    return principal ? { principal, home: { kind: 'organization' as const, organizationId: 'A', serviceId: 'api' }, scopes: ['sessions:read' as const, 'sessions:write' as const] } : null
  } }
  const router = createSolusApiRouter({ admission, operations, capabilities: { serviceId: 'api', mode: 'solus-api', apiVersion: '1', capabilities: ['session-records'], events: { transport: 'socket.io', relativePath: '/ws', protocolVersion: 1 } }, openApi: () => JSON.stringify(solusApiOpenApi()) })
  app = new Hono().route('/v1', router)
  const { upsertSessionRecord } = await import('@solus/server/data/sessions/session-records')
  // Bob's sessions. `old` was last active long before the list's idle window.
  for (const [sessionId, lastActivityAt] of [['person', now], ['team', now], ['org', now], ['old', now - 90 * 24 * 60 * 60 * 1000]] as const) {
    await upsertSessionRecord('A', { sessionId, provider: 'codex', projectPath: '-repo', lastActivityAt }, { organizationId: 'A', published: true, ownerKey: 'bob' })
  }
})
afterAll(async () => { await resetTestDatabase(); rmSync(dataDir, { recursive: true, force: true }); if (previous === undefined) delete process.env.SOLUS_DATA_DIR; else process.env.SOLUS_DATA_DIR = previous })

installTestIdentities()

const call = (reader: string, method: string, path: string, body?: object) => app.request('/v1' + path, {
  method, headers: { Authorization: 'Bearer ' + reader, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
})
type Item = { id: string; listed: boolean; sharedBy?: string; grantedAt?: number }
const list = async (reader = 'alice') => ((await (await call(reader, 'GET', '/sessions?limit=50&scope=list')).json()).items as Item[])
const listedIds = async (reader = 'alice') => (await list(reader)).map((item) => item.id).sort()
const share = (sessionId: string, subject: { kind: 'user' | 'team' | 'organization'; id: string }, role: ShareRole = 'viewer') =>
  shares.setEntries({ resource: { kind: 'session', id: sessionId }, entries: [{ subject, role }] }, BOB)
const archive = (sessionId: string) => call('alice', 'PATCH', `/sessions/${sessionId}`, { archived: true })

test('a direct share lists the session with who shared it; an organization share does not', async () => {
  expect(await listedIds()).toEqual([])
  await share('person', { kind: 'user', id: 'alice' })
  await share('team', { kind: 'team', id: 'platform' })
  await share('org', { kind: 'organization', id: 'A' })
  await share('old', { kind: 'user', id: 'alice' })
  // The grant counts as activity: a session shared today is listed however old it is.
  expect(await listedIds()).toEqual(['old', 'person', 'team'])
  expect((await list()).find((item) => item.id === 'person')).toMatchObject({ sharedBy: 'bob', grantedAt: now })
  // The owner's own list carries no share: their session is never "shared with you".
  expect((await list('bob')).every((item) => item.sharedBy === undefined)).toBe(true)
})

test('archive takes a shared session out; a higher role brings it back, a lower one does not', async () => {
  now += 1000
  expect((await archive('person')).status).toBe(200)
  expect(await listedIds()).not.toContain('person')

  now += 1000
  await share('person', { kind: 'user', id: 'alice' }, 'viewer')
  expect(await listedIds()).not.toContain('person')

  now += 1000
  await share('person', { kind: 'user', id: 'alice' }, 'editor')
  expect(await listedIds()).toContain('person')
  expect((await list()).find((item) => item.id === 'person')?.grantedAt).toBe(now)
})

test('removing the share removes the session from the list', async () => {
  await shares.setEntries({ resource: { kind: 'session', id: 'team' }, entries: [] }, BOB)
  expect(await listedIds()).not.toContain('team')
})

type Notice = { facts: { kind: string; role?: string; teamId?: string }; resource: { kind: string; sessionId?: string }; by: { kind: string; user?: { displayName: string } } }
const notices = async (reader = 'alice') => ((await (await call(reader, 'GET', '/me/notifications?view=all&limit=100')).json()).items as Notice[])
const aboutSession = (items: Notice[], sessionId: string, kind: string) => items.filter((item) => item.resource.sessionId === sessionId && item.facts.kind === kind)

test("the reader's shares become notifications when they read, once per grant, team shares included", async () => {
  const { upsertSessionRecord } = await import('@solus/server/data/sessions/session-records')
  await upsertSessionRecord('A', { sessionId: 'teamwork', provider: 'codex', projectPath: '-repo', lastActivityAt: now }, { organizationId: 'A', published: true, ownerKey: 'bob' })
  // The host never lists the team's members: Alice's own credential names her team when she reads.
  await share('teamwork', { kind: 'team', id: 'platform' }, 'editor')
  const first = aboutSession(await notices(), 'teamwork', 'session.shared')
  expect(first).toHaveLength(1)
  expect(first[0]).toMatchObject({ facts: { role: 'editor', teamId: 'platform' }, by: { kind: 'user', user: { displayName: 'bob' } } })
  // Reading again writes nothing new.
  expect(aboutSession(await notices(), 'teamwork', 'session.shared')).toHaveLength(1)
  // The owner gets no notice about their own session.
  expect(aboutSession(await notices('bob'), 'teamwork', 'session.shared')).toHaveLength(0)
})

test('a removed share leaves a notice the reader sees without access to the session', async () => {
  now += 1000
  await share('person', { kind: 'user', id: 'alice' }, 'viewer')
  await shares.setEntries({ resource: { kind: 'session', id: 'person' }, entries: [] }, BOB)
  const items = await notices()
  expect(aboutSession(items, 'person', 'session.unshared')).toHaveLength(1)
  // The session's share notices go with the access: the hub checks every row.
  expect(aboutSession(items, 'person', 'session.shared')).toHaveLength(0)
})
