import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

/** The signed code URLs that the fake API gives, and the store that answers each `PUT`. */
function codeStore(events: string[]) {
  const objects = new Map<string, Buffer>()
  const codeUrl: SessionRemoteAccess['codeUrl'] = async request => ({ status: 'ready', url: `https://code.example.invalid/${request.sha256}?bytes=${request.bytes}` })
  // SAFETY: the pusher calls only the function; it reads no other member of `fetch`.
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const sha256 = url.pathname.slice(1)
    const headers = new Headers(init?.headers)
    const body = Buffer.from(await new Response(init?.body).arrayBuffer())
    // WHY: R2 and the local folder store refuse a PUT without the signed length and SHA-256.
    if (init?.method !== 'PUT' || headers.get('content-length') !== url.searchParams.get('bytes')
      || headers.get('x-amz-checksum-sha256') !== Buffer.from(sha256, 'hex').toString('base64')
      || createHash('sha256').update(body).digest('hex') !== sha256) return new Response('refused', { status: 400 })
    objects.set(sha256, body)
    events.push(`upload ${sha256}`)
    return new Response(null, { status: 200 })
  }) as typeof fetch
  return { objects, codeUrl, fetchImpl }
}

let serial = 0
async function fixture(schemaVersion: 1 | 2 = 2) {
  const folder = join(root, String(++serial))
  const repos = new SessionRepositories(join(folder, 'local'))
  const repository = repositoryName('local', 'test-session')
  const remote = join(folder, 'remote.git')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote])
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE session_storage (session_id TEXT PRIMARY KEY, repository TEXT, head TEXT, turn_count INTEGER,
    cloud_scope TEXT, pushed_head TEXT, reported_head TEXT, push_due_at INTEGER, push_attempts INTEGER DEFAULT 0,
    push_error TEXT, push_refused_head TEXT, pushed_bytes INTEGER NOT NULL DEFAULT 0, push_stopped_reason TEXT)`)
  const manifest = { ...emptySessionManifest('test-session', 'local'), schemaVersion }
  manifest.turns.push({ operationId: 'one', endedAt: 1, provider: 'codex', threadId: 'thread', partial: false,
    head: null, snapshots: [], bundle: null, hasDiff: false })
  const first = await repos.named(repository).commit({ expectedHead: null, message: 'first', entries: [{ path: 'manifest.json', content: JSON.stringify(manifest) }] })
  db.prepare('INSERT INTO session_storage (session_id, repository, head, turn_count) VALUES (?, ?, ?, 1)').run('test-session', repository, first)
  const reports: string[] = []
  const events: string[] = []
  const store = codeStore(events)
  const access: SessionRemoteAccess = {
    codeUrl: store.codeUrl,
    remote: async () => ({ status: 'ready', remote: { repository, remote: pathToFileURL(remote).href, token: '', expiresAt: new Date().toISOString(),
      storageScope: 'test', head: null, syncedTurn: 0, lastRunHostId: null, runningHostId: null } }),
    report: async request => { reports.push(request.event); return 'accepted' },
  }
  // SAFETY: the push reads only these fields from this fixed test record.
  const record: SessionPushDeps['record'] = async () => ({ ownerKey: 'account:person', organizationId: 'local', publication: 'local',
    provider: 'codex' } as NonNullable<Awaited<ReturnType<NonNullable<SessionPushDeps['record']>>>>)
  const deps: SessionPushDeps = { repositories: repos, access, hostId: () => 'host', database: () => db, record,
    accountOf: () => 'person', decision: () => ({ allowed: true }), fetch: store.fetchImpl }
  // SAFETY: the columns of the table this fixture made.
  const row = () => db.prepare('SELECT * FROM session_storage WHERE session_id = ?').get('test-session') as { pushed_head: string | null; reported_head: string | null;
    push_refused_head: string | null; push_error: string | null; pushed_bytes: number; push_stopped_reason: string | null }
  /** The remote's main, or '' for a remote with no main. */
  const remoteHead = () => {
    try { return execFileSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/main'], { encoding: 'utf8' }).trim() } catch { return '' }
  }
  return { repos, repository, remote, db, first, reports, events, store, deps, row, remoteHead, manifest, folder }
}

/** Four more turns on the fixture's first commit, each with a stored code bundle. Answers the commits. */
async function turnsWithBundles(f: Awaited<ReturnType<typeof fixture>>): Promise<{ commits: string[]; bundles: string[] }> {
  const repository = f.repos.named(f.repository)
  const manifest = structuredClone(f.manifest)
  let head = f.first
  const commits = [f.first]
  const bundles: string[] = []
  for (const turn of [1, 2, 3, 4]) {
    const file = join(f.folder, `bundle-${turn}`)
    writeFileSync(file, `code bundle of turn ${turn}\n`)
    const stored = await repository.storeCodeBundle(file)
    bundles.push(stored.sha256)
    manifest.turns.push({ operationId: `turn-${turn}`, endedAt: turn + 1, provider: 'codex', threadId: 'thread', partial: false,
      head: null, snapshots: [], bundle: { kind: 'stored', ...stored, refs: {} }, hasDiff: false })
    head = await repository.commit({ expectedHead: head, message: `turn ${turn}`, entries: [
      { path: `threads/thread/main/${turn}.0`, content: `turn ${turn}\n` }, { path: 'manifest.json', content: JSON.stringify(manifest) },
    ] })
    commits.push(head)
  }
  f.db.prepare('UPDATE session_storage SET head = ?, turn_count = 5').run(head)
  return { commits, bundles }
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

// WHY: Artifacts refuses a push above 64 MiB, so a backlog goes one commit at a time; the
// cloud copy must never name a code bundle that R2 does not have yet; and the API learns
// of the head once, not of each commit.
test('a backlog of five commits is pushed one at a time, each bundle before its commit, and reported once', async () => {
  const f = await fixture()
  const { commits, bundles } = await turnsWithBundles(f)
  withPush(f.repos, async (real, remote, commit, ...rest) => {
    f.events.push(`push ${commit}`)
    return real(remote, commit, ...rest)
  })
  const pusher = new SessionPusher(f.deps)
  pusher.committed('test-session')
  await pusher.idle()
  expect(f.events).toEqual([`push ${commits[0]}`, ...bundles.flatMap((sha256, turn) => [`upload ${sha256}`, `push ${commits[turn + 1]}`])])
  expect(f.remoteHead()).toBe(commits[4])
  expect(f.reports).toEqual(['pushed'])
  expect(f.row().pushed_head).toBe(commits[4])
  expect(f.row().pushed_bytes).toBe(await f.repos.named(f.repository).newObjectBytes(null, commits[4]!))
  // A push of `main` sends no code bundle: R2 holds it.
  for (const sha256 of bundles) {
    const blob = execFileSync('git', ['--git-dir', f.repos.named(f.repository).path, 'rev-parse', `refs/solus/code/${sha256}:bundle`], { encoding: 'utf8' }).trim()
    expect(() => execFileSync('git', ['--git-dir', f.remote, 'cat-file', '-e', blob], { stdio: 'ignore' })).toThrow()
    expect(f.store.objects.get(sha256)?.toString()).toStartWith('code bundle of turn')
  }
  await pusher.stop()
  f.db.close()
})

/**
 * A stopped push is not a divergence: the person continues the session on this host.
 * `PromptDispatch` refuses a prompt only for a cloud history that differs.
 */
async function expectStoppedButCurrent(f: Awaited<ReturnType<typeof fixture>>, pusher: InstanceType<typeof SessionPusher>, countPushes: () => number): Promise<void> {
  expect(f.row().push_refused_head).toBeNull()
  expect(pusher.refusedHead('test-session')).toBeNull()
  const { PromptDispatch } = await import('@solus/server/execution/sessions/prompt-dispatch')
  // SAFETY: `assertSessionCurrent` reads only `refusedHead`, not the runtime.
  const dispatch = new PromptDispatch({} as ConstructorParameters<typeof PromptDispatch>[0])
  dispatch.refusedHead = (sessionId) => pusher.refusedHead(sessionId)
  expect(() => dispatch.assertSessionCurrent('test-session')).not.toThrow()
  // Each later way in to the push stops before Git.
  const before = countPushes()
  pusher.committed('test-session')
  pusher.resume()
  pusher.established()
  await pusher.idle()
  expect(countPushes()).toBe(before)
}

// WHY: a retry cannot change these refusals of Artifacts. A retry with backoff forever
// only uses the network; the host stops and records why.
for (const text of ['artifacts_git_receive_pack_object_too_large', 'artifacts_git_receive_pack_request_too_large', 'zlib member compressed data exceeds maximum']) {
  test(`the refusal "${text}" stops the push for good and the session continues on this host`, async () => {
    const f = await fixture()
    let pushes = 0
    withPush(f.repos, async () => { pushes++; return { status: 'failed', reason: 'transport', remoteMessage: `remote: error: ${text}` } })
    const pusher = new SessionPusher({ ...f.deps, retryMs: 1 })
    pusher.committed('test-session')
    await pusher.idle()
    expect(pushes).toBe(1)
    expect(f.row().push_stopped_reason).toContain(text)
    expect(f.row().push_error).toContain(text)
    expect(f.row().pushed_head).toBeNull()
    await expectStoppedButCurrent(f, pusher, () => pushes)
    await pusher.stop()
    f.db.close()
  })
}

// WHY: Artifacts can enforce 1 GB for one repository. The host stops before that, with a clear reason.
test('a push past 900 MiB stops with a clear reason and the session continues on this host', async () => {
  const f = await fixture()
  f.db.prepare('UPDATE session_storage SET pushed_bytes = ?').run(900 * 1024 * 1024)
  let pushes = 0
  withPush(f.repos, async (real, ...args) => { pushes++; return real(...args) })
  const pusher = new SessionPusher(f.deps)
  pusher.committed('test-session')
  await pusher.idle()
  expect(pushes).toBe(0)
  expect(f.remoteHead()).toBe('')
  expect(f.row().push_stopped_reason).toBe('This session is too large for the cloud copy.')
  await expectStoppedButCurrent(f, pusher, () => pushes)
  await pusher.stop()
  f.db.close()
}, 20_000)

// WHY: a version 1 repository can hold files that Artifacts refuses. It stays on its host
// and moves only by the host path.
test('resume does not push a repository that began on manifest version 1', async () => {
  const f = await fixture(1)
  const pusher = new SessionPusher(f.deps)
  pusher.resume()
  await pusher.idle()
  expect(f.remoteHead()).toBe('')
  expect(f.row().pushed_head).toBeNull()
  expect(f.reports).toEqual([])
  await pusher.stop()
  f.db.close()
})
