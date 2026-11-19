import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { SessionRepositoryTokenResponse } from '@solus/contracts/session-repositories'
import type { HostRegistration } from '@solus/contracts/uplink'
import type { Delegations } from '@solus/server/sync/delegations'

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
const head = await source.commit(repository, { expectedHead: null, message: 'turn one', entries: [{ path: 'manifest.json', content: '{}' }] })
const second = await source.commit(repository, { expectedHead: head, message: 'turn two', entries: [{ path: 'manifest.json', content: '{"turn":2}' }] })
const remotePath = join(root, 'source', `${repository}.git`)
const access = async (): Promise<SessionRepositoryTokenResponse> => ({
  repository, remote: pathToFileURL(remotePath).href, token: '', expiresAt: new Date(Date.now() + 60_000).toISOString(), storageScope: 'test',
  head: second, syncedTurn: 2, lastRunHostId: 'host-a', runningHostId: null,
})
const signal = new AbortController().signal

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
    const answer = await route.remote('cloud-test', 'person:person', 'person', 'read')
    return answer.status === 'ready' ? answer.remote : null
  }, null, 'cloud-test', HOST_ACTOR, null, second, join(root, 'route'), signal)
  expect(result).toMatchObject({ state: 'ready', head: second, source: 'cloud' })
  expect(requests).toBe(1)
})

// WHY: Adopting the winning cloud head must keep refused local turns reachable for a later fork.
test('a divergent local head stays under a ref when cloud wins', async () => {
  const local = new SessionRepositories(join(root, 'refused-local'))
  const localHead = await local.commit(repository, { expectedHead: null, message: 'local turn', entries: [{ path: 'manifest.json', content: 'local' }] })
  expect(await local.fetchBundle(repository, remotePath, true)).toBe(second)
  expect(await local.head(repository)).toBe(second)
  const { execFileSync } = await import('node:child_process')
  expect(execFileSync('git', ['--git-dir', join(root, 'refused-local', `${repository}.git`), 'rev-parse', `refs/solus/refused/${localHead}`], { encoding: 'utf8' }).trim()).toBe(localHead)
})

// WHY: an empty destination must get the full cloud history without a host relay.
test('cloud source gives a ready bare repository', async () => {
  const result = await fetchSessionArtifacts(access, null, 'cloud-test', HOST_ACTOR, null, second, join(root, 'ready'), signal)
  expect(result).toMatchObject({ state: 'ready', head: second, source: 'cloud' })
  if (result.state === 'ready') expect(await new SessionRepositories(join(root, 'target')).fetchBundle(repository, result.repositoryPath)).toBe(second)
})

// WHY: an equal head avoids restoring the same turn again.
test('cloud source reports current', async () => {
  expect(await fetchSessionArtifacts(access, remotePath, 'cloud-test', HOST_ACTOR, second, second, join(root, 'current'), signal)).toEqual({ state: 'current' })
})

// WHY: the destination must not replace an unrelated local history.
test('cloud source reports diverged', async () => {
  const other = new SessionRepositories(join(root, 'other'))
  const otherHead = await other.commit(repository, { expectedHead: null, message: 'other', entries: [{ path: 'manifest.json', content: 'other' }] })
  expect(await fetchSessionArtifacts(access, join(root, 'other', `${repository}.git`), 'cloud-test', HOST_ACTOR, otherHead, null, join(root, 'diverged'), signal)).toEqual({ state: 'diverged' })
})

// WHY: the last run host can hold a turn that cloud storage has not received.
test('cloud source reports a missing wanted head', async () => {
  const olderPath = join(root, 'older.git')
  const { spawnSync } = await import('node:child_process')
  expect(spawnSync('git', ['clone', '--bare', remotePath, olderPath]).status).toBe(0)
  expect(spawnSync('git', ['--git-dir', olderPath, 'update-ref', 'refs/heads/main', head]).status).toBe(0)
  const older = async () => ({ ...await access(), remote: pathToFileURL(olderPath).href })
  expect(await fetchSessionArtifacts(older, null, 'cloud-test', HOST_ACTOR, null, second, join(root, 'missing'), signal)).toEqual({ state: 'no-repository' })
  expect(await fetchSessionArtifacts(async () => null, null, 'cloud-test', HOST_ACTOR, null, second, join(root, 'absent'), signal)).toEqual({ state: 'no-repository' })
})

// WHY: a turn that has not reached cloud storage must still be fetched from its last run host.
test('a cloud copy behind the wanted head uses the host path', async () => {
  const { chooseSessionRepositorySource } = await import('@solus/server/execution/sessions/session-artifacts-source')
  let hostCalls = 0
  const result = await chooseSessionRepositorySource(
    () => fetchSessionArtifacts(async () => ({ ...await access(), remote: pathToFileURL(join(root, 'older.git')).href }), null, 'cloud-test', HOST_ACTOR, null, second, join(root, 'fallback'), signal),
    async () => { hostCalls++; return { state: 'ready', repositoryPath: remotePath, head: second, source: 'host' } },
  )
  expect(result).toMatchObject({ state: 'ready', source: 'host', head: second })
  expect(hostCalls).toBe(1)
})
