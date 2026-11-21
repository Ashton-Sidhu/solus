import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { resetTestDatabase } from './helpers/test-db'
import type { AccessTokenClaims } from '@solus/contracts/uplink'
import type { Db } from '@solus/server/db/database'
import type { ShareManager } from '@solus/server/sharing/share-manager'

mock.module('node:sqlite', () => ({ DatabaseSync }))
let database: Db
let shares: ShareManager
let cloudSessionRepositoryName: typeof import('@solus/server/data/sessions/session-repositories').cloudSessionRepositoryName
let sessionRemoteProvider: typeof import('@solus/server/sync/sessions/session-remote-provider').sessionRemoteProvider
const base = { iss: 'https://issuer.test', aud: 'urn:solus:api', sub: 'alice', jti: 'token', iat: 1, exp: 9999999999, grant_id: 'grant', hostKind: 'personal' } as const
const personal: AccessTokenClaims = { ...base, access: 'owner', act: { host_id: 'host-a' } }
const organization: AccessTokenClaims = { ...base, access: 'org-member', organizationId: 'org-a', organizationRole: 'member', teamIds: [], act: { host_id: 'host-a' } }
const client: AccessTokenClaims = { ...base, access: 'owner' }
const calls: Array<{ repo: string; scope: string }> = []
const events: Array<{ scope: string; sessionId: string; head: string | null }> = []
const app = new Hono()
beforeAll(async () => {
  const [{ getDatabase }, { ShareManager }, { registerSessionRepositoryRoutes }, repository, provider, { session }] = await Promise.all([
    import('@solus/server/db/database'), import('@solus/server/sharing/share-manager'), import('@solus/server/transport/session-repository-routes'),
    import('@solus/server/data/sessions/session-repositories'), import('@solus/server/sync/sessions/session-remote-provider'), import('@solus/server/data/sessions/schema'),
  ])
  database = getDatabase()
  shares = new ShareManager({ db: database })
  cloudSessionRepositoryName = repository.cloudSessionRepositoryName
  sessionRemoteProvider = provider.sessionRemoteProvider
  registerSessionRepositoryRoutes(app, {
  isApiMode: true, database, shares,
  sessionRepositories: {
    database, shares, storage: { storageScope: 'test/sessions', async remote(repo, scope) { calls.push({ repo, scope }); return { url: 'file:///tmp/repository.git', token: '' } } },
    async changed(scope, sessionId, facts) { events.push({ scope, sessionId, head: facts.head }) },
  },
  verifyAccessToken: async token => token === 'invalid' ? { ok: false, reason: 'bad-signature' } : { ok: true, claims: token === 'personal' ? personal : token === 'organization' ? organization : token === 'bob' ? { ...organization, sub: 'bob' } : token === 'bob-personal' ? { ...personal, sub: 'bob' } : client },
  })
  await database.get(sql`SELECT 1`)
  await database.run(sql`INSERT INTO ${session} (session_id, organization_id, created_by, publication, created_at, last_activity_at) VALUES ('org-session', 'org-a', 'alice', 'published', 1, 1), ('unpublished', 'org-a', 'alice', 'local', 1, 1), ('private-chat', 'org-a', 'alice', 'published', 1, 1)`)
})

async function post(path: string, token: string | null, body: object) {
  return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
}
const tokenPath = '/runner/session-repositories/token'
const headPath = '/runner/session-repositories/head'
const request = { hostId: 'host-a', sessionId: 'private-a', access: 'write' }
const head = 'a'.repeat(40)

afterAll(async () => { await resetTestDatabase() })

test('a host gets only its own delegated repository', async () => {
  // WHY: a full transcript must not be returned to a client token or another host.
  expect((await post(tokenPath, null, request)).status).toBe(401)
  expect((await post(tokenPath, 'invalid', request)).status).toBe(401)
  expect((await post(tokenPath, 'client', request)).status).toBe(401)
  expect((await post(tokenPath, 'personal', { ...request, hostId: 'host-b' })).status).toBe(403)
  expect((await post(tokenPath, 'personal', { ...request, access: 'read' })).status).toBe(404)
  const issued = await post(tokenPath, 'personal', request)
  expect(issued.status).toBe(200)
  const body = await issued.json()
  expect(body.repository).toBe(cloudSessionRepositoryName('person:alice', 'private-a'))
  expect(body.storageScope).toBe('test/sessions')
  expect(calls.at(-1)).toEqual({ repo: body.repository, scope: 'write' })
  expect((await post(tokenPath, 'personal', { ...request, access: 'read' })).status).toBe(200)
  expect(calls.at(-1)?.scope).toBe('read')
  expect((await post(tokenPath, 'bob-personal', { ...request, access: 'read' })).status).toBe(404)
})

test('organization admission needs publication and edit standing', async () => {
  // WHY: a repository contains bodies that a reader and another person cannot fetch.
  const { principalForClaims } = await import('@solus/server/admission/doors')
  const owner = principalForClaims(organization, 'org-a', 'api')
  if (!owner.ok) throw new Error('The fixture must admit its owner')
  await shares.setEntries({ resource: { kind: 'session', id: 'org-session' }, entries: [{ subject: { kind: 'user', id: 'bob' }, role: 'viewer' }] }, owner.principal)
  expect((await post(tokenPath, 'organization', { ...request, sessionId: 'unpublished' })).status).toBe(403)
  expect((await post(tokenPath, 'bob', { ...request, sessionId: 'org-session' })).status).toBe(403)
  expect((await post(tokenPath, 'bob', { ...request, sessionId: 'private-chat' })).status).toBe(403)
  const issued = await post(tokenPath, 'organization', { ...request, sessionId: 'org-session' })
  expect(issued.status).toBe(200)
  expect((await issued.json()).repository).toBe(cloudSessionRepositoryName('organization:org-a', 'org-session'))
})

test('head reports advance once and emit only accepted changes', async () => {
  // WHY: an old host cannot replace the cloud head after a newer turn.
  const pushed = { hostId: 'host-a', sessionId: 'private-a', event: 'pushed', head, syncedTurn: 1, card: { title: 'Test', provider: 'codex', model: null, repositoryKey: null, branch: null, lastActivityAt: 10 } }
  expect((await post(headPath, 'personal', { hostId: 'host-a', sessionId: 'private-a', event: 'running' })).status).toBe(200)
  const accepted = await post(headPath, 'personal', pushed)
  expect(accepted.status).toBe(200)
  expect((await accepted.json()).lastRunHostId).toBe('host-a')
  expect((await post(headPath, 'personal', pushed)).status).toBe(200)
  const stale = await post(headPath, 'personal', { ...pushed, head: 'b'.repeat(40) })
  expect(stale.status).toBe(409)
  expect(await stale.json()).toEqual({ head })
  expect(events.map(event => event.scope)).toEqual(['person:alice', 'person:alice'])
})

test('off storage refuses a token', async () => {
  // WHY: a host must distinguish an unavailable store from an absent repository.
  expect(await sessionRemoteProvider(database, { SOLUS_SESSION_STORAGE: 'off' })).toBeNull()
  const { registerSessionRepositoryRoutes } = await import('@solus/server/transport/session-repository-routes')
  const unavailable = new Hono()
  registerSessionRepositoryRoutes(unavailable, { isApiMode: true, sessionRepositories: { database, shares, storage: null, async changed() {} }, verifyAccessToken: async () => ({ ok: true, claims: personal }) })
  const response = await unavailable.request(tokenPath, { method: 'POST', headers: { authorization: 'Bearer personal', 'content-type': 'application/json' }, body: JSON.stringify(request) })
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ code: 'storage_unavailable' })
})

test('the personal list shows committed rows for their owner', async () => {
  // WHY: a person must find their session when every host is offline.
  const { listPersonalSessionRepositories } = await import('@solus/server/data/sessions/session-repositories')
  const own = await listPersonalSessionRepositories(database, 'alice')
  expect(own.items.map(item => item.sessionId)).toEqual(['private-a'])
  expect(own.items[0]?.head).toBe(head)
  expect((await listPersonalSessionRepositories(database, 'bob')).items).toEqual([])
})

test('Artifacts receives the requested token scope through injected fetch', async () => {
  // WHY: a fetch gets read scope for one repository and no account credential reaches the host.
  const { sessionRepositories } = await import('@solus/server/data/sessions/schema')
  await database.run(sql`DELETE FROM ${sessionRepositories}`)
  const requests: Array<{ url: string; init: RequestInit }> = []
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init! })
    return Response.json(String(url).endsWith('/tokens') ? { success: true, result: { plaintext: 'secret' } } : { success: true, result: { remote: 'https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.artifacts.cloudflare.net/repo' } })
  }
  const provider = await sessionRemoteProvider(database, { SOLUS_SESSION_STORAGE: 'cloudflare-artifacts', SOLUS_ARTIFACTS_ACCOUNT_ID: 'a'.repeat(32), SOLUS_SESSION_ARTIFACTS_NAMESPACE: 'sessions', SOLUS_ARTIFACTS_API_TOKEN: 'server-secret' }, fake as typeof fetch)
  const result = await provider!.remote(cloudSessionRepositoryName('person:alice', 'fixture'), 'read')
  expect(result.token).toBe('secret')
  expect(JSON.parse(String(requests.at(-1)?.init.body))).toMatchObject({ scope: 'read', ttl: 900 })
})

// WHY: a file read names the commit, so a reader never gets a file of a commit that the API has not accepted.
test('Artifacts file reads use the requested head', async () => {
  const { ArtifactsRepositoryProvider } = await import('@solus/server/sync/git-storage/artifacts-repository-provider')
  const urls: string[] = []
  const fake = async (url: string | URL | Request) => {
    urls.push(String(url))
    return new Response('12345')
  }
  const cloud = new ArtifactsRepositoryProvider('a'.repeat(32), 'sessions', 'server-secret', undefined, fake as typeof fetch)
  const repository = cloudSessionRepositoryName('person:alice', 'fixture')
  expect(await cloud.readFile(repository, head, 'rows/0.jsonl')).toBe('12345')
  expect(new URL(urls[0]!).searchParams.get('ref')).toBe(head)
  expect(new URL(urls[0]!).searchParams.get('path')).toBe('rows/0.jsonl')
})
