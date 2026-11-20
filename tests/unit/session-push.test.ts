import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { emptySessionManifest } from '@solus/server/sync/sessions/session-manifest'
import type { SessionRemoteAccess } from '@solus/server/sync/sessions/session-remote-access'
import type { SessionPushDeps } from '@solus/server/sync/sessions/session-push'
import type { SessionRepositories as Repositories, SessionRepository } from '@solus/server/sync/sessions/session-repository'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const root = mkdtempSync(join(tmpdir(), 'solus-session-push-'))
process.env.SOLUS_DATA_DIR = root
let SessionPusher: typeof import('@solus/server/sync/sessions/session-push').SessionPusher
let SessionRepositories: typeof import('@solus/server/sync/sessions/session-repository').SessionRepositories
let repositoryName: typeof import('@solus/server/sync/sessions/session-repository').sessionRepositoryName
beforeAll(async () => {
  SessionPusher = (await import('@solus/server/sync/sessions/session-push')).SessionPusher
  const repository = await import('@solus/server/sync/sessions/session-repository')
  SessionRepositories = repository.SessionRepositories
  repositoryName = repository.sessionRepositoryName
  ;(await import('@solus/server/execution/seats/acting-identity')).actAsHostForTests()
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

type Push = SessionRepository['push']

/** `repos`, with each push of each copy sent through `push`. `real` is the push of the copy. */
function withPush(repos: Repositories, push: (real: Push, ...args: Parameters<Push>) => ReturnType<Push>): void {
  const named = repos.named.bind(repos)
  repos.named = (...args) => {
    const repository = named(...args)
    const real = repository.push.bind(repository)
    repository.push = (...pushArgs) => push(real, ...pushArgs)
    return repository
  }
}

let serial = 0
async function fixture() {
  const folder = join(root, String(++serial))
  const repos = new SessionRepositories(join(folder, 'local'))
  const repository = repositoryName('local', 'test-session')
  const remote = join(folder, 'remote.git')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote])
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE session_storage (session_id TEXT PRIMARY KEY, repository TEXT, head TEXT, turn_count INTEGER,
    cloud_scope TEXT, pushed_head TEXT, reported_head TEXT, push_due_at INTEGER, push_attempts INTEGER DEFAULT 0,
    push_error TEXT, push_refused_head TEXT)`)
  const manifest = emptySessionManifest('test-session', 'local')
  manifest.turns.push({ operationId: 'one', endedAt: 1, provider: 'codex', threadId: 'thread', partial: false,
    head: null, snapshots: [], bundle: null, hasDiff: false })
  const first = await repos.named(repository).commit({ expectedHead: null, message: 'first', entries: [{ path: 'manifest.json', content: JSON.stringify(manifest) }] })
  db.prepare('INSERT INTO session_storage (session_id, repository, head, turn_count) VALUES (?, ?, ?, 1)').run('test-session', repository, first)
  const reports: string[] = []
  const access: SessionRemoteAccess = {
    remote: async () => ({ status: 'ready', remote: { repository, remote: pathToFileURL(remote).href, token: '', expiresAt: new Date().toISOString(),
      storageScope: 'test', head: null, syncedTurn: 0, lastRunHostId: null, runningHostId: null } }),
    report: async request => { reports.push(request.event); return 'accepted' },
  }
  // SAFETY: the push reads only these fields from this fixed test record.
  const record: SessionPushDeps['record'] = async () => ({ ownerKey: 'account:person', organizationId: 'local', publication: 'local',
    provider: 'codex' } as NonNullable<Awaited<ReturnType<NonNullable<SessionPushDeps['record']>>>>)
  const deps: SessionPushDeps = { repositories: repos, access, hostId: () => 'host', database: () => db, record,
    accountOf: () => 'person', decision: () => ({ allowed: true }) }
  const row = () => db.prepare('SELECT * FROM session_storage WHERE session_id = ?').get('test-session') as { pushed_head: string | null; reported_head: string | null; push_refused_head: string | null }
  const remoteHead = () => execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim()
  return { repos, repository, remote, db, first, reports, deps, row, remoteHead }
}

// WHY: A confirmed commit must reach the remote, then the API, without another turn.
test('first push and report', async () => {
  const f = await fixture()
  const pusher = new SessionPusher(f.deps)
  pusher.committed('test-session')
  await pusher.idle()
  expect(f.remoteHead()).toBe(f.first)
  expect(f.row().pushed_head).toBe(f.first)
  expect(f.row().reported_head).toBe(f.first)
  expect(f.reports).toEqual(['pushed'])
  await pusher.stop()
  f.db.close()
})

// WHY: A restart after the remote accepted a push must record its head without replacing it.
test('lost response is reconciled from the remote', async () => {
  const f = await fixture()
  expect((await f.repos.named(f.repository).push(pathToFileURL(f.remote).href, f.first, null)).status).toBe('accepted')
  const pusher = new SessionPusher(f.deps)
  pusher.resume()
  await pusher.idle()
  expect(f.row().pushed_head).toBe(f.first)
  expect(f.remoteHead()).toBe(f.first)
  await pusher.stop()
  f.db.close()
})

// WHY: A report retry must not send the same Git history a second time.
test('report resumes after the pushed row is durable', async () => {
  const f = await fixture()
  await f.repos.named(f.repository).push(pathToFileURL(f.remote).href, f.first, null)
  f.db.prepare('UPDATE session_storage SET pushed_head = ?').run(f.first)
  const pusher = new SessionPusher(f.deps)
  pusher.resume()
  await pusher.idle()
  expect(f.row().reported_head).toBe(f.first)
  expect(f.reports).toEqual(['pushed'])
  await pusher.stop()
  f.db.close()
})

// WHY: A policy refusal must leave local history and the cloud repository alone.
test('policy off does not push', async () => {
  const f = await fixture()
  const pusher = new SessionPusher({ ...f.deps, decision: () => ({ allowed: false, reason: 'setting-off' }) })
  pusher.committed('test-session')
  await pusher.idle()
  expect(f.row().pushed_head).toBeNull()
  await pusher.stop()
  f.db.close()
})

// WHY: A later turn must advance the same remote ref and report the new turn count.
test('next push advances main', async () => {
  const f = await fixture()
  const pusher = new SessionPusher(f.deps)
  pusher.committed('test-session')
  await pusher.idle()
  const manifest = emptySessionManifest('test-session', 'local')
  manifest.turns.push({ operationId: 'one', endedAt: 1, provider: 'codex', threadId: 'thread', partial: false,
    head: null, snapshots: [], bundle: null, hasDiff: false })
  manifest.turns.push({ operationId: 'two', endedAt: 2, provider: 'codex', threadId: 'thread', partial: false,
    head: null, snapshots: [], bundle: null, hasDiff: false })
  const second = await f.repos.named(f.repository).commit({ expectedHead: f.first, message: 'second', entries: [
    { path: 'manifest.json', content: JSON.stringify(manifest) },
  ] })
  f.db.prepare('UPDATE session_storage SET head = ?, turn_count = 2').run(second)
  pusher.committed('test-session')
  await pusher.idle()
  expect(f.remoteHead()).toBe(second)
  expect(f.row().reported_head).toBe(second)
  await pusher.stop()
  f.db.close()
})

// WHY: A host must not overwrite turns that another host pushed first.
test('divergent remote is refused and stays unchanged', async () => {
  const f = await fixture()
  await f.repos.named(f.repository).push(pathToFileURL(f.remote).href, f.first, null)
  f.db.prepare('UPDATE session_storage SET pushed_head = ?, reported_head = ?').run(f.first, f.first)
  const second = await f.repos.named(f.repository).commit({ expectedHead: f.first, message: 'our turn', entries: [
    { path: 'other', content: 'ours' },
  ] })
  f.db.prepare('UPDATE session_storage SET head = ?, turn_count = 2').run(second)
  const remoteCopy = join(root, String(serial), 'other.git')
  execFileSync('git', ['clone', '--bare', pathToFileURL(f.remote).href, remoteCopy])
  const tree = execFileSync('git', ['--git-dir', remoteCopy, 'rev-parse', `${f.first}^{tree}`], { encoding: 'utf8' }).trim()
  const competing = execFileSync('git', ['--git-dir', remoteCopy, 'commit-tree', tree, '-p', f.first, '-m', 'other turn'], {
    encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
  }).trim()
  execFileSync('git', ['--git-dir', remoteCopy, 'push', '--force', pathToFileURL(f.remote).href, `${competing}:refs/heads/main`])
  const pusher = new SessionPusher(f.deps)
  pusher.resume()
  await pusher.idle()
  expect(f.remoteHead()).toBe(competing)
  expect(pusher.refusedHead('test-session')).toBe(competing)
  await pusher.stop()
  f.db.close()
})

// WHY: A missing delegation leaves a durable retry; sign-in can start the backlog at once.
test('missing delegation retries when established', async () => {
  const f = await fixture()
  let available = false
  const access: SessionRemoteAccess = { ...f.deps.access,
    remote: async (...args) => {
      if (!available) throw new (await import('@solus/server/sync/delegations')).DelegationError('ORGANIZATION_AUTHORITY_MISSING', 'no grant')
      return f.deps.access.remote(...args)
    },
  }
  const pusher = new SessionPusher({ ...f.deps, access })
  pusher.resume()
  await pusher.idle()
  expect(f.row().pushed_head).toBeNull()
  available = true
  pusher.established()
  await pusher.idle()
  expect(f.row().pushed_head).toBe(f.first)
  await pusher.stop()
  f.db.close()
})

// WHY: A remote that hangs must not hold the next local turn commit.
test('a hanging push does not delay a turn commit', async () => {
  const f = await fixture()
  let started = () => {}
  const entered = new Promise<void>(resolve => { started = resolve })
  let release = () => {}
  const hanging = new Promise<void>(resolve => { release = resolve })
  withPush(f.repos, async (real, ...args) => { started(); await hanging; return real(...args) })
  const pusher = new SessionPusher(f.deps)
  pusher.committed('test-session')
  await entered
  const next = await f.repos.named(f.repository).commit({ expectedHead: f.first, message: 'next', entries: [
    { path: 'next', content: 'local turn' },
  ] })
  expect(next).not.toBe(f.first)
  release()
  await pusher.idle()
  await pusher.stop()
  f.db.close()
})

// WHY: A signed-out host must cancel its in-flight push job.
test('sign-out stops an in-flight push', async () => {
  const f = await fixture()
  let started = () => {}
  const entered = new Promise<void>(resolve => { started = resolve })
  let release = () => {}
  const hanging = new Promise<void>(resolve => { release = resolve })
  withPush(f.repos, async (_real, _remote, _commit, _expected, _token, signal) => {
    started()
    await hanging
    return { status: 'failed', reason: signal?.aborted ? 'timeout' : 'transport' }
  })
  const pusher = new SessionPusher(f.deps)
  pusher.committed('test-session')
  await entered
  pusher.signedOut()
  release()
  await pusher.idle()
  expect(f.row().pushed_head).toBeNull()
  await pusher.stop()
  f.db.close()
})
