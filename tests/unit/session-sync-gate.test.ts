import { afterAll, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { SessionRuntime } from '@solus/server/execution/session-runtime'
import { DatabaseSync } from './helpers/bun-sqlite'

const root = mkdtempSync(join(tmpdir(), 'solus-session-sync-gate-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
const previousProjectsRoot = process.env.SOLUS_PROJECTS_ROOT
process.env.SOLUS_DATA_DIR = root
process.env.SOLUS_PROJECTS_ROOT = join(root, 'projects')
afterAll(() => {
  closeDb()
  rmSync(root, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  if (previousProjectsRoot === undefined) delete process.env.SOLUS_PROJECTS_ROOT
  else process.env.SOLUS_PROJECTS_ROOT = previousProjectsRoot
})

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { SessionSync, SessionSyncError } = await import('@solus/server/execution/sessions/session-sync')
const { HOST_ACTOR } = await import('@solus/server/admission/actor')
const { getDb, closeDb } = await import('@solus/server/db')
const { SessionRepositories, sessionRepositoryName } = await import('@solus/server/sync/sessions/session-repository')
const { emptySessionManifest } = await import('@solus/server/sync/sessions/session-manifest')
const { getSessionRecord } = await import('@solus/server/data/sessions/session-records')
const { beginTurnCheckpoint, endTurnCheckpoint } = await import('@solus/server/git/turn-checkpoints')
const { getSessionBaseSha, listTurnSnapshots, snapshotLiveTree } = await import('@solus/server/git/session-snapshots')
const { writeTurnCodeBundle } = await import('@solus/server/git/session-code-bundle')
const { actAsHostForTests } = await import('@solus/server/execution/seats/acting-identity')
actAsHostForTests()
getDb().prepare('INSERT INTO session_storage (session_id, repository, head) VALUES (?, ?, ?)').run('one', 'session-test', 'a'.repeat(40))
getDb().prepare('INSERT INTO session_storage (session_id, repository, head) VALUES (?, ?, ?)').run('two', 'session-test', 'a'.repeat(40))

// WHY: a current host starts a turn from one storage row. It must not dial
// another host or start Git work when the client names the same head.
test('equal or absent heads do not fetch', () => {
  let fetches = 0
  // SAFETY: the gate stops before it uses any runtime method in this test.
  const runtime = {} as SessionRuntime
  const sync = new SessionSync(runtime, {
    repositories: new SessionRepositories(root),
    providerInstalled: async () => true,
    fetchBundle: async () => { fetches++; return { state: 'no-repository' } },
    prepareCheckout: async () => { throw new Error('Unexpected checkout') },
  })
  expect(sync.prepare({ sessionId: 'one', knownHead: 'a'.repeat(40) }, HOST_ACTOR)).toEqual({ state: 'current', head: 'a'.repeat(40) })
  expect(sync.prepare({ sessionId: 'one', knownHead: null }, HOST_ACTOR)).toEqual({ state: 'current', head: 'a'.repeat(40) })
  expect(fetches).toBe(0)
})

// WHY: a stale client head must not block a turn when the source confirms that
// this host already has the newest commit.
test('a stale client head can find this host current', async () => {
  const runtime = { publish: () => {} } as SessionRuntime
  const sync = new SessionSync(runtime, {
    repositories: new SessionRepositories(root), providerInstalled: async () => true,
    fetchBundle: async () => ({ state: 'current' }),
    prepareCheckout: async () => { throw new Error('Unexpected checkout') },
  })
  expect(sync.prepare({ sessionId: 'one', knownHead: 'b'.repeat(40), sourceHostId: 'source' }, HOST_ACTOR)).toEqual({ state: 'started' })
  expect(await sync.wait('one')).toEqual({ state: 'current', head: 'a'.repeat(40) })
})

// WHY: two prepare calls for one session must share work, and Stop must reach
// the fetch before any local repository or checkout can change.
test('different heads join one sync and Stop aborts it', async () => {
  let fetches = 0
  let started: (() => void) | undefined
  const entered = new Promise<void>((resolve) => { started = resolve })
  const events: string[] = []
  // SAFETY: fetch stops before the remaining runtime methods are reached.
  const runtime = { publish: (_sessionId: string, event: { type: string }) => events.push(event.type) } as SessionRuntime
  const sync = new SessionSync(runtime, {
    repositories: new SessionRepositories(root),
    providerInstalled: async () => true,
    fetchBundle: async ({ signal }) => {
      fetches++
      started?.()
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      return { state: 'no-repository' }
    },
    prepareCheckout: async () => { throw new Error('Unexpected checkout') },
  })
  const request = { sessionId: 'two', knownHead: 'b'.repeat(40), sourceHostId: 'source' }
  expect(sync.prepare(request, HOST_ACTOR)).toEqual({ state: 'started' })
  expect(sync.prepare(request, HOST_ACTOR)).toEqual({ state: 'started' })
  const work = sync.wait('two')
  await entered
  expect(fetches).toBe(1)
  expect(sync.stop('two')).toBe(true)
  expect(await work).toMatchObject({ state: 'failed', reason: 'interrupted' })
  expect(events).toContain('status_card')
  expect(sync.localHead('two')).toBe('a'.repeat(40))
})

// WHY: a second host adopts the same session id and native provider bytes.
// The repository head becomes current only after the import and record write.
test('a projectless session sync imports its thread and record at the same id', async () => {
  const sessionId = 'portable-chat'
  const threadId = 'thread-portable-chat'
  const repository = sessionRepositoryName('local', sessionId)
  const source = new SessionRepositories(join(root, 'source'))
  const manifest = emptySessionManifest(sessionId, 'local')
  manifest.session.title = 'Portable chat'
  manifest.session.model = 'test-model'
  manifest.session.reasoningEffort = 'low'
  manifest.lineage = [{ threadId, provider: 'claude-code', startedAs: 'start' }]
  manifest.threads = [{ threadId, provider: 'claude-code', startedAs: 'start', files: [
    { key: 'main', relativePath: 'thread.jsonl', length: 6, parts: [0] },
  ] }]
  manifest.turns = [{ operationId: 'turn-one', endedAt: Date.now(), provider: 'claude-code', threadId, partial: false, head: null, snapshots: [], bundle: null, hasDiff: false }]
  const head = await source.named(repository).commit({ expectedHead: null, message: 'turn', entries: [
    { path: `threads/${threadId}/main/0`, content: 'hello\n' },
    { path: 'manifest.json', content: JSON.stringify(manifest) },
  ] })
  let imported = ''
  const events: string[] = []
  // SAFETY: these are the exact methods that the projectless sync calls.
  const runtime = {
    publish: (_sessionId: string, event: { type: string }) => events.push(event.type),
    getMetadataFor: () => ({ available: true }),
    seatForTurn: async () => null,
    backendFor: () => ({ importThread: async (request: { files: Array<{ path: string }> }) => {
      imported = readFileSync(request.files[0]!.path, 'utf8')
      return { files: [{ relativePath: 'thread.jsonl', status: 'written', bytes: imported.length }], bytesWritten: imported.length }
    } }),
  } as SessionRuntime
  const sync = new SessionSync(runtime, {
    repositories: new SessionRepositories(join(root), 'destination'),
    providerInstalled: async () => true,
    fetchBundle: async ({ outFile }) => {
      await source.named(repository).bundleSince(null, outFile)
      return { state: 'ready', repositoryPath: outFile, head }
    },
    prepareCheckout: async () => { throw new Error('Projectless sync must not prepare a checkout') },
  })
  expect(sync.prepare({ sessionId, knownHead: head, sourceHostId: 'source' }, HOST_ACTOR)).toEqual({ state: 'started' })
  expect(await sync.wait(sessionId)).toEqual({ state: 'current', head })
  expect(imported).toBe('hello\n')
  expect(getDb().prepare('SELECT head, turn_count FROM session_storage WHERE session_id = ?').get(sessionId)).toEqual({ head, turn_count: 1 })
  expect((await getSessionRecord('local', sessionId))?.sessionId).toBe(sessionId)
  expect(events).toContain('status_card')
})

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

// WHY: a second host must run the next turn from the same tree and provider
// thread, with the same Solus session id and a local head that names that tree.
test('a project sync restores the exact tree and binds the same session id', async () => {
  const sessionId = 'portable-project'
  const threadId = 'thread-portable-project'
  const origin = join(root, 'origin.git')
  mkdirSync(origin)
  git(origin, ['init', '--bare', '--initial-branch=main'])
  const hostA = join(root, 'host-a')
  mkdirSync(hostA)
  git(hostA, ['clone', origin, '.'])
  git(hostA, ['config', 'user.name', 'Test'])
  git(hostA, ['config', 'user.email', 'test@example.com'])
  writeFileSync(join(hostA, 'base.txt'), 'base\n')
  git(hostA, ['add', '.'])
  git(hostA, ['commit', '-m', 'base'])
  git(hostA, ['push', 'origin', 'HEAD:main'])
  const projects = join(root, 'projects')
  mkdirSync(projects)
  const hostB = join(projects, 'repo')
  mkdirSync(hostB)
  git(hostB, ['clone', origin, '.'])
  git(hostB, ['remote', 'set-url', 'origin', 'https://github.com/acme/repo.git'])
  const workA = join(root, 'work-a')
  git(hostA, ['worktree', 'add', '-b', 'session-branch', workA, 'HEAD'])
  await beginTurnCheckpoint({ sessionId, workTree: workA })
  writeFileSync(join(workA, 'turn.txt'), 'portable change\n')
  await endTurnCheckpoint({ sessionId, workTree: workA }, { userMessagePreview: 'change' })
  const snapshots = await listTurnSnapshots(hostA, sessionId)
  const codeBundle = join(root, 'code.bundle')
  const bundle = await writeTurnCodeBundle(hostA, {
    sessionId, snapshots, previousCommit: getSessionBaseSha(hostA, sessionId)!, headSha: git(workA, ['rev-parse', 'HEAD']), carried: [],
  }, codeBundle)
  expect(bundle.kind).toBe('written')
  const repository = sessionRepositoryName('local', sessionId)
  const source = new SessionRepositories(join(root, 'source-project'))
  const manifest = emptySessionManifest(sessionId, 'local')
  manifest.session.title = 'Portable project'
  manifest.project = { repositoryKey: 'github.com/acme/repo', baseSha: getSessionBaseSha(hostA, sessionId)!, ownsWorktree: true }
  manifest.lastProjectRoot = hostA
  manifest.sessionPaths = { turnPaths: ['turn.txt'], sessionChangedFiles: ['turn.txt'] }
  manifest.lineage = [{ threadId, provider: 'claude-code', startedAs: 'start' }]
  manifest.threads = [{ threadId, provider: 'claude-code', startedAs: 'start', files: [
    { key: 'main', relativePath: 'thread.jsonl', length: 6, parts: [0] },
  ] }]
  manifest.turns = [{ operationId: 'turn-one', endedAt: Date.now(), provider: 'claude-code', threadId, partial: false,
    head: { sha: git(workA, ['rev-parse', 'HEAD']), branch: 'session-branch' }, snapshots, bundle, hasDiff: false }]
  const head = await source.named(repository).commit({ expectedHead: null, message: 'turn', entries: [
    { path: `threads/${threadId}/main/0`, content: 'hello\n' },
    { path: 'code/0.bundle', file: codeBundle },
    { path: 'manifest.json', content: JSON.stringify(manifest) },
  ] })
  let imported = ''
  let checkoutPath = ''
  // SAFETY: these are the exact runtime methods used by this one sync.
  const runtime = {
    publish: () => {}, getMetadataFor: () => ({ available: true }), seatForTurn: async () => null,
    backendFor: () => ({ importThread: async (request: { files: Array<{ path: string }>; cwd: string }) => {
      imported = readFileSync(request.files[0]!.path, 'utf8')
      expect(existsSync(request.cwd)).toBe(true)
      return { files: [{ relativePath: 'thread.jsonl', status: 'written', bytes: imported.length }], bytesWritten: imported.length }
    } }),
    sessionCheckouts: { getGitContext: () => undefined, setSessionGitEnvironment: (_id: string, path: string) => { checkoutPath = path } },
  } as SessionRuntime
  const sync = new SessionSync(runtime, {
    repositories: new SessionRepositories(join(root), 'destination-project'),
    providerInstalled: async () => true,
    fetchBundle: async ({ outFile }) => {
      await source.named(repository).bundleSince(null, outFile)
      return { state: 'ready', repositoryPath: outFile, head }
    },
    prepareCheckout: async () => { throw new Error('The existing checkout must be used') },
  })
  expect(sync.prepare({ sessionId, knownHead: head, sourceHostId: 'source', repository: {
    cloneUrl: 'https://github.com/acme/repo.git',
    files: [{ path: '.worktreeinclude', contentBase64: Buffer.from('local.env\n').toString('base64') },
      { path: 'local.env', contentBase64: Buffer.from('LOCAL=1\n').toString('base64') }],
  } }, HOST_ACTOR)).toEqual({ state: 'started' })
  expect(await sync.wait(sessionId)).toEqual({ state: 'current', head })
  expect(readFileSync(join(checkoutPath, 'local.env'), 'utf8')).toBe('LOCAL=1\n')
  rmSync(join(checkoutPath, 'local.env'))
  rmSync(join(checkoutPath, '.worktreeinclude'))
  expect(await snapshotLiveTree(checkoutPath, hostB)).toBe(snapshots.at(-1)!.toTreeSha)
  expect(imported).toBe('hello\n')
  expect((await getSessionRecord('local', sessionId))?.sessionId).toBe(sessionId)
  expect(sync.localHead(sessionId)).toBe(head)
  expect(sync.takeNote(sessionId)).toEqual({ from: hostA, to: hostB })
  expect(sync.takeNote(sessionId)).toBeUndefined()
})

// WHY: a failed preflight, source read, or provider import must never move the
// local head. Each failure has a stable reason for the client's setup card.
test('preflight, offline source, divergence, and thread conflict keep the repository unchanged', async () => {
  const sessionId = 'portable-failures'
  const threadId = 'thread-portable-failures'
  const repository = sessionRepositoryName('local', sessionId)
  const source = new SessionRepositories(join(root, 'failure-source'))
  const manifest = emptySessionManifest(sessionId, 'local')
  manifest.lineage = [{ threadId, provider: 'claude-code', startedAs: 'start' }]
  manifest.threads = [{ threadId, provider: 'claude-code', files: [{ key: 'main', relativePath: 'thread.jsonl', length: 6, parts: [0] }] }]
  manifest.turns = [{ operationId: 'one', endedAt: Date.now(), provider: 'claude-code', threadId, partial: false, head: null, snapshots: [], bundle: null, hasDiff: false }]
  const head = await source.named(repository).commit({ expectedHead: null, message: 'turn', entries: [
    { path: `threads/${threadId}/main/0`, content: 'hello\n' }, { path: 'manifest.json', content: JSON.stringify(manifest) },
  ] })
  const destination = join(root, 'failure-destination')
  const request = { sessionId, knownHead: head, sourceHostId: 'source' }
  const sourceBundle = async ({ outFile }: { outFile: string }) => {
    // WHY: the transfer writes only into the sync's disposable directory, never the process directory.
    expect(isAbsolute(outFile)).toBe(true)
    await source.named(repository).bundleSince(null, outFile)
    return { state: 'ready' as const, repositoryPath: outFile, head }
  }
  const runtimeFor = (importStatus: 'written' | 'conflict') => ({
    publish: () => {}, getMetadataFor: () => ({ available: true }), seatForTurn: async () => null,
    backendFor: () => ({ importThread: async () => ({ files: [{ relativePath: 'thread.jsonl', status: importStatus, bytes: 0 }], bytesWritten: 0 }) }),
  }) as SessionRuntime
  const cases = [
    { reason: 'provider-unavailable', installed: false, fetchBundle: sourceBundle, importStatus: 'written' as const },
    { reason: 'source-offline', installed: true, fetchBundle: async () => { throw new SessionSyncError('source-offline', 'Host A is offline.') }, importStatus: 'written' as const },
    { reason: 'diverged', installed: true, fetchBundle: async () => ({ state: 'diverged' as const }), importStatus: 'written' as const },
    { reason: 'thread-conflict', installed: true, fetchBundle: sourceBundle, importStatus: 'conflict' as const },
  ]
  for (const entry of cases) {
    const sync = new SessionSync(runtimeFor(entry.importStatus), {
      repositories: new SessionRepositories(destination), providerInstalled: async () => entry.installed,
      fetchBundle: entry.fetchBundle,
      prepareCheckout: async () => { throw new Error('No project checkout expected') },
    })
    expect(sync.prepare(request, HOST_ACTOR)).toEqual({ state: 'started' })
    expect(await sync.wait(sessionId)).toMatchObject({ state: 'failed', reason: entry.reason })
    expect(sync.localHead(sessionId)).toBeNull()
    expect(existsSync(new SessionRepositories(destination).named(repository).path)).toBe(false)
  }
})

// WHY: missing code objects must stop before a new worktree is made, and the
// session repository must still have no local head.
test('code restore reports its typed failure without a worktree', async () => {
  const sessionId = 'portable-code-failure'
  const threadId = 'thread-code-failure'
  const repository = sessionRepositoryName('local', sessionId)
  const source = new SessionRepositories(join(root, 'code-failure-source'))
  const manifest = emptySessionManifest(sessionId, 'local')
  manifest.lineage = [{ threadId, provider: 'claude-code', startedAs: 'start' }]
  manifest.threads = [{ threadId, provider: 'claude-code', files: [] }]
  manifest.project = { repositoryKey: 'github.com/acme/missing-code', baseSha: 'a'.repeat(40), ownsWorktree: true }
  manifest.turns = [{ operationId: 'one', endedAt: Date.now(), provider: 'claude-code', threadId, partial: false,
    head: { sha: 'b'.repeat(40), branch: 'session' }, snapshots: [], bundle: { kind: 'empty' }, hasDiff: false }]
  const head = await source.named(repository).commit({ expectedHead: null, message: 'turn', entries: [{ path: 'manifest.json', content: JSON.stringify(manifest) }] })
  const checkout = join(root, 'missing-code-checkout')
  mkdirSync(checkout)
  git(checkout, ['init'])
  // SAFETY: code restore fails before any backend import or checkout binding.
  const runtime = { publish: () => {}, getMetadataFor: () => ({ available: true }), seatForTurn: async () => null,
    backendFor: () => ({ importThread: async () => ({ files: [], bytesWritten: 0 }) }),
    sessionCheckouts: { getGitContext: () => undefined } } as SessionRuntime
  const sync = new SessionSync(runtime, {
    repositories: new SessionRepositories(join(root), 'code-failure-destination'), providerInstalled: async () => true,
    fetchBundle: async ({ outFile }) => { await source.named(repository).bundleSince(null, outFile); return { state: 'ready', repositoryPath: outFile, head } },
    prepareCheckout: async () => checkout,
  })
  expect(sync.prepare({ sessionId, knownHead: head, sourceHostId: 'source', repository: { cloneUrl: 'https://github.com/acme/missing-code.git' } }, HOST_ACTOR)).toEqual({ state: 'started' })
  expect(await sync.wait(sessionId)).toMatchObject({ state: 'failed', reason: 'code-restore' })
  expect(sync.localHead(sessionId)).toBeNull()
  expect(git(checkout, ['worktree', 'list', '--porcelain']).split('worktree ').length).toBe(2)
})

// WHY: Stop is available on every setup step. It must leave the source
// repository untouched and never mark the destination current.
test('Stop interrupts every sync step before the local head advances', async () => {
  const sessionId = 'portable-stop-steps'
  const threadId = 'thread-stop-steps'
  const repository = sessionRepositoryName('local', sessionId)
  const source = new SessionRepositories(join(root, 'stop-source'))
  const manifest = emptySessionManifest(sessionId, 'local')
  manifest.lineage = [{ threadId, provider: 'claude-code', startedAs: 'start' }]
  manifest.threads = [{ threadId, provider: 'claude-code', files: [] }]
  manifest.turns = [{ operationId: 'one', endedAt: Date.now(), provider: 'claude-code', threadId, partial: false, head: null, snapshots: [], bundle: null, hasDiff: false }]
  const head = await source.named(repository).commit({ expectedHead: null, message: 'turn', entries: [{ path: 'manifest.json', content: JSON.stringify(manifest) }] })
  for (const stopAt of ['preflight', 'fetch', 'checkout', 'thread', 'records']) {
    let sync!: InstanceType<typeof SessionSync>
    // SAFETY: the fake backend writes no provider files; the test stops before records.
    const runtime = {
      publish: (_id: string, event: { type: string; card: { steps: Array<{ id: string; status: string }> } }) => {
        if (event.type === 'status_card' && event.card.steps.some((step) => step.id === stopAt && step.status === 'active')) sync.stop(sessionId)
      },
      getMetadataFor: () => ({ available: true }), seatForTurn: async () => null,
      backendFor: () => ({ importThread: async () => ({ files: [], bytesWritten: 0 }) }),
    } as SessionRuntime
    sync = new SessionSync(runtime, {
      repositories: new SessionRepositories(join(root), 'stop-destination'), providerInstalled: async () => true,
      fetchBundle: async ({ outFile }) => { await source.named(repository).bundleSince(null, outFile); return { state: 'ready', repositoryPath: outFile, head } },
      prepareCheckout: async () => { throw new Error('No checkout expected') },
    })
    expect(sync.prepare({ sessionId, knownHead: head, sourceHostId: 'source' }, HOST_ACTOR)).toEqual({ state: 'started' })
    expect(await sync.wait(sessionId)).toMatchObject({ state: 'failed', reason: 'interrupted' })
    expect(sync.localHead(sessionId)).toBeNull()
  }
  expect((await getSessionRecord('local', sessionId))?.sessionId).toBeUndefined()
})

// WHY: a second host must adopt the same native thread and session head from a cloud Git remote.
test('a full projectless sync can fetch a file remote', async () => {
  const { fetchSessionArtifacts } = await import('@solus/server/execution/sessions/session-artifacts-source')
  const { pathToFileURL } = await import('node:url')
  const sessionId = 'portable-cloud-chat'
  const threadId = 'thread-portable-cloud-chat'
  const repository = sessionRepositoryName('local', sessionId)
  const source = new SessionRepositories(join(root, 'source-cloud-chat'))
  const manifest = emptySessionManifest(sessionId, 'local')
  manifest.lineage = [{ threadId, provider: 'claude-code', startedAs: 'start' }]
  manifest.threads = [{ threadId, provider: 'claude-code', files: [{ key: 'main', relativePath: 'thread.jsonl', length: 6, parts: [0] }] }]
  manifest.turns = [{ operationId: 'one', endedAt: Date.now(), provider: 'claude-code', threadId, partial: false, head: null, snapshots: [], bundle: null, hasDiff: false }]
  const head = await source.named(repository).commit({ expectedHead: null, message: 'turn', entries: [
    { path: `threads/${threadId}/main/0`, content: 'hello\n' }, { path: 'manifest.json', content: JSON.stringify(manifest) },
  ] })
  let imported = ''
  const runtime = {
    publish: () => {}, getMetadataFor: () => ({ available: true }), seatForTurn: async () => null,
    backendFor: () => ({ importThread: async (request: { files: Array<{ path: string }> }) => {
      imported = readFileSync(request.files[0]!.path, 'utf8')
      return { files: [{ relativePath: 'thread.jsonl', status: 'written', bytes: imported.length }], bytesWritten: imported.length }
    } }),
  } as SessionRuntime
  const sync = new SessionSync(runtime, {
    repositories: new SessionRepositories(join(root), 'destination-cloud-chat'), providerInstalled: async () => true,
    fetchBundle: request => fetchSessionArtifacts(async () => ({
      repository, remote: pathToFileURL(source.named(repository).path).href, token: '',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), storageScope: 'test',
      head, syncedTurn: 1, lastRunHostId: 'host-a', runningHostId: null,
    }), null, request),
    prepareCheckout: async () => { throw new Error('Projectless sync must not prepare a checkout') },
  })
  expect(sync.prepare({ sessionId, knownHead: head }, HOST_ACTOR)).toEqual({ state: 'started' })
  expect(await sync.wait(sessionId)).toEqual({ state: 'current', head })
  expect(imported).toBe('hello\n')
  expect(sync.localHead(sessionId)).toBe(head)
})

// WHY: after a refused push, choosing the cloud copy must clear the refusal and keep the local turns reachable.
test('preparing the newer cloud copy retains refused turns and admits another prompt', async () => {
  const { fetchSessionArtifacts } = await import('@solus/server/execution/sessions/session-artifacts-source')
  const { pathToFileURL } = await import('node:url')
  const { PromptDispatch } = await import('@solus/server/execution/sessions/prompt-dispatch')
  const sessionId = 'portable-refused-cloud'
  const threadId = 'thread-portable-refused-cloud'
  const repository = sessionRepositoryName('local', sessionId)
  const localRoot = join(root, 'refused-cloud-local')
  const remote = new SessionRepositories(join(root, 'refused-cloud-source'))
  const local = new SessionRepositories(localRoot)
  const manifest = emptySessionManifest(sessionId, 'local')
  manifest.lineage = [{ threadId, provider: 'claude-code', startedAs: 'start' }]
  manifest.threads = [{ threadId, provider: 'claude-code', files: [{ key: 'main', relativePath: 'thread.jsonl', length: 5, parts: [0] }] }]
  manifest.turns = [{ operationId: 'base', endedAt: 1, provider: 'claude-code', threadId, partial: false, head: null, snapshots: [], bundle: null, hasDiff: false }]
  const base = await remote.named(repository).commit({ expectedHead: null, message: 'base', entries: [
    { path: `threads/${threadId}/main/0`, content: 'base\n' }, { path: 'manifest.json', content: JSON.stringify(manifest) },
  ] })
  const firstBundle = join(root, 'refused-base.bundle')
  await remote.named(repository).bundleSince(null, firstBundle)
  await local.named(repository).fetchBundle(firstBundle)
  const localHead = await local.named(repository).commit({ expectedHead: base, message: 'local turn', entries: [{ path: 'local-turn', content: 'ours' }] })
  manifest.turns.push({ operationId: 'remote', endedAt: 2, provider: 'claude-code', threadId, partial: false, head: null, snapshots: [], bundle: null, hasDiff: false })
  const cloudHead = await remote.named(repository).commit({ expectedHead: base, message: 'cloud turn', entries: [{ path: 'manifest.json', content: JSON.stringify(manifest) }] })
  getDb().prepare('INSERT INTO session_storage (session_id, repository, head, turn_count, push_refused_head) VALUES (?, ?, ?, 2, ?)')
    .run(sessionId, repository, localHead, cloudHead)
  const dispatch = new PromptDispatch({} as SessionRuntime)
  dispatch.refusedHead = id => id === sessionId && (getDb().prepare('SELECT push_refused_head FROM session_storage WHERE session_id = ?').get(id) as { push_refused_head: string | null })?.push_refused_head || null
  expect(() => dispatch.assertSessionCurrent(sessionId)).toThrow()
  const runtime = {
    publish: () => {}, getMetadataFor: () => ({ available: true }), seatForTurn: async () => null,
    backendFor: () => ({ importThread: async () => ({ files: [{ relativePath: 'thread.jsonl', status: 'written', bytes: 5 }], bytesWritten: 5 }) }),
  } as SessionRuntime
  const sync = new SessionSync(runtime, {
    repositories: local, providerInstalled: async () => true,
    fetchBundle: request => fetchSessionArtifacts(async () => ({
      repository, remote: pathToFileURL(remote.named(repository).path).href, token: '',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), storageScope: 'test',
      head: cloudHead, syncedTurn: 2, lastRunHostId: 'host-a', runningHostId: null,
    }), local.named(repository).path, { ...request, have: null }),
    prepareCheckout: async () => { throw new Error('No project checkout expected') },
  })
  expect(sync.prepare({ sessionId, knownHead: cloudHead }, HOST_ACTOR)).toEqual({ state: 'started' })
  expect(await sync.wait(sessionId)).toEqual({ state: 'current', head: cloudHead })
  expect(sync.localHead(sessionId)).toBe(cloudHead)
  expect((getDb().prepare('SELECT push_refused_head FROM session_storage WHERE session_id = ?').get(sessionId) as { push_refused_head: string | null }).push_refused_head).toBeNull()
  await expect(dispatch.admitTurn({ session: { sessionId } }, HOST_ACTOR)).resolves.toBeUndefined()
  const { registerHistoryHandlers } = await import('@solus/server/transport/handlers/history-handlers')
  type SessionMeta = import('@solus/contracts/types').SessionMeta
  type HandlerCtx = import('@solus/server/transport/server').HandlerCtx
  let sessionInfo: ((args: [string], context: HandlerCtx) => Promise<SessionMeta | null>) | undefined
  // SAFETY: registration only stores the requested handler; the test calls it with the host actor.
  registerHistoryHandlers({ register: (name: string, handler: typeof sessionInfo) => {
    if (name === 'getSessionInfo') sessionInfo = handler
  } } as import('@solus/server/transport/server').SolusServer, {
    sessionRuntime: { history: { getSessionInfo: async () => null } } as SessionRuntime,
    events: {} as import('@solus/server/transport/events/host-event-publisher').HostEventPublisher,
    agentIdFromContext: () => 'claude-code', exchangeProgress: () => undefined,
  })
  expect((await sessionInfo!([sessionId], { principal: HOST_ACTOR.principal } as HandlerCtx))?.pushRefused).toBe(false)
  expect(await local.named(repository).readText(localHead, 'local-turn')).toBe('ours')
  expect(git(localRoot, ['--git-dir', local.named(repository).path, 'rev-parse', `refs/solus/refused/${localHead}`])).toBe(localHead)
})
