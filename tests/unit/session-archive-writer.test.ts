import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SessionManifest } from '@solus/server/sync/sessions/session-manifest'
import type { ThreadFile, TurnEnd } from '@solus/server/sync/sessions/session-archive-writer'
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

async function readManifest(repositories: InstanceType<typeof Repositories>): Promise<SessionManifest> {
  const head = await repositories.head(REPOSITORY())
  return manifestSchema.parse(JSON.parse(await repositories.readText(REPOSITORY(), head!, 'manifest.json')))
}

/** The provider file as another host builds it: the byte ranges of the manifest, joined in order. */
async function rebuiltThreadFile(repositories: InstanceType<typeof Repositories>, manifest: SessionManifest): Promise<Buffer> {
  const file = manifest.threads[0].files[0]
  const out = join(tempDir('rebuilt'), 'thread.jsonl')
  const head = await repositories.head(REPOSITORY())
  await repositories.appendFiles(REPOSITORY(), head!, file.parts.map((part) => `threads/${THREAD}/${file.key}/${part}`), out)
  return readFileSync(out)
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
    const base = await firstHost.commit(sourceRepository, { expectedHead: null, message: 'first host turn', entries: [
      { path: 'threads/source-thread/main/0', content: 'first host turn\n' },
      { path: 'manifest.json', content: JSON.stringify(baseManifest) },
    ] })
    expect((await firstHost.push(sourceRepository, pathToFileURL(firstRemote).href, base, null)).status).toBe('accepted')
    const baseBundle = join(tempDir('bundle'), 'base.bundle')
    await firstHost.bundleSince(sourceRepository, null, baseBundle)
    await secondHost.fetchBundle(sourceRepository, baseBundle)
    const secondTurn = await secondHost.commit(sourceRepository, { expectedHead: base, message: 'second host turn', entries: [
      { path: 'threads/source-thread/main/1', content: 'second host turn\n' },
    ] })
    const firstTurn = await firstHost.commit(sourceRepository, { expectedHead: base, message: 'first host next turn', entries: [
      { path: 'threads/source-thread/main/1', content: 'first host next turn\n' },
    ] })
    expect((await firstHost.push(sourceRepository, pathToFileURL(firstRemote).href, firstTurn, base)).status).toBe('accepted')
    expect(await secondHost.push(sourceRepository, pathToFileURL(firstRemote).href, secondTurn, base)).toEqual({ status: 'refused', head: firstTurn })

    // A fake provider fork writes its inherited turns and new turn in one new thread file.
    const forkFile = join(tempDir('provider-fork'), 'fork.jsonl')
    writeFileSync(forkFile, 'first host turn\nsecond host turn\nfork turn\n')
    await records.upsertOwnSessionRecord({ sessionId: forkId, provider: 'claude-code', projectPath: root,
      parentSessionId: sourceId, rootSessionId: sourceId, lastActivityAt: 1 })
    const writer = new Writer({ repositories: secondHost, threadFiles: async () => [{ key: 'main', relativePath: 'fork.jsonl', path: forkFile }] })
    await writer.turnEnded({ sessionId: forkId, organizationId: 'local', provider: 'claude-code', threadId: 'fork-thread', partial: false })
    await writer.idle()
    const forkHead = await secondHost.head(forkRepository)
    expect(forkHead).toBeTruthy()
    expect(forkRepository).not.toBe(sourceRepository)
    const forkManifest = await secondHost.readManifest(forkRepository, forkHead!)
    expect(forkManifest.session.parentSessionId).toBe(sourceId)
    expect(forkManifest.lineage?.[0]?.startedAs).toBe('fork')
    const restored = join(tempDir('restored-fork'), 'fork.jsonl')
    await secondHost.writeThreadFile(forkRepository, forkHead!, 'fork-thread', forkManifest.threads[0]!.files[0]!, restored)
    expect(readFileSync(restored, 'utf8')).toBe('first host turn\nsecond host turn\nfork turn\n')
    expect((await secondHost.push(forkRepository, pathToFileURL(forkRemote).href, forkHead!, null)).status).toBe('accepted')
    expect(git(root, ['--git-dir', forkRemote, 'rev-parse', 'refs/heads/main'])).toBe(forkHead)
    expect(git(root, ['--git-dir', firstRemote, 'rev-parse', 'refs/heads/main'])).toBe(firstTurn)
    await writer.stop()
  })

  // WHY: a late Git commit must stop at the history that belonged to its ended turn.
  test('a pending turn keeps its projected rows after the next turn starts', async () => {
    const transcript = join(tempDir('rows-thread'), 'thread.jsonl')
    writeFileSync(transcript, 'first\n')
    const repositories = new Repositories(tempDir('rows-repository'))
    let latest = [{ role: 'user', content: 'first', timestamp: 1 }]
    const writer = new Writer({ repositories, threadFiles: oneThreadFile(transcript), turnRows: async () => latest })
    await writer.turnEnded(turnEnd())
    latest = [{ role: 'user', content: 'second', timestamp: 2 }]
    appendFileSync(transcript, 'second\n')
    await writer.turnEnded(turnEnd())
    await writer.idle()
    const manifest = await readManifest(repositories)
    const head = await repositories.head(REPOSITORY())
    expect(manifest.turns.map(turn => [turn.hasRows, turn.rowCount])).toEqual([[true, 1], [true, 2]])
    expect(await repositories.readText(REPOSITORY(), head!, 'rows/0.jsonl')).toContain('"first"')
    expect(await repositories.readText(REPOSITORY(), head!, 'rows/0.jsonl')).not.toContain('"second"')
    await writer.stop()
  })
  // WHY: a failed history read must not lose the provider thread of an ended turn.
  test('unreadable rows leave a turn commit with an absent row marker', async () => {
    const transcript = join(tempDir('no-rows'), 'thread.jsonl')
    writeFileSync(transcript, 'turn\n')
    const repositories = new Repositories(tempDir('no-rows-repository'))
    const writer = new Writer({ repositories, threadFiles: oneThreadFile(transcript), turnRows: async () => { throw new Error('unreadable') } })
    await writer.turnEnded(turnEnd())
    await writer.idle()
    expect((await readManifest(repositories)).turns[0]).toMatchObject({ hasRows: false, rowCount: 0 })
    expect(storageRow()?.head).toBeTruthy()
    await writer.stop()
  })
  // WHY: a cloud history reader must not receive a tool result body from a turn commit.
  test('projected Codex rows omit a large tool result body', async () => {
    const transcript = join(tempDir('codex-rows'), 'rollout.jsonl')
    writeFileSync(transcript, 'turn\n')
    const repositories = new Repositories(tempDir('codex-rows-repository'))
    const body = 'private result '.repeat(100_000)
    const { projectSessionHistory } = await import('@solus/server/data/sessions/result-projection')
    const writer = new Writer({ repositories, threadFiles: oneThreadFile(transcript),
      turnRows: async () => projectSessionHistory([
        { role: 'user', content: 'run command', timestamp: 1 },
        { role: 'tool_result', content: body, timestamp: 2, toolResultForId: 'tool-1' },
      ]),
    })
    await writer.turnEnded(turnEnd({ provider: 'codex' }))
    await writer.idle()
    const head = await repositories.head(REPOSITORY())
    const rows = await repositories.readText(REPOSITORY(), head!, 'rows/0.jsonl')
    expect(rows).not.toContain('private result')
    expect(rows).toContain('"contentBytes":1500000')
    await writer.stop()
  })
  // WHY: a host must still read the manifest of a turn made before row files existed.
  test('an older manifest without row facts still parses', () => {
    const manifest = manifestSchema.parse({ schemaVersion: 1, session: { id: SESSION, organizationId: 'local' }, threads: [], project: null,
      turns: [{ operationId: 'old', endedAt: 1, provider: 'codex', threadId: THREAD, partial: false,
        head: null, snapshots: [], bundle: null, hasDiff: false }] })
    expect(manifest.turns[0].hasRows).toBeUndefined()
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
    expect(storageRow()?.head).toBe(await repositories.head(REPOSITORY()))
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
    const head = await repositories.head(REPOSITORY())
    const contents: string[] = []
    for (const file of manifest.threads[0].files) {
      const out = join(tempDir('rebuilt'), 'file')
      await repositories.appendFiles(REPOSITORY(), head!, file.parts.map((part) => `threads/${THREAD}/${file.key}/${part}`), out)
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
    class CrashAfterCommit extends Repositories {
      override async commit(...args: Parameters<InstanceType<typeof Repositories>['commit']>): Promise<string> {
        await super.commit(...args)
        throw new Error('The process stopped after the commit.')
      }
    }
    writeFileSync(transcript, '{"turn":1}\n')
    const crashing = new Writer({ repositories: new CrashAfterCommit(repositoriesRoot), threadFiles: oneThreadFile(transcript) })
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
    expect(storageRow()).toEqual({ head: await repositories.head(REPOSITORY()), error: null })
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
    const writer = new Writer({ repositories, threadFiles: oneThreadFile(transcript) })
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
    expect(manifest.project).toEqual({ repositoryKey: null, baseSha: git(hostA, ['rev-parse', 'HEAD']), ownsWorktree: false })
    expect(manifest.turns.map((turn) => [turn.snapshots.map((snapshot) => snapshot.index), turn.bundle?.kind, turn.hasDiff]))
      .toEqual([[[0], 'written', true], [[1], 'written', true]])

    const hostB = tempDir('host-b')
    git(hostB, ['clone', origin, '.'])
    const head = await repositories.head(REPOSITORY())
    const spec = `refs/solus/sessions/${SESSION}/bundle/*:refs/solus/sessions/${SESSION}/bundle/*`
    for (const turn of [0, 1]) {
      const bundle = join(tempDir('bundle'), `${turn}.bundle`)
      await repositories.appendFiles(REPOSITORY(), head!, [`code/${turn}.bundle`], bundle)
      git(hostB, ['fetch', bundle, spec])
      expect(git(hostB, ['rev-parse', `${bundleRef(SESSION, `${turn}/to`)}^{tree}`])).toBe(manifest.turns[turn].snapshots[0].toTreeSha)
    }
    const patch = join(tempDir('patch'), '1.patch')
    await repositories.appendFiles(REPOSITORY(), head!, ['diff/1.patch'], patch)
    expect(readFileSync(patch, 'utf8')).toContain('turn-2.txt')
    expect(readFileSync(patch, 'utf8')).not.toContain('turn-1.txt')
  })
})
