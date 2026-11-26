import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SessionManifest } from '@solus/server/sync/sessions/session-manifest'
import type { ThreadFile, TurnEnd } from '@solus/server/sync/sessions/session-archive-writer'
import type { SessionRepositories, SessionRepository } from '@solus/server/sync/sessions/session-repository'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const root = mkdtempSync(join(tmpdir(), 'solus-session-archive-'))
process.env.SOLUS_DATA_DIR = root

let db: typeof import('@solus/server/db')
let Writer: typeof import('@solus/server/sync/sessions/session-archive-writer').SessionArchiveWriter
let Repositories: typeof import('@solus/server/sync/sessions/session-repository').SessionRepositories
let repositoryName: typeof import('@solus/server/sync/sessions/session-repository').sessionRepositoryName
let manifestSchema: typeof import('@solus/server/sync/sessions/session-manifest').sessionManifestSchema
let checkpoints: typeof import('@solus/server/git/turn-checkpoints')
let bundleRef: typeof import('@solus/server/git/session-code-bundle').bundleRef
let records: typeof import('@solus/server/data/sessions/session-records')
let lineage: typeof import('@solus/server/data/sessions/session-lineage')

const dirs: string[] = []
function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `solus-session-archive-${name}-`))
  dirs.push(dir)
  return dir
}

beforeAll(async () => {
  db = await import('@solus/server/db')
  Writer = (await import('@solus/server/sync/sessions/session-archive-writer')).SessionArchiveWriter
  const repository = await import('@solus/server/sync/sessions/session-repository')
  Repositories = repository.SessionRepositories
  repositoryName = repository.sessionRepositoryName
  manifestSchema = (await import('@solus/server/sync/sessions/session-manifest')).sessionManifestSchema
  checkpoints = await import('@solus/server/git/turn-checkpoints')
  bundleRef = (await import('@solus/server/git/session-code-bundle')).bundleRef
  records = await import('@solus/server/data/sessions/session-records')
  lineage = await import('@solus/server/data/sessions/session-lineage')
  // The writer starts Git in the project; with no caller, it acts as the host (plans/019).
  ;(await import('@solus/server/execution/seats/acting-identity')).actAsHostForTests()
})
afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(root, `solus.db${suffix}`), { force: true })
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const SESSION = 'archive-session'
const THREAD = '5f0c1d1e-thread'
const REPOSITORY = () => repositoryName('local', SESSION)

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

/** A provider that keeps one transcript file for the thread. */
function oneThreadFile(path: string): (provider: string, threadId: string) => Promise<ThreadFile[]> {
  return async () => [{ key: 'main', relativePath: `${THREAD}.jsonl`, path }]
}

function turnEnd(extra: Partial<TurnEnd> = {}): TurnEnd {
  return { sessionId: SESSION, organizationId: 'local', provider: 'claude-code', threadId: THREAD, partial: false, ...extra }
}

async function readManifest(repositories: SessionRepositories): Promise<SessionManifest> {
  const head = await repositories.named(REPOSITORY()).head()
  return manifestSchema.parse(JSON.parse(await repositories.named(REPOSITORY()).readText(head!, 'manifest.json')))
}

/** The provider file as another host builds it: the byte ranges of the manifest, joined in order. */
async function rebuiltThreadFile(repositories: SessionRepositories, manifest: SessionManifest): Promise<Buffer> {
  const file = manifest.threads[0].files[0]
  const out = join(tempDir('rebuilt'), 'thread.jsonl')
  const head = await repositories.named(REPOSITORY()).head()
  await repositories.named(REPOSITORY()).appendFiles(head!, file.parts.map((part) => `threads/${THREAD}/${file.key}/${part}`), out)
  return readFileSync(out)
}

type Commit = SessionRepository['commit']

/** `repositories`, with each commit of each copy sent through `commit`. `real` is the commit of the copy. */
function withCommit(repositories: SessionRepositories, commit: (real: Commit, turn: Parameters<Commit>[0]) => Promise<string>): SessionRepositories {
  const named = repositories.named.bind(repositories)
  repositories.named = (...args) => {
    const repository = named(...args)
    const real = repository.commit.bind(repository)
    repository.commit = (turn) => commit(real, turn)
    return repository
  }
  return repositories
}

function storageRow(): { head: string | null; error: string | null } | null {
  // SAFETY: the two columns this query names.
  return (db.getDb().prepare('SELECT head, error FROM session_storage WHERE session_id = ?').get(SESSION) ?? null) as { head: string | null; error: string | null } | null
}

function pendingCount(): number {
  // SAFETY: one COUNT column.
  return (db.getDb().prepare('SELECT COUNT(*) AS count FROM session_storage_turns').get() as { count: number }).count
}

describe('session archive writer', () => {
  // WHY: a refused push must leave the second host's turns available in a new fork repository without changing the first history.
  test('a fork after a refused push carries the provider history to its own remote', async () => {
    const sourceId = 'refused-source'
    const forkId = 'refused-fork'
    const sourceRepository = repositoryName('local', sourceId)
    const forkRepository = repositoryName('local', forkId)
    const firstHost = new Repositories(tempDir('first-host'))
    const secondHost = new Repositories(tempDir('second-host'))
    const firstRemote = join(tempDir('remote'), 'first.git')
    const forkRemote = join(tempDir('remote'), 'fork.git')
    git(root, ['init', '--bare', '--initial-branch=main', firstRemote])
    git(root, ['init', '--bare', '--initial-branch=main', forkRemote])
    const baseManifest = (await import('@solus/server/sync/sessions/session-manifest')).emptySessionManifest(sourceId, 'local')
    const base = await firstHost.named(sourceRepository).commit({ expectedHead: null, message: 'first host turn', entries: [
      { path: 'threads/source-thread/main/0', content: 'first host turn\n' },
      { path: 'manifest.json', content: JSON.stringify(baseManifest) },
    ] })
    expect((await firstHost.named(sourceRepository).push(pathToFileURL(firstRemote).href, base, null)).status).toBe('accepted')
    const baseBundle = join(tempDir('bundle'), 'base.bundle')
    await firstHost.named(sourceRepository).bundleSince(null, baseBundle)
    await secondHost.named(sourceRepository).fetchBundle(baseBundle)
    const secondTurn = await secondHost.named(sourceRepository).commit({ expectedHead: base, message: 'second host turn', entries: [
      { path: 'threads/source-thread/main/1', content: 'second host turn\n' },
    ] })
    const firstTurn = await firstHost.named(sourceRepository).commit({ expectedHead: base, message: 'first host next turn', entries: [
      { path: 'threads/source-thread/main/1', content: 'first host next turn\n' },
    ] })
    expect((await firstHost.named(sourceRepository).push(pathToFileURL(firstRemote).href, firstTurn, base)).status).toBe('accepted')
    expect(await secondHost.named(sourceRepository).push(pathToFileURL(firstRemote).href, secondTurn, base)).toEqual({ status: 'refused', head: firstTurn })

    // A fake provider fork writes its inherited turns and new turn in one new thread file.
    const forkFile = join(tempDir('provider-fork'), 'fork.jsonl')
    writeFileSync(forkFile, 'first host turn\nsecond host turn\nfork turn\n')
    await records.upsertOwnSessionRecord({ sessionId: forkId, provider: 'claude-code', projectPath: root,
      parentSessionId: sourceId, rootSessionId: sourceId, lastActivityAt: 1 })
    const writer = new Writer({ repositories: secondHost, threadFiles: async () => [{ key: 'main', relativePath: 'fork.jsonl', path: forkFile }] })
    await writer.turnEnded({ sessionId: forkId, organizationId: 'local', provider: 'claude-code', threadId: 'fork-thread', partial: false })
    await writer.idle()
    const forkHead = await secondHost.named(forkRepository).head()
    expect(forkHead).toBeTruthy()
    expect(forkRepository).not.toBe(sourceRepository)
    const forkManifest = await secondHost.named(forkRepository).readManifest(forkHead!)
    expect(forkManifest.session.parentSessionId).toBe(sourceId)
    expect(forkManifest.lineage?.[0]?.startedAs).toBe('fork')
    const restored = join(tempDir('restored-fork'), 'fork.jsonl')
    await secondHost.named(forkRepository).writeThreadFile(forkHead!, 'fork-thread', forkManifest.threads[0]!.files[0]!, restored)
    expect(readFileSync(restored, 'utf8')).toBe('first host turn\nsecond host turn\nfork turn\n')
    expect((await secondHost.named(forkRepository).push(pathToFileURL(forkRemote).href, forkHead!, null)).status).toBe('accepted')
    expect(git(root, ['--git-dir', forkRemote, 'rev-parse', 'refs/heads/main'])).toBe(forkHead)
    expect(git(root, ['--git-dir', firstRemote, 'rev-parse', 'refs/heads/main'])).toBe(firstTurn)
    await writer.stop()
  })

  // WHY: the session repository is for a host that continues a session. A reader gets the
  // rows and the diff of a turn from the transcript mirror, so a second copy in each turn
  // commit has no reader.
  test('a new turn commit stores no rows and no patch, and still holds the thread of the turn', async () => {
    const transcript = join(tempDir('no-rows'), 'thread.jsonl')
    writeFileSync(transcript, 'turn\n')
    const repositories = new Repositories(tempDir('no-rows-repository'))
    const writer = new Writer({ repositories, threadFiles: oneThreadFile(transcript) })
    await writer.turnEnded(turnEnd())
    await writer.idle()
    const repository = repositories.named(REPOSITORY())
    const head = await repository.head()
    const manifest = await readManifest(repositories)
    expect(manifest.turns[0]).toMatchObject({ hasDiff: false })
    expect(manifest.turns[0].hasRows).toBeUndefined()
    expect(manifest.turns[0].rowCount).toBeUndefined()
    expect(manifest.threads[0].files[0].parts).toEqual(['0.0'])
    expect(git(repository.path, ['ls-tree', '-r', '--name-only', head!]).split('\n').sort()).toEqual(['manifest.json', `threads/${THREAD}/main/0.0`])
    await writer.stop()
  })
  // WHY: no repository is written again. A host must still read the manifest of a turn
  // made before row files existed, and of a turn that has a row file and a patch.
  test('a manifest of an older commit still parses, with and without row and diff facts', () => {
    const turn = { operationId: 'old', endedAt: 1, provider: 'codex', threadId: THREAD, partial: false, head: null, snapshots: [], bundle: null }
    const manifest = manifestSchema.parse({ schemaVersion: 1, session: { id: SESSION, organizationId: 'local' }, threads: [], project: null,
      turns: [{ ...turn, hasDiff: false }, { ...turn, operationId: 'with-files', hasDiff: true, hasRows: true, rowCount: 4 }] })
    expect(manifest.turns[0].hasRows).toBeUndefined()
    expect(manifest.turns[1]).toMatchObject({ hasDiff: true, hasRows: true, rowCount: 4 })
  })
  // WHY: a bundle requested at turn end must include the commit even while its transcript is still being captured.
  test('the per-session wait includes an in-progress capture and commit', async () => {
    const transcript = join(tempDir('late-turn'), 'thread.jsonl')
    writeFileSync(transcript, 'turn\n')
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const repositories = new Repositories(tempDir('late-repository'))
    const writer = new Writer({ repositories, threadFiles: async () => { await gate; return oneThreadFile(transcript)('claude-code', THREAD) } })
    const ending = writer.turnEnded(turnEnd())
    const waiting = writer.waitForSession(SESSION, 10_000)
    release?.()
    await ending
    expect(await waiting).toBe(true)
    expect(storageRow()?.head).toBeTruthy()
    expect(pendingCount()).toBe(0)
    await writer.stop()
  })
  // WHY: a host needs the session settings, provider lineage, project root,
  // and own paths before it can run the next turn in the same session.
  test('each new manifest holds the session facts needed by a second host', async () => {
    const workTree = tempDir('project')
    git(workTree, ['init', '--initial-branch=main'])
    git(workTree, ['config', 'user.email', 'test@example.com'])
    git(workTree, ['config', 'user.name', 'Test'])
    writeFileSync(join(workTree, 'base.txt'), 'base\n')
    git(workTree, ['add', '.'])
    git(workTree, ['commit', '-m', 'base'])
    await records.upsertOwnSessionRecord({ sessionId: SESSION, provider: 'claude-code', projectPath: workTree,
      title: 'Portable work', parentSessionId: 'parent', rootSessionId: 'parent',
      startedBy: { kind: 'session', sessionId: 'parent' }, lastActivityAt: 1 })
    lineage.registerSessionLineage({ sessionId: SESSION, provider: 'claude-code', providerSessionId: THREAD, cwd: workTree })
    const transcript = join(tempDir('thread'), 'thread.jsonl')
    writeFileSync(transcript, '{"turn":1}\n')
    const repositories = new Repositories(tempDir('repositories'))
    const writer = new Writer({ repositories, threadFiles: oneThreadFile(transcript) })
    const target = { sessionId: SESSION, workTree }
    await checkpoints.beginTurnCheckpoint(target)
    writeFileSync(join(workTree, 'changed.txt'), 'changed\n')
    await checkpoints.endTurnCheckpoint(target, { partial: false })
    await writer.turnEnded(turnEnd({ workTree, projectPath: workTree, model: 'claude-sonnet-5', reasoningEffort: 'high', permissionMode: 'auto' }))
    await writer.idle()
    const manifest = await readManifest(repositories)
    expect(manifest.session).toMatchObject({ title: 'Portable work', model: 'claude-sonnet-5', reasoningEffort: 'high',
      permissionMode: 'auto', parentSessionId: 'parent', rootSessionId: 'parent',
      startedBy: { kind: 'session', sessionId: 'parent' } })
    expect(manifest.lineage).toEqual([{ threadId: THREAD, provider: 'claude-code', startedAs: 'fork' }])
    expect(manifest.threads[0].startedAs).toBe('fork')
    expect(manifest.sessionPaths?.turnPaths).toContain('changed.txt')
    expect(manifest.sessionPaths?.sessionChangedFiles).toContain('changed.txt')
    expect(manifest.lastProjectRoot).toBe(workTree)
  })
  // WHY: another host continues the provider thread from these bytes. A file that
  // differs by one byte is a thread the provider cannot resume. The turn commit is
  // built in the background, so bytes the next turn already wrote must stay out of it.
  test('the byte ranges of each turn join to the provider file as it was when that turn ended', async () => {
    const transcript = join(tempDir('thread'), 'thread.jsonl')
    const repositories = new Repositories(tempDir('repositories'))
    const writer = new Writer({ repositories, threadFiles: oneThreadFile(transcript) })

    writeFileSync(transcript, '{"turn":1}\n')
    await writer.turnEnded(turnEnd())
    appendFileSync(transcript, Buffer.from([0x7b, 0xff, 0x00, 0x7d, 0x0a]))
    const afterSecondTurn = readFileSync(transcript)
    await writer.turnEnded(turnEnd())
    appendFileSync(transcript, '{"turn":3,"state":"still running"}\n')
    await writer.idle()

    const manifest = await readManifest(repositories)
    expect(manifest.turns.length).toBe(2)
    expect(manifest.threads[0].files[0].length).toBe(afterSecondTurn.length)
    expect((await rebuiltThreadFile(repositories, manifest)).equals(afterSecondTurn)).toBe(true)
    expect(storageRow()?.head).toBe(await repositories.named(REPOSITORY()).head())
    expect(pendingCount()).toBe(0)
  })

  // WHY: a provider only appends. A file that got shorter is a new file with the
  // old name; ranges of the old one in front of it would corrupt the thread.
  test('a provider file that became shorter starts again under a new key', async () => {
    const transcript = join(tempDir('thread'), 'thread.jsonl')
    const repositories = new Repositories(tempDir('repositories'))
    const writer = new Writer({ repositories, threadFiles: oneThreadFile(transcript) })

    writeFileSync(transcript, '{"turn":1,"long":"first version of the file"}\n')
    await writer.turnEnded(turnEnd())
    writeFileSync(transcript, '{"rewritten":true}\n')
    await writer.turnEnded(turnEnd())
    await writer.idle()

    const manifest = await readManifest(repositories)
    expect(manifest.threads[0].files[0].key).not.toBe('main')
    expect((await rebuiltThreadFile(repositories, manifest)).toString()).toBe('{"rewritten":true}\n')
  })

  // WHY: a provider names its files freely, and two names can give one key. If
  // both wrote to one folder of the repository, one file would replace the other.
  test('two provider files with the same key are kept apart', async () => {
    const folder = tempDir('thread')
    writeFileSync(join(folder, 'first'), 'the first file\n')
    writeFileSync(join(folder, 'second'), 'the second file\n')
    const repositories = new Repositories(tempDir('repositories'))
    const writer = new Writer({
      repositories,
      threadFiles: async () => [
        { key: 'same', relativePath: 'tool results/a b.txt', path: join(folder, 'first') },
        { key: 'same', relativePath: 'tool results/a_b.txt', path: join(folder, 'second') },
      ],
    })
    await writer.turnEnded(turnEnd())
    await writer.idle()

    const manifest = await readManifest(repositories)
    const head = await repositories.named(REPOSITORY()).head()
    const contents: string[] = []
    for (const file of manifest.threads[0].files) {
      const out = join(tempDir('rebuilt'), 'file')
      await repositories.named(REPOSITORY()).appendFiles(head!, file.parts.map((part) => `threads/${THREAD}/${file.key}/${part}`), out)
      contents.push(readFileSync(out, 'utf8'))
    }
    expect(contents).toEqual(['the first file\n', 'the second file\n'])
  })

  // WHY: the commit and the row that records it are two writes. A stop between
  // them must not lose the turn and must not write it a second time, or a host
  // that syncs sees a turn that never ran.
  test('a turn whose commit landed before a crash is found after the restart and not written twice', async () => {
    const transcript = join(tempDir('thread'), 'thread.jsonl')
    const repositoriesRoot = tempDir('repositories')
    const crashAfterCommit = withCommit(new Repositories(repositoriesRoot), async (real, turn) => {
      await real(turn)
      throw new Error('The process stopped after the commit.')
    })
    writeFileSync(transcript, '{"turn":1}\n')
    const crashing = new Writer({ repositories: crashAfterCommit, threadFiles: oneThreadFile(transcript) })
    await crashing.turnEnded(turnEnd())
    await crashing.stop()
    expect(pendingCount()).toBe(1)
    expect(storageRow()?.error).toBeString()
    expect(await crashing.waitForSession(SESSION, 100)).toBe(false)

    const repositories = new Repositories(repositoriesRoot)
    const restarted = new Writer({ repositories, threadFiles: oneThreadFile(transcript) })
    restarted.resume()
    await restarted.idle()

    expect((await readManifest(repositories)).turns.length).toBe(1)
    expect(pendingCount()).toBe(0)
    expect(storageRow()).toEqual({ head: await repositories.named(REPOSITORY()).head(), error: null })
  })

  // WHY: the session diff on another host is correct only when that host gets the
  // trees of each turn. The second turn must not carry the first again.
  test('a turn in a checkout carries its code state, and a second clone gets the same trees', async () => {
    const origin = tempDir('origin')
    git(origin, ['init', '--bare', '--initial-branch=main'])
    const hostA = tempDir('host-a')
    git(hostA, ['clone', origin, '.'])
    git(hostA, ['config', 'user.email', 'test@example.com'])
    git(hostA, ['config', 'user.name', 'Test'])
    writeFileSync(join(hostA, 'tracked.txt'), 'first\n')
    git(hostA, ['add', '.'])
    git(hostA, ['commit', '-m', 'base'])
    git(hostA, ['push', 'origin', 'HEAD:main'])

    const transcript = join(tempDir('thread'), 'thread.jsonl')
    const repositories = new Repositories(tempDir('repositories'))
    // WHY: a reader with no host online reads a turn's diff from the mirror. Each committed
    // turn is given to it once, and a mirror that fails must not hold the turn commit back.
    const given: Array<{ turnIndex: number; repoRoot: string; snapshots: number[] }> = []
    const writer = new Writer({ repositories, threadFiles: oneThreadFile(transcript), turnDiff: async (turn) => {
      given.push({ turnIndex: turn.turnIndex, repoRoot: turn.repoRoot, snapshots: turn.snapshots.map((snapshot) => snapshot.filesChanged) })
      if (turn.turnIndex === 0) throw new Error('The mirror is away.')
    } })
    const target = { sessionId: SESSION, workTree: hostA }
    for (const turn of [1, 2]) {
      await checkpoints.beginTurnCheckpoint(target)
      writeFileSync(join(hostA, `turn-${turn}.txt`), `written in turn ${turn}\n`)
      appendFileSync(transcript, `{"turn":${turn}}\n`)
      await checkpoints.endTurnCheckpoint(target, { partial: false, userMessagePreview: `turn ${turn}` })
      await writer.turnEnded(turnEnd({ workTree: hostA }))
    }
    await writer.idle()

    const manifest = await readManifest(repositories)
    expect(given.map((turn) => [turn.turnIndex, turn.snapshots])).toEqual([[0, [1]], [1, [1]]])
    expect(pendingCount()).toBe(0)
    expect(manifest.project).toEqual({ repositoryKey: null, baseSha: git(hostA, ['rev-parse', 'HEAD']), ownsWorktree: false })
    expect(manifest.turns.map((turn) => [turn.snapshots.map((snapshot) => snapshot.index), turn.bundle?.kind, turn.hasDiff]))
      .toEqual([[[0], 'stored', false], [[1], 'stored', false]])

    const hostB = tempDir('host-b')
    git(hostB, ['clone', origin, '.'])
    const head = await repositories.named(REPOSITORY()).head()
    const spec = `refs/solus/sessions/${SESSION}/bundle/*:refs/solus/sessions/${SESSION}/bundle/*`
    for (const turn of [0, 1]) {
      const bundle = join(tempDir('bundle'), `${turn}.bundle`)
      const stored = manifest.turns[turn].bundle
      if (stored?.kind !== 'stored') throw new Error('The turn has no stored bundle.')
      await repositories.named(REPOSITORY()).writeCodeBundle(stored.sha256, bundle)
      git(hostB, ['fetch', bundle, spec])
      expect(git(hostB, ['rev-parse', `${bundleRef(SESSION, `${turn}/to`)}^{tree}`])).toBe(manifest.turns[turn].snapshots[0].toTreeSha)
    }
    // The patch of a turn is the mirror's, not the commit's.
    expect(git(repositories.named(REPOSITORY()).path, ['ls-tree', '-r', '--name-only', head!])).not.toContain('diff/')
    // WHY: Artifacts refuses a large file, so a bundle is not a file of `main`; its code ref keeps it.
    const files = git(repositories.named(REPOSITORY()).path, ['ls-tree', '-r', '--name-only', head!])
    expect(files).not.toContain('code/')
    for (const turn of manifest.turns) {
      if (turn.bundle?.kind !== 'stored') continue
      const blob = git(repositories.named(REPOSITORY()).path, ['rev-parse', `refs/solus/code/${turn.bundle.sha256}:bundle`])
      expect(git(repositories.named(REPOSITORY()).path, ['rev-list', '--objects', 'refs/heads/main'])).not.toContain(blob)
    }
  })

  // WHY: Artifacts refuses a file above 32 MiB. A long thread must go in pieces that
  // another host joins to the same bytes, or the provider cannot resume the thread.
  test('a 70 MiB provider range goes in three pieces of at most 31 MiB that join to the same bytes', async () => {
    const transcript = join(tempDir('large-thread'), 'thread.jsonl')
    const content = Buffer.alloc(70 * 1024 * 1024)
    for (let offset = 0; offset < content.length; offset += 4) content.writeUInt32LE(offset, offset)
    writeFileSync(transcript, content)
    const repositories = new Repositories(tempDir('large-repository'))
    const writer = new Writer({ repositories, threadFiles: oneThreadFile(transcript) })
    await writer.turnEnded(turnEnd())
    await writer.idle()
    const manifest = await readManifest(repositories)
    const file = manifest.threads[0].files[0]
    expect(file.parts).toEqual(['0.0', '0.1', '0.2'])
    const repository = repositories.named(REPOSITORY())
    const head = (await repository.head())!
    for (const part of file.parts) {
      expect(Number(git(repository.path, ['cat-file', '-s', `${head}:threads/${THREAD}/main/${part}`]))).toBeLessThanOrEqual(31 * 1024 * 1024)
    }
    const out = join(tempDir('large-rebuilt'), 'thread.jsonl')
    await repository.writeThreadFile(head, THREAD, file, out)
    expect(readFileSync(out).equals(content)).toBe(true)
    await writer.stop()
  }, 60_000)

  // WHY: Artifacts refuses a push above 64 MiB. A large turn must be several commits,
  // and a reader of each head must read a manifest whose files all exist.
  test('a turn with 100 MiB of new files is three commits, and only the last changes the manifest', async () => {
    const transcript = join(tempDir('turn-thread'), 'thread.jsonl')
    writeFileSync(transcript, '{"turn":1}\n')
    const repositories = new Repositories(tempDir('turn-repository'))
    const writer = new Writer({ repositories, threadFiles: oneThreadFile(transcript) })
    await writer.turnEnded(turnEnd())
    await writer.idle()
    const repository = repositories.named(REPOSITORY())
    const firstHead = (await repository.head())!
    appendFileSync(transcript, Buffer.alloc(100 * 1024 * 1024, 'x'))
    await writer.turnEnded(turnEnd())
    await writer.idle()
    const head = (await repository.head())!
    const commits = await repository.commitsAfter(firstHead, head)
    expect(commits).toHaveLength(3)
    const firstManifest = git(repository.path, ['rev-parse', `${firstHead}:manifest.json`])
    expect(commits.map((commit) => git(repository.path, ['rev-parse', `${commit}:manifest.json`]) === firstManifest)).toEqual([true, true, false])
    for (const commit of [firstHead, ...commits]) {
      const manifest = manifestSchema.parse(JSON.parse(await repository.readText(commit, 'manifest.json')))
      const tree = new Set(git(repository.path, ['ls-tree', '-r', '--name-only', commit]).split('\n'))
      for (const file of manifest.threads.flatMap((thread) => thread.files.map((entry) => ({ thread: thread.threadId, entry })))) {
        for (const part of file.entry.parts) expect(tree.has(`threads/${file.thread}/${file.entry.key}/${part}`)).toBe(true)
      }
      if (commit !== firstHead) expect(await repository.newObjectBytes(`${commit}~1`, commit)).toBeLessThan(48 * 1024 * 1024 + 64 * 1024)
    }
    const manifest = await readManifest(repositories)
    expect(manifest.threads[0].files[0].parts).toEqual(['0.0', '1.0', '1.1', '1.2', '1.3'])
    expect(storageRow()?.head).toBe(head)
    await writer.stop()
  }, 60_000)
})
