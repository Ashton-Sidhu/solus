import { afterAll, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'
import { presignS3Url, R2ObjectStore } from '@solus/server/sync/git-storage/r2-object-store'
import { LocalObjectStore } from '@solus/server/sync/git-storage/local-object-store'
import { sessionCodeKey } from '@solus/server/sync/git-storage/object-store'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const root = mkdtempSync(join(tmpdir(), 'solus-session-code-'))
afterAll(async () => {
  rmSync(root, { recursive: true, force: true })
  await resetTestDatabase()
})

const bytes = Buffer.from('a code bundle')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const key = sessionCodeKey('person:alice', 'session-1', sha256)
const secret = Buffer.alloc(32, 7)

function put(url: string, body: Uint8Array, headers: { length?: string; checksum?: string } = {}): Request {
  return new Request(new URL(url, 'https://api.test'), {
    method: 'PUT', body,
    headers: { 'content-length': headers.length ?? String(body.byteLength), 'x-amz-checksum-sha256': headers.checksum ?? createHash('sha256').update(body).digest('base64') },
  })
}
const keyOf = (url: string) => decodeURIComponent(new URL(url, 'https://api.test').pathname.slice('/runner/session-code/'.length))
const tokenOf = (url: string) => new URL(url, 'https://api.test').searchParams.get('token') ?? ''

// WHY: a signer that differs from SigV4 in one byte gives URLs that R2 refuses. AWS publishes this presigned GET.
test('the S3 signer gives the AWS example URL', () => {
  const url = presignS3Url({
    method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    now: new Date('2013-05-24T00:00:00Z'), expiresSeconds: 86400, headers: [],
  })
  expect(url).toBe('https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404')
})

// WHY: R2 must refuse bytes other than the bundle that the API signed, and the URL must name only that key.
test('an R2 write URL signs the length and the checksum of one key for 15 minutes', async () => {
  const store = new R2ObjectStore('a'.repeat(32), 'solus-sessions-test', 'access-key', 'secret-key', () => new Date('2026-11-26T10:00:00Z'))
  const write = new URL(await store.signedUrl(key, 'write', { bytes: bytes.byteLength, sha256 }))
  expect(write.origin).toBe(`https://${'a'.repeat(32)}.r2.cloudflarestorage.com`)
  expect(write.pathname).toBe(`/solus-sessions-test/sessions/person%3Aalice/session-1/${sha256}`)
  expect(write.searchParams.get('X-Amz-Credential')).toBe('access-key/20261126/auto/s3/aws4_request')
  expect(write.searchParams.get('X-Amz-Expires')).toBe('900')
  expect(write.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host;x-amz-checksum-sha256')
  expect(write.toString()).toBe(presignS3Url({
    method: 'PUT', host: `${'a'.repeat(32)}.r2.cloudflarestorage.com`, path: `/solus-sessions-test/sessions/person%3Aalice/session-1/${sha256}`,
    region: 'auto', accessKeyId: 'access-key', secretAccessKey: 'secret-key', now: new Date('2026-11-26T10:00:00Z'), expiresSeconds: 900,
    headers: [['content-length', String(bytes.byteLength)], ['x-amz-checksum-sha256', createHash('sha256').update(bytes).digest('base64')]],
  }))
  const read = new URL(await store.signedUrl(key, 'read', { bytes: bytes.byteLength, sha256 }))
  expect(read.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
  expect(read.searchParams.get('X-Amz-Signature')).not.toBe(write.searchParams.get('X-Amz-Signature'))
})

// WHY: a local-git API stands in for R2, so it must refuse what R2 refuses: an old, changed, or reused URL and other bytes.
test('the local store accepts a good signature and refuses an old or changed one and a wrong hash', async () => {
  let now = 1_000_000
  const store = new LocalObjectStore(join(root, 'store'), secret, () => now)
  const writeUrl = await store.signedUrl(key, 'write', { bytes: bytes.byteLength, sha256 })
  expect(keyOf(writeUrl)).toBe(key)
  const token = tokenOf(writeUrl)

  expect((await store.receive(key, token, put(writeUrl, Buffer.from('other bundle!')))).status).toBe(403)
  expect((await store.receive(key, token, put(writeUrl, Buffer.from('other bundle!'), { checksum: createHash('sha256').update(bytes).digest('base64') }))).status).toBe(400)
  expect((await store.receive(sessionCodeKey('person:alice', 'session-2', sha256), token, put(writeUrl, bytes))).status).toBe(403)
  expect((await store.receive(key, token.replace(/.$/, token.endsWith('A') ? 'B' : 'A'), put(writeUrl, bytes))).status).toBe(403)
  const otherSecret = new LocalObjectStore(join(root, 'store'), Buffer.alloc(32, 8), () => now)
  expect((await store.receive(key, tokenOf(await otherSecret.signedUrl(key, 'write', { bytes: bytes.byteLength, sha256 })), put(writeUrl, bytes))).status).toBe(403)
  const otherBytes = await store.signedUrl(key, 'write', { bytes: bytes.byteLength + 1, sha256 })
  expect((await store.receive(key, tokenOf(otherBytes), put(writeUrl, bytes))).status).toBe(403)
  expect(await readdir(join(root, 'store', 'sessions', 'person:alice', 'session-1'))).toEqual([])

  expect((await store.receive(key, token, put(writeUrl, bytes))).status).toBe(200)
  expect((await store.receive(key, token, put(writeUrl, bytes))).status).toBe(200)
  expect((await store.serve(key, token)).status).toBe(403)

  const readUrl = await store.signedUrl(key, 'read', { bytes: bytes.byteLength, sha256 })
  const read = await store.serve(key, tokenOf(readUrl))
  expect(read.status).toBe(200)
  expect(Buffer.from(await read.arrayBuffer())).toEqual(bytes)

  now += 900_001
  expect((await store.serve(key, tokenOf(readUrl))).status).toBe(403)
  expect((await store.receive(key, token, put(writeUrl, bytes))).status).toBe(403)
})

// WHY: cloudflare-artifacts without R2 would push sessions whose code no host can fetch.
test('startup refuses cloudflare-artifacts without the R2 settings', async () => {
  const { getDatabase } = await import('@solus/server/db/database')
  const { sessionRemoteProvider } = await import('@solus/server/sync/sessions/session-remote-provider')
  const artifacts = { SOLUS_SESSION_STORAGE: 'cloudflare-artifacts', SOLUS_ARTIFACTS_ACCOUNT_ID: 'a'.repeat(32), SOLUS_SESSION_ARTIFACTS_NAMESPACE: 'sessions', SOLUS_ARTIFACTS_API_TOKEN: 'server-secret' }
  await expect(sessionRemoteProvider(getDatabase(), artifacts)).rejects.toThrow('SOLUS_SESSION_R2_BUCKET, SOLUS_R2_ACCESS_KEY_ID, SOLUS_R2_SECRET_ACCESS_KEY')
  await expect(sessionRemoteProvider(getDatabase(), { ...artifacts, SOLUS_SESSION_R2_BUCKET: 'solus-sessions-test', SOLUS_R2_ACCESS_KEY_ID: 'id' })).rejects.toThrow('needs SOLUS_R2_SECRET_ACCESS_KEY.')
  const storage = await sessionRemoteProvider(getDatabase(), { ...artifacts, SOLUS_SESSION_R2_BUCKET: 'solus-sessions-test', SOLUS_R2_ACCESS_KEY_ID: 'id', SOLUS_R2_SECRET_ACCESS_KEY: 'key' })
  expect(storage?.code.storageScope).toBe(`r2://${'a'.repeat(32)}/solus-sessions-test`)
  expect((await sessionRemoteProvider(getDatabase(), { SOLUS_SESSION_STORAGE: 'local-git' }))?.code).toBeInstanceOf(LocalObjectStore)
})

// WHY: the host must announce format 2, reach a local store through the API address, and wait when storage is off.
test('the host client sends format 2 and resolves a code URL against the Solus API', async () => {
  const { DelegatedSessionRemoteAccess } = await import('@solus/server/sync/sessions/session-remote-access')
  type Registration = ConstructorParameters<typeof DelegatedSessionRemoteAccess>[0]
  type Delegations = ConstructorParameters<typeof DelegatedSessionRemoteAccess>[1]
  const bodies: Array<{ path: string; body: { format?: number; sha256?: string; hostId?: string } }> = []
  let status = 200
  const access = new DelegatedSessionRemoteAccess(
    // SAFETY: the client reads only these registration fields.
    (() => ({ hostId: 'host-b', apiUrl: 'https://api.example.invalid/' })) as Registration,
    // SAFETY: the client uses only accessToken.
    { accessToken: async () => 'delegation' } as unknown as Delegations,
    async (url, init) => {
      bodies.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) })
      return status === 200 ? Response.json({ url: '/runner/session-code/sessions/person%3Aalice/s/x?token=t', expiresAt: new Date().toISOString() }) : new Response(null, { status })
    },
  )
  const identity = { cloudScope: 'person:alice', actorUserId: 'alice' } as const
  const request = { sessionId: 's', sha256, bytes: 4, access: 'write' } as const
  expect(await access.codeUrl(request, identity)).toEqual({ status: 'ready', url: 'https://api.example.invalid/runner/session-code/sessions/person%3Aalice/s/x?token=t' })
  expect(bodies.at(-1)).toEqual({ path: '/runner/session-repositories/code', body: { hostId: 'host-b', ...request } })
  for (status of [404, 503]) expect(await access.codeUrl(request, identity)).toEqual({ status: 'unavailable' })
  await access.remote('s', identity, 'read')
  expect(bodies.at(-1)?.body.format).toBe(2)
})
