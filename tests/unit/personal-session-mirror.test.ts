import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { DatabaseSync } from './helpers/bun-sqlite'
import { ACCOUNT_AUDIENCE, SOLUS_API_AUDIENCE, type AccessTokenClaims } from '@solus/contracts/uplink'
import { dialHostSocket, type DialedHostSocket } from '@solus/client-core/host-socket'
import { resetTestDatabase } from './helpers/test-db'
import { handshake } from './helpers/socket-handshake'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/portable-sessions-cloud.md, "The mirror for readers", through the real
// HTTP and socket seams of the Solus API. A personal host delivers the rows and the
// turn diffs of a personal session with its owner's personal token. The owner reads
// them with no host online. Another member of the same organization reads nothing
// and finds nothing. The account plane is a fake that signs real ES256 tokens.

const HOST = 'machost00000001'
const environment = ['SOLUS_DATA_DIR', 'SOLUS_API', 'SOLUS_DB', 'SOLUS_CLOUD_ISSUER', 'SOLUS_CLOUD_JWKS_URL', 'SOLUS_API_SIGNING_KEY'] as const
const previous = environment.map((key) => [key, process.env[key]] as const)

let directory: string
let service: Awaited<ReturnType<typeof import('@solus/server/boot-solus-api').createSolusApiService>> | undefined
let apiListener: Server
let accountPlane: Server
let accountOrigin: string
let apiOrigin: string
let signingKey: KeyObject
const sockets: DialedHostSocket[] = []

function signed(claims: AccessTokenClaims): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({ alg: 'ES256', kid: 'plane-key', typ: 'at+jwt' })
  const body = encode(claims)
  return `${header}.${body}.${sign('sha256', Buffer.from(`${header}.${body}`), { key: signingKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

const now = () => Math.floor(Date.now() / 1000)

/** What the account plane issues a personal host for its owner: the host acts, the person is the subject, and no organization is named. */
function personalDelegation(subject: string, hostKind: 'personal' | 'managed' = 'personal'): string {
  return signed({ iss: accountOrigin, aud: [SOLUS_API_AUDIENCE, ACCOUNT_AUDIENCE], sub: subject, grant_id: `${subject}-grant`, jti: randomUUID(), iat: now(), exp: now() + 300, client_id: `host_${HOST}`, access: 'owner', hostKind, act: { sub: `host_${HOST}`, host_id: HOST } })
}

/** A person's own client token for the Solus API, as a member of `org_a`. */
function memberToken(subject: string): string {
  return signed({ iss: accountOrigin, aud: SOLUS_API_AUDIENCE, sub: subject, grant_id: `${subject}-grant`, jti: randomUUID(), iat: now(), exp: now() + 300, client_id: 'solus-desktop', access: 'org-member', organizations: [{ id: 'org_a', role: 'member', teamIds: [] }], hostKind: 'cloud' })
}

async function memberSocket(subject: string): Promise<DialedHostSocket> {
  // Each socket is its own client: the host answers a repeated request id of one client from its cache.
  const dialed = await dialHostSocket(apiOrigin, handshake({ kind: 'access-token', token: memberToken(subject), organizationId: 'org_a' }, `${subject}-client-instance-${sockets.length}`))
  if (!dialed.ok) throw new Error(dialed.message)
  sockets.push(dialed.socket)
  return dialed.socket
}

function deliver(token: string, items: Array<{ seq: number; kind: string; payload: unknown }>): Promise<Response> {
  return fetch(`${apiOrigin}/runner/deliver`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ hostId: HOST, items }),
  })
}

function v1(subject: string, path: string): Promise<Response> {
  return fetch(`${apiOrigin}/v1${path}`, { headers: { authorization: `Bearer ${memberToken(subject)}`, 'solus-organization': 'org_a' } })
}

const pageSchema = z.object({ result: z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
  before: z.string().nullable(),
  turnDiffs: z.array(z.object({ turnIndex: z.number(), endedAt: z.number() })),
}) })
const refusalSchema = z.object({ error: z.object({ code: z.string().optional(), message: z.string() }) })

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'solus-personal-session-mirror-'))
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  signingKey = keys.privateKey
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'plane-key' }
  accountPlane = createServer((request, response) => {
    response.writeHead(request.url === '/jwks' ? 200 : 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify(request.url === '/jwks' ? { keys: [jwk] } : { error: 'not found' }))
  })
  await new Promise<void>((resolve) => accountPlane.listen(0, '127.0.0.1', resolve))
  const address = accountPlane.address()
  accountOrigin = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`
  Object.assign(process.env, {
    SOLUS_DATA_DIR: directory, SOLUS_API: '1', SOLUS_DB: process.env.SOLUS_DB ?? 'sqlite',
    SOLUS_CLOUD_ISSUER: accountOrigin, SOLUS_CLOUD_JWKS_URL: `${accountOrigin}/jwks`,
    SOLUS_API_SIGNING_KEY: Buffer.alloc(32, 22).toString('base64'),
  })
  const { createSolusApiService } = await import('@solus/server/boot-solus-api')
  let port = 0
  service = await createSolusApiService({ host: '127.0.0.1', port: () => port })
  apiListener = createServer(service.requestListener)
  service.attachLiveTransport(apiListener)
  await new Promise<void>((resolve) => apiListener.listen(0, '127.0.0.1', resolve))
  const apiAddress = apiListener.address()
  port = apiAddress && typeof apiAddress === 'object' ? apiAddress.port : 0
  apiOrigin = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  for (const socket of sockets) socket.close()
  service?.closeLiveTransport()
  apiListener.closeAllConnections()
  await new Promise<void>((resolve) => apiListener.close(() => resolve()))
  await service?.close()
  await new Promise<void>((resolve) => accountPlane.close(() => resolve()))
  await resetTestDatabase()
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  rmSync(directory, { recursive: true, force: true })
})

const row = (seq: number, position: number, role: string, content: string, timestamp: number) =>
  ({ seq, kind: 'transcript', payload: { sessionId: 'bobs-session', position, message: { role, content, timestamp } } })

describe('a personal session in the mirror, through the real Solus API', () => {
  test('the offline view of a personal session reads the mirror: rows, the turn diffs of each page, and the patch of a turn', async () => {
    // Two turns of Bob's personal session, as his machine sent them. No session repository exists.
    const delivered = await deliver(personalDelegation('bob'), [
      row(1, 0, 'user', 'rename the quokka helper', 1_000),
      row(2, 1, 'assistant', 'renamed it', 1_100),
      { seq: 3, kind: 'turn-diff', payload: { sessionId: 'bobs-session', turnIndex: 0, endedAt: 1_200, filesChanged: 1, additions: 2, deletions: 1, patch: 'diff --git a/quokka.ts b/quokka.ts\n' } },
      row(4, 2, 'user', 'now add a test', 2_000),
      row(5, 3, 'assistant', 'added the test', 2_100),
      { seq: 6, kind: 'turn-diff', payload: { sessionId: 'bobs-session', turnIndex: 1, endedAt: 2_200, filesChanged: 40, additions: 90_000, deletions: 3, patch: null } },
    ])
    expect(delivered.status).toBe(200)
    expect(await delivered.json()).toEqual({ lastSeq: 6, failed: [] })

    const bob = await memberSocket('bob')
    const newest = pageSchema.parse(await bob.call('loadSessionPage', [{ sessionId: 'bobs-session', turnLimit: 1 }], 5_000)).result
    expect(newest.messages.map((message) => message.content)).toEqual(['now add a test', 'added the test'])
    expect(newest.turnDiffs).toEqual([{ turnIndex: 1, endedAt: 2_200 }])
    const older = pageSchema.parse(await bob.call('loadSessionPage', [{ sessionId: 'bobs-session', turnLimit: 1, before: newest.before }], 5_000)).result
    expect(older.messages.map((message) => message.content)).toEqual(['rename the quokka helper', 'renamed it'])
    // WHY: each diff is on the page of its turn only, so a client draws one card for a turn.
    expect(older.turnDiffs).toEqual([{ turnIndex: 0, endedAt: 1_200 }])
    expect(older.before).toBeNull()
    const preview = z.object({ result: z.object({ totalMessages: z.number() }) }).parse(await bob.call('loadSessionPreview', ['bobs-session'], 5_000))
    expect(preview.result.totalMessages).toBe(4)

    // The patch of a turn, and the counts of one that was too large to mirror.
    expect(await (await v1('bob', '/sessions/bobs-session/turns/0/diff')).json()).toEqual({ status: 'available', patch: 'diff --git a/quokka.ts b/quokka.ts\n' })
    expect(await (await v1('bob', '/sessions/bobs-session/turns/1/diff')).json()).toEqual({ status: 'too-large', filesChanged: 40, additions: 90_000, deletions: 3 })
    expect(await (await v1('bob', '/sessions/bobs-session/turns/2/diff')).json()).toEqual({ status: 'not-available' })
  })

  test('another member of the same organization cannot read, search, or hear of it', async () => {
    // WHY: a personal session is no organization's. Its rows are in its owner's scope, which
    // the reader's own verified identity selects; a member token for the same organization is no key.
    const alice = await memberSocket('alice')
    const heard: string[] = []
    alice.onEvent((event) => { heard.push(event.type) })
    for (const [method, args] of [
      ['loadSessionPage', [{ sessionId: 'bobs-session', turnLimit: 1 }]],
      ['loadSession', ['bobs-session']],
      ['loadSessionPreview', ['bobs-session']],
      ['loadSessionToolInputs', [{ sessionId: 'bobs-session', keys: [] }]],
    ] as const) {
      expect(refusalSchema.parse(await alice.call(method, [...args], 5_000)).error.code).toBe('FORBIDDEN')
    }
    for (const turn of [0, 1]) expect(await (await v1('alice', `/sessions/bobs-session/turns/${turn}/diff`)).json()).toEqual({ status: 'not-available' })
    // The record routes know no such session, and no search reads its rows: for Alice, and for Bob too.
    expect((await v1('alice', '/sessions/bobs-session/messages')).status).toBe(404)
    for (const person of ['alice', 'bob']) {
      const found = z.object({ items: z.array(z.object({ id: z.string() })) }).parse(await (await v1(person, '/sessions/search?q=quokka')).json())
      expect(found.items).toEqual([])
      const listed = z.object({ items: z.array(z.object({ id: z.string() })) }).parse(await (await v1(person, '/sessions')).json())
      expect(listed.items).toEqual([])
    }

    // A new row tells Bob's connection, and not Alice's.
    const bob = await memberSocket('bob')
    const bobHeard = new Promise<void>((resolve) => bob.onEvent((event) => { if (event.type === 'session.transcriptChanged') resolve() }))
    expect((await deliver(personalDelegation('bob'), [row(7, 4, 'user', 'one more', 3_000)])).status).toBe(200)
    await bobHeard
    await alice.call('connectionsGetServerInfo', [], 5_000)
    expect(heard).not.toContain('session.transcriptChanged')

    // Alice's own machine cannot write into Bob's scope: her token names her scope, and the body names none.
    expect((await deliver(personalDelegation('alice'), [{ seq: 1, kind: 'transcript', payload: { sessionId: 'bobs-session', position: 0, message: { role: 'user', content: 'overwritten', timestamp: 1 } } }])).status).toBe(200)
    const bobsFirst = pageSchema.parse(await bob.call('loadSessionPage', [{ sessionId: 'bobs-session', turnLimit: 10 }], 5_000)).result
    expect(bobsFirst.messages.map((message) => message.content)).toEqual(['rename the quokka helper', 'renamed it', 'now add a test', 'added the test', 'one more'])
  })

  test('the delivery route refuses a personal token that no personal host presents', async () => {
    // WHY: a managed machine runs organization work. An owner token from one must not open a person scope.
    expect((await deliver(personalDelegation('bob', 'managed'), [])).status).toBe(401)
    // A person's own client token, with no host acting for them, is no runner.
    expect((await deliver(memberToken('bob'), [])).status).toBe(401)
  })
})
