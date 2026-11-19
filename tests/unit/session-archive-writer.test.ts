import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
