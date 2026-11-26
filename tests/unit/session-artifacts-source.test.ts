import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { SessionRepositoryTokenResponse } from '@solus/contracts/session-repositories'
import type { HostRegistration } from '@solus/contracts/uplink'
import type { Delegations } from '@solus/server/sync/delegations'
import type { SessionSourceRequest } from '@solus/server/execution/sessions/session-sync'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { actAsHostForTests } = await import('@solus/server/execution/seats/acting-identity')
actAsHostForTests()
const { fetchSessionArtifacts } = await import('@solus/server/execution/sessions/session-artifacts-source')
const { SessionRepositories, sessionRepositoryName } = await import('@solus/server/sync/sessions/session-repository')
const { HOST_ACTOR } = await import('@solus/server/admission/actor')
const root = mkdtempSync(join(tmpdir(), 'solus-artifacts-source-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const repository = sessionRepositoryName('local', 'cloud-test')
const source = new SessionRepositories(join(root, 'source'))
const { emptySessionManifest } = await import('@solus/server/sync/sessions/session-manifest')
const head = await source.named(repository).commit({ expectedHead: null, message: 'turn one', entries: [{ path: 'manifest.json', content: JSON.stringify(emptySessionManifest('cloud-test', 'local')) }] })
const second = await source.named(repository).commit({ expectedHead: head, message: 'turn two', entries: [{ path: 'manifest.json',
  content: JSON.stringify({ ...emptySessionManifest('cloud-test', 'local'), session: { id: 'cloud-test', organizationId: 'local', title: 'Turn two' } }) }] })
const remotePath = source.named(repository).path
const access = async (): Promise<SessionRepositoryTokenResponse> => ({
  repository, remote: pathToFileURL(remotePath).href, token: '', expiresAt: new Date(Date.now() + 60_000).toISOString(), storageScope: 'test',
  head: second, syncedTurn: 2, lastRunHostId: 'host-a', runningHostId: null,
})
const signal = new AbortController().signal
/** A cloud with no code bundle. */
const noCode = async () => null
/** A request for the cloud test session. `outFile` is a name under the test root. */
function sourceRequest(have: string | null, wantedHead: string | null, outFile: string, stop: AbortSignal = signal): SessionSourceRequest {
  return { sessionId: 'cloud-test', have, wantedHead, sourceHostId: undefined, outFile: join(root, outFile), signal: stop, actor: HOST_ACTOR }
}

// WHY: The real route client must give the cloud fetch a remote for a session this host has not seen.
test('delegated token route feeds a cloud fetch', async () => {
  const { DelegatedSessionRemoteAccess } = await import('@solus/server/sync/sessions/session-remote-access')
  let requests = 0
  const route = new DelegatedSessionRemoteAccess(
    // SAFETY: the token route uses only these registration fields.
    () => ({ hostId: 'host-b', apiUrl: 'https://api.example.invalid/' }) as HostRegistration,
    // SAFETY: the route uses only accessToken.
    { accessToken: async () => 'delegation' } as Delegations,
    async (_url, init) => {
      requests++
      expect(init?.method).toBe('POST')
      return Response.json(await access())
    },
  )
  const result = await fetchSessionArtifacts(async () => {
    const answer = await route.remote('cloud-test', { cloudScope: 'person:person', actorUserId: 'person' }, 'read')
    return answer.status === 'ready' ? answer.remote : null
  }, noCode, null, sourceRequest(null, second, 'route'))
  expect(result).toMatchObject({ state: 'ready', head: second, source: 'cloud' })
  expect(requests).toBe(1)
})

// WHY: Adopting the winning cloud head must keep refused local turns reachable for a later fork.
test('a divergent local head stays under a ref when cloud wins', async () => {
  const local = new SessionRepositories(join(root, 'refused-local'))
  const localHead = await local.named(repository).commit({ expectedHead: null, message: 'local turn', entries: [{ path: 'manifest.json', content: 'local' }] })
  expect(await local.named(repository).fetchBundle(remotePath, true)).toBe(second)
  expect(await local.named(repository).head()).toBe(second)
  const { execFileSync } = await import('node:child_process')
  expect(execFileSync('git', ['--git-dir', local.named(repository).path, 'rev-parse', `refs/solus/refused/${localHead}`], { encoding: 'utf8' }).trim()).toBe(localHead)
})

// WHY: an empty destination must get the full cloud history without a host relay.
test('cloud source gives a ready bare repository', async () => {
  const result = await fetchSessionArtifacts(access, noCode, null, sourceRequest(null, second, 'ready'))
  expect(result).toMatchObject({ state: 'ready', head: second, source: 'cloud' })
  if (result.state === 'ready') expect(await new SessionRepositories(join(root, 'target')).named(repository).fetchBundle(result.repositoryPath)).toBe(second)
})

// WHY: an equal head avoids restoring the same turn again.
test('cloud source reports current', async () => {
  expect(await fetchSessionArtifacts(access, noCode, remotePath, sourceRequest(second, second, 'current'))).toEqual({ state: 'current' })
})

// WHY: the destination must not replace an unrelated local history.
test('cloud source reports diverged', async () => {
  const other = new SessionRepositories(join(root, 'other'))
  const otherHead = await other.named(repository).commit({ expectedHead: null, message: 'other', entries: [{ path: 'manifest.json', content: 'other' }] })
  expect(await fetchSessionArtifacts(access, noCode, other.named(repository).path, sourceRequest(otherHead, null, 'diverged'))).toEqual({ state: 'diverged' })
})

// WHY: the last run host can hold a turn that cloud storage has not received.
test('cloud source reports a missing wanted head', async () => {
  const olderPath = join(root, 'older.git')
  const { spawnSync } = await import('node:child_process')
  expect(spawnSync('git', ['clone', '--bare', remotePath, olderPath]).status).toBe(0)
  expect(spawnSync('git', ['--git-dir', olderPath, 'update-ref', 'refs/heads/main', head]).status).toBe(0)
  const older = async () => ({ ...await access(), remote: pathToFileURL(olderPath).href })
  expect(await fetchSessionArtifacts(older, noCode, null, sourceRequest(null, second, 'missing'))).toEqual({ state: 'no-repository' })
  expect(await fetchSessionArtifacts(async () => null, noCode, null, sourceRequest(null, second, 'absent'))).toEqual({ state: 'no-repository' })
})

// WHY: a turn that has not reached cloud storage must still be fetched from its last run host.
test('a cloud copy behind the wanted head uses the host path', async () => {
  const { chooseSessionRepositorySource } = await import('@solus/server/execution/sessions/session-artifacts-source')
  let hostCalls = 0
  const result = await chooseSessionRepositorySource(
    request => fetchSessionArtifacts(async () => ({ ...await access(), remote: pathToFileURL(join(root, 'older.git')).href }), noCode, null, request),
    async () => { hostCalls++; return { state: 'ready', repositoryPath: remotePath, head: second, source: 'host' } },
    sourceRequest(null, second, 'fallback'),
  )
  expect(result).toMatchObject({ state: 'ready', source: 'host', head: second })
  expect(hostCalls).toBe(1)
})

// WHY: A background push can finish after the next host asks for a turn; an offline source must not lose that turn.
test('cloud catches up after the source host is offline', async () => {
  const { chooseSessionRepositorySource } = await import('@solus/server/execution/sessions/session-artifacts-source')
  const { SessionSyncError } = await import('@solus/server/execution/sessions/session-sync')
  const { execFileSync } = await import('node:child_process')
  const delayedPath = join(root, 'delayed.git')
  execFileSync('git', ['clone', '--bare', remotePath, delayedPath])
  execFileSync('git', ['--git-dir', delayedPath, 'update-ref', 'refs/heads/main', head])
  const push = setTimeout(() => execFileSync('git', ['--git-dir', remotePath, 'push', delayedPath, `${second}:refs/heads/main`]), 650)
  try {
    const result = await chooseSessionRepositorySource(
      // Each try of the cloud source writes its own repository.
      request => fetchSessionArtifacts(async () => ({ ...await access(), remote: pathToFileURL(delayedPath).href }), noCode, null, { ...request, outFile: join(root, `delayed-${Math.random()}`) }),
      async () => { throw new SessionSyncError('source-offline', 'Host A is offline.') },
      sourceRequest(null, second, 'delayed'),
    )
    expect(result).toMatchObject({ state: 'ready', head: second, source: 'cloud' })
  } finally { clearTimeout(push) }
})

// WHY: Stop must end a fetch wait even when a cloud push never arrives.
test('stop cancels the cloud catch-up wait', async () => {
  const { chooseSessionRepositorySource } = await import('@solus/server/execution/sessions/session-artifacts-source')
  const { SessionSyncError } = await import('@solus/server/execution/sessions/session-sync')
  const controller = new AbortController()
  const pending = chooseSessionRepositorySource(
    async () => ({ state: 'no-repository' }),
    async () => { throw new SessionSyncError('source-offline', 'Host A is offline.') },
    sourceRequest(null, second, 'stopped', controller.signal),
  )
  setTimeout(() => controller.abort(new Error('Stopped')), 50)
  await expect(pending).rejects.toThrow('Stopped')
})

/** A `fetch` that gives each request a new copy of one answer. */
function fetchAnswering(answer: () => Response): typeof fetch {
  // SAFETY: the cloud fetch calls only the function; it reads no other member of `fetch`.
  return (async () => answer()) as unknown as typeof fetch
}

/** A cloud copy whose manifest names one stored code bundle that only the object store has. */
async function cloudWithBundle(name: string, bytes: Buffer) {
  const { createHash } = await import('node:crypto')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const cloud = new SessionRepositories(join(root, name))
  const manifest = emptySessionManifest('cloud-test', 'local')
  manifest.turns.push({ operationId: 'turn', endedAt: 1, provider: 'codex', threadId: 'thread', partial: false, head: null, snapshots: [],
    bundle: { kind: 'stored', sha256, bytes: bytes.length, refs: {} }, hasDiff: false })
  const cloudHead = await cloud.named(repository).commit({ expectedHead: null, message: 'turn', entries: [{ path: 'manifest.json', content: JSON.stringify(manifest) }] })
  const cloudAccess = async (): Promise<SessionRepositoryTokenResponse> => ({ ...await access(), remote: pathToFileURL(cloud.named(repository).path).href, head: cloudHead })
  const urls: string[] = []
  const codeUrl = async (request: { sha256: string }) => { urls.push(request.sha256); return `https://code.example.invalid/${request.sha256}` }
  return { sha256, cloudHead, cloudAccess, codeUrl, urls }
}

// WHY: the code bundles are in R2, not in the cloud repository. Host B must get each one
// before it restores the code, and keep it where a later push and restore read it.
test('a cloud fetch downloads each stored bundle and keeps it under its code ref', async () => {
  const bytes = Buffer.from('the code bundle of the turn\n')
  const cloud = await cloudWithBundle('code-cloud', bytes)
  const fetchImpl = fetchAnswering(() => new Response(bytes))
  const result = await fetchSessionArtifacts(cloud.cloudAccess, cloud.codeUrl, null, sourceRequest(null, null, 'code-ready'), fetchImpl)
  expect(result).toMatchObject({ state: 'ready', head: cloud.cloudHead, source: 'cloud' })
  expect(cloud.urls).toEqual([cloud.sha256])
  if (result.state !== 'ready') throw new Error('The fetch is not ready.')
  const target = new SessionRepositories(join(root, 'code-target'))
  expect(await target.named(repository).fetchBundle(result.repositoryPath)).toBe(cloud.cloudHead)
  const out = join(root, 'code-target.bundle')
  await target.named(repository).writeCodeBundle(cloud.sha256, out)
  expect((await import('node:fs')).readFileSync(out).equals(bytes)).toBe(true)
})

// WHY: a code bundle that is not the one the manifest names would restore other code.
test('a cloud fetch refuses a bundle whose SHA-256 does not match', async () => {
  const { SessionSyncError } = await import('@solus/server/execution/sessions/session-sync')
  const bytes = Buffer.from('the code bundle of the turn\n')
  const cloud = await cloudWithBundle('bad-hash-cloud', bytes)
  const changed = Buffer.from(bytes)
  changed[0] = 0x54
  const fetchImpl = fetchAnswering(() => new Response(changed))
  const failure = await fetchSessionArtifacts(cloud.cloudAccess, cloud.codeUrl, null, sourceRequest(null, null, 'bad-hash'), fetchImpl).catch((error) => error)
  expect(failure).toBeInstanceOf(SessionSyncError)
  expect(failure.reason).toBe('code-restore')
})

// WHY: a cloud copy without its code cannot be restored, and the sync must say so, not try another copy.
test('a missing bundle fails the sync with code-restore', async () => {
  const { chooseSessionRepositorySource } = await import('@solus/server/execution/sessions/session-artifacts-source')
  const bytes = Buffer.from('the code bundle of the turn\n')
  const cloud = await cloudWithBundle('missing-cloud', bytes)
  const fetchImpl = fetchAnswering(() => new Response('not found', { status: 404 }))
  let hostCalls = 0
  const failure = await chooseSessionRepositorySource(
    request => fetchSessionArtifacts(cloud.cloudAccess, cloud.codeUrl, null, request, fetchImpl),
    async () => { hostCalls++; return { state: 'no-repository' } },
    sourceRequest(null, null, 'missing-code'),
  ).catch((error) => error)
  expect(failure.reason).toBe('code-restore')
  expect(hostCalls).toBe(0)
})
