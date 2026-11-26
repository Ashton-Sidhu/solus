import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { resetTestDatabase } from './helpers/test-db'
import type { AccessTokenClaims } from '@solus/contracts/uplink'
import type { Db } from '@solus/server/db/database'
import type { ShareManager } from '@solus/server/sharing/share-manager'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalObjectStore } from '@solus/server/sync/git-storage/local-object-store'

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
const codeRoot = mkdtempSync(join(tmpdir(), 'solus-session-code-routes-'))
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
    code: new LocalObjectStore(codeRoot, Buffer.alloc(32, 3)),
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
const codePath = '/runner/session-repositories/code'
const request = { hostId: 'host-a', sessionId: 'private-a', access: 'write', format: 2 }
const head = 'a'.repeat(40)

afterAll(async () => {
  rmSync(codeRoot, { recursive: true, force: true })
  await resetTestDatabase()
})

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

test('the token route refuses a host that does not write manifest version 2', async () => {
  // WHY: an older host would push a version 1 repository that a version 2 reader cannot fetch code for; 503 makes it wait.
  const { format: _format, ...older } = request
  const refused = await post(tokenPath, 'personal', older)
  expect(refused.status).toBe(503)
  expect(await refused.json()).toEqual({ code: 'storage_unavailable' })
  expect((await post(tokenPath, 'personal', { ...request, format: 1 })).status).toBe(400)
})

test('the code route signs a key only inside the caller\'s session and refuses a write above the cap', async () => {
  // WHY: a host must not read or overwrite the code of a session it cannot edit, or store a bundle that no writer makes.
  const bundle = Buffer.from('bundle bytes')
  const sha256 = createHash('sha256').update(bundle).digest('hex')
  const code = { hostId: 'host-a', sessionId: 'code-a', sha256, bytes: bundle.byteLength, access: 'write' }
  const { CODE_BUNDLE_MAX_BYTES } = await import('@solus/server/git/session-code-bundle')
  expect((await post(codePath, null, code)).status).toBe(401)
  expect((await post(codePath, 'personal', { ...code, hostId: 'host-b' })).status).toBe(403)
  expect((await post(codePath, 'bob', { ...code, sessionId: 'org-session' })).status).toBe(403)
  expect((await post(codePath, 'personal', { ...code, sessionId: '../private-a' })).status).toBe(400)
  expect((await post(codePath, 'personal', { ...code, sha256: sha256.toUpperCase() })).status).toBe(400)
  const large = await post(codePath, 'personal', { ...code, bytes: CODE_BUNDLE_MAX_BYTES + 1 })
  expect(large.status).toBe(413)
  expect(await large.json()).toEqual({ code: 'too_large' })
  expect((await post(codePath, 'personal', { ...code, access: 'read' })).status).toBe(404)

  const issued = await post(codePath, 'personal', code)
  expect(issued.status).toBe(200)
  const { url, expiresAt } = await issued.json()
  expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(890_000)
  expect(decodeURIComponent(new URL(url, 'https://api.test').pathname)).toBe(`/runner/session-code/sessions/person:alice/code-a/${sha256}`)
  const headers = { 'content-length': String(bundle.byteLength), 'x-amz-checksum-sha256': createHash('sha256').update(bundle).digest('base64') }
  const elsewhere = url.replace('/code-a/', '/private-a/')
  expect((await app.request(elsewhere, { method: 'PUT', headers, body: bundle })).status).toBe(403)
  expect((await app.request(url, { method: 'PUT', headers, body: bundle })).status).toBe(200)

  // Bob's own personal scope holds no session code-a: his read is refused.
  expect((await post(codePath, 'bob-personal', { ...code, access: 'read' })).status).toBe(404)
  const read = await post(codePath, 'personal', { ...code, access: 'read' })
  const fetched = await app.request((await read.json()).url)
  expect(fetched.status).toBe(200)
  expect(Buffer.from(await fetched.arrayBuffer())).toEqual(bundle)
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
  registerSessionRepositoryRoutes(unavailable, { isApiMode: true, sessionRepositories: { database, shares, storage: null, code: null, async changed() {} }, verifyAccessToken: async () => ({ ok: true, claims: personal }) })
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
  const provider = await sessionRemoteProvider(database, { SOLUS_SESSION_STORAGE: 'cloudflare-artifacts', SOLUS_ARTIFACTS_ACCOUNT_ID: 'a'.repeat(32), SOLUS_SESSION_ARTIFACTS_NAMESPACE: 'sessions', SOLUS_ARTIFACTS_API_TOKEN: 'server-secret', SOLUS_SESSION_R2_BUCKET: 'solus-sessions-test', SOLUS_R2_ACCESS_KEY_ID: 'id', SOLUS_R2_SECRET_ACCESS_KEY: 'key' }, fake as typeof fetch)
  const result = await provider!.repositories.remote(cloudSessionRepositoryName('person:alice', 'fixture'), 'read')
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
