import { afterEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { beginTurnCheckpoint, endTurnCheckpoint, onTurnCheckpointed } = await import('@solus/server/git/turn-checkpoints')
type TurnCheckpointed = import('@solus/server/git/turn-checkpoints').TurnCheckpointed
type CheckpointFolder = import('@solus/server/git/turn-checkpoints').CheckpointFolder
const { getDiffStats, listTurnSnapshots } = await import('@solus/server/git/session-snapshots')
const { TurnActivity } = await import('@solus/server/git/turn-activity')
const { actAsHostForTests } = await import('@solus/server/execution/seats/acting-identity')

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

/** A folder that holds the repositories of one test, with its real path: a session folder is named by it. */
function createRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-checkpoint-repositories-')))
  dirs.push(root)
  return root
}

function createRepo(root: string, name: string): string {
  const cwd = join(root, name)
  mkdirSync(cwd)
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 'test@example.com'])
  git(cwd, ['config', 'user.name', 'Test'])
  writeFileSync(join(cwd, 'tracked.txt'), 'first\n')
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-m', 'base'])
  return cwd
}

function folderOf(path: string): CheckpointFolder {
  return { path, repositoryPath: path, name: basename(path) }
}

/** The refs and the sidecar files that checkpoints wrote in a repository. */
function written(repo: string): { refs: string[]; hasSidecars: boolean } {
  return {
    refs: git(repo, ['for-each-ref', '--format=%(refname)', 'refs/solus']).split('\n').filter(Boolean),
    hasSidecars: existsSync(join(repo, '.git', 'solus', 'sessions')),
  }
}

/** The next checkpoint of a session, as its listener hears it. */
function nextCheckpoint(sessionId: string): Promise<TurnCheckpointed> {
  return new Promise((resolve) => {
    const stop = onTurnCheckpointed((checkpoint) => {
      if (checkpoint.sessionId !== sessionId) return
      stop()
      resolve(checkpoint)
    })
  })
}

const facts = { partial: false, userMessagePreview: 'work' }

// The helpers under test start processes; with no caller, they act as the host (plans/019).
actAsHostForTests()

describe('turn checkpoints for each repository of a session', () => {
  // WHY: a codebase can have many repositories and a turn changes few. A
  // repository that the turn left alone must cost a status read and nothing
  // else: a ref and a sidecar entry in each one, at each turn, would make a
  // turn slower with each repository that a person adds to the codebase.
  test('a turn that changes one of three repositories writes one snapshot', async () => {
    const root = createRoot()
    const [app, api, web] = ['app', 'api', 'web'].map((name) => createRepo(root, name))
    const target = { sessionId: 'three-repositories', workTree: app, folders: () => [folderOf(api), folderOf(web)] }

    await beginTurnCheckpoint(target)
    expect(written(api)).toEqual({ refs: [], hasSidecars: false })
    writeFileSync(join(api, 'handler.ts'), 'export {}\n')
    await endTurnCheckpoint(target, facts)

    expect((await listTurnSnapshots(api, 'three-repositories')).map((turn) => [turn.index, turn.filesChanged])).toEqual([[0, 1]])
    expect(written(web)).toEqual({ refs: [], hasSidecars: false })
    // The working directory keeps its snapshot at each turn, also with no change.
    expect((await listTurnSnapshots(app, 'three-repositories')).map((turn) => turn.filesChanged)).toEqual([0])

    // A later turn that leaves the changed repository alone adds no entry to it.
    git(api, ['add', '.'])
    git(api, ['commit', '-m', 'handler'])
    await beginTurnCheckpoint(target)
    await endTurnCheckpoint(target, facts)
    expect(await listTurnSnapshots(api, 'three-repositories')).toHaveLength(1)
    expect(written(web)).toEqual({ refs: [], hasSidecars: false })
  })

  // WHY: a session folder often has a person's own changes when a turn starts.
  // They are not the turn's work, so the folder is captured at the turn start
  // and the turn's diff is only what the turn changed.
  test('a repository with changes at the turn start shows only the change of the turn', async () => {
    const root = createRoot()
    const app = createRepo(root, 'app')
    const api = createRepo(root, 'api')
    const target = { sessionId: 'dirty-start', workTree: app, folders: () => [folderOf(api)] }
    writeFileSync(join(api, 'by-a-person.txt'), 'before the turn\n')

    await beginTurnCheckpoint(target)
    expect(written(api).refs).toEqual(['refs/solus/sessions/dirty-start/base'])
    writeFileSync(join(api, 'by-the-turn.txt'), 'in the turn\n')
    await endTurnCheckpoint(target, facts)

    const [turn] = await listTurnSnapshots(api, 'dirty-start')
    expect((await getDiffStats(api, api, { kind: 'turn', index: turn.index }, 'dirty-start')).map((file) => file.path)).toEqual(['by-the-turn.txt'])
    expect((await getDiffStats(api, api, { kind: 'session' }, 'dirty-start')).map((file) => file.path)).toEqual(['by-the-turn.txt'])
  })

  // WHY: a folder that is clean at the turn start has no tree, so the live
  // session diff had nothing to read while the turn ran. It reads against the
  // commit that was noted.
  test('the session diff of a clean repository shows the open turn before it ends', async () => {
    const root = createRoot()
    const app = createRepo(root, 'app')
    const api = createRepo(root, 'api')
    const target = { sessionId: 'live-read', workTree: app, folders: () => [folderOf(api)] }

    await beginTurnCheckpoint(target)
    writeFileSync(join(api, 'tracked.txt'), 'first\nsecond\n')
    expect(await getDiffStats(api, api, { kind: 'session' }, 'live-read')).toEqual([{ path: 'tracked.txt', additions: 1, deletions: 0, status: 'M' }])
    await endTurnCheckpoint(target, facts)
    expect(await getDiffStats(api, api, { kind: 'session' }, 'live-read')).toEqual([{ path: 'tracked.txt', additions: 1, deletions: 0, status: 'M' }])
  })

  // WHY: the agent attaches a folder in the middle of a turn and then changes
  // it. The folder has no start for that turn. Its first checkpoint must not
  // fail, and it must not show a person's older changes, or the whole
  // repository, as the turn's work: it shows the files written after the turn
  // started.
  test('a folder attached in the middle of a turn shows the files written after the turn started', async () => {
    const root = createRoot()
    const app = createRepo(root, 'app')
    const api = createRepo(root, 'api')
    const folders: CheckpointFolder[] = []
    const target = { sessionId: 'attached-in-turn', workTree: app, folders: () => folders }
    writeFileSync(join(api, 'older.txt'), 'by a person, before the turn\n')
    const before = Date.now() / 1000 - 3_600
    utimesSync(join(api, 'older.txt'), before, before)

    await beginTurnCheckpoint(target)
    folders.push(folderOf(api))
    writeFileSync(join(api, 'after-attach.txt'), 'by the agent\n')
    await endTurnCheckpoint(target, facts)

    const turns = await listTurnSnapshots(api, 'attached-in-turn')
    expect(turns.map((turn) => turn.filesChanged)).toEqual([1])
    expect((await getDiffStats(api, api, { kind: 'turn', index: 0 }, 'attached-in-turn')).map((file) => file.path)).toEqual(['after-attach.txt'])
    expect((await getDiffStats(api, api, { kind: 'session' }, 'attached-in-turn')).map((file) => file.path)).toEqual(['after-attach.txt'])
  })

  test('a folder attached in a turn that does not change it gets no checkpoint', async () => {
    const root = createRoot()
    const app = createRepo(root, 'app')
    const api = createRepo(root, 'api')
    const folders: CheckpointFolder[] = []
    const target = { sessionId: 'attached-unchanged', workTree: app, folders: () => folders }

    await beginTurnCheckpoint(target)
    folders.push(folderOf(api))
    await endTurnCheckpoint(target, facts)

    expect(written(api)).toEqual({ refs: [], hasSidecars: false })
  })

  // WHY: a session folder is named by its path and the provider is also granted
  // its real path. Two targets in one repository would write the same sidecar
  // two times for one turn and count its change two times.
  test('a path and its real path are one target', async () => {
    const root = createRoot()
    const app = createRepo(root, 'app')
    const api = createRepo(root, 'api')
    const link = join(root, 'api-link')
    symlinkSync(api, link)
    const target = { sessionId: 'one-target', workTree: app, folders: () => [folderOf(api), folderOf(link)] }
    const heard = nextCheckpoint('one-target')

    await beginTurnCheckpoint(target)
    writeFileSync(join(api, 'handler.ts'), 'export {}\n')
    await endTurnCheckpoint(target, facts)

    expect(await listTurnSnapshots(api, 'one-target')).toHaveLength(1)
    expect((await heard).turn).toMatchObject({ filesChanged: 1, additions: 1 })
  })

  // WHY: each repository counts its own snapshots, so one turn has a different
  // index in each of them. The trace id of the turn is the join.
  test('the snapshots of one turn in two repositories have one trace id and different indexes', async () => {
    const root = createRoot()
    const app = createRepo(root, 'app')
    const api = createRepo(root, 'api')
    const target = { sessionId: 'joined', workTree: app, folders: () => [folderOf(api)] }

    await beginTurnCheckpoint(target)
    writeFileSync(join(app, 'one.txt'), 'one\n')
    await endTurnCheckpoint(target, { ...facts, traceId: 'trace-1' })
    await beginTurnCheckpoint(target)
    writeFileSync(join(app, 'two.txt'), 'two\n')
    writeFileSync(join(api, 'two.txt'), 'two\n')
    await endTurnCheckpoint(target, { ...facts, traceId: 'trace-2' })

    const inApp = (await listTurnSnapshots(app, 'joined')).find((turn) => turn.traceId === 'trace-2')
    const inApi = (await listTurnSnapshots(api, 'joined')).find((turn) => turn.traceId === 'trace-2')
    expect([inApp?.index, inApi?.index]).toEqual([1, 0])
    expect((await getDiffStats(api, api, { kind: 'turn', index: inApi!.index }, 'joined')).map((file) => file.path)).toEqual(['two.txt'])
  })
})

describe('the change summary of a session with several repositories', () => {
  // WHY: the digest shows what a session changed with no Git read. With one
  // summary for each repository's checkpoint, the last repository to end its
  // turn replaced the others, and a parent saw only a part of a child's work.
  test('a checkpoint holds the totals of the session and one entry for each changed repository', async () => {
    const root = createRoot()
    const app = createRepo(root, 'app')
    const api = createRepo(root, 'api')
    const web = createRepo(root, 'web')
    const target = { sessionId: 'summary', workTree: app, folders: () => [folderOf(api), { path: web, repositoryPath: web, name: 'Web client' }] }

    // The first turn changes one repository: the summary names no repository.
    let heard = nextCheckpoint('summary')
    await beginTurnCheckpoint(target)
    writeFileSync(join(api, 'handler.ts'), 'one\ntwo\n')
    await endTurnCheckpoint(target, facts)
    const first = await heard
    expect(first.changes).toEqual({ files: [{ path: '../api/handler.ts', additions: 2, deletions: 0, status: 'A' }], filesChanged: 1, additions: 2, deletions: 0 })
    expect(first.turn).toEqual({ filesChanged: 1, additions: 2, deletions: 0, endedAt: expect.any(Number) })

    // The second turn changes two others. The first repository stays in the summary.
    heard = nextCheckpoint('summary')
    await beginTurnCheckpoint(target)
    writeFileSync(join(app, 'tracked.txt'), 'first\nsecond\nthird\nfourth\n')
    writeFileSync(join(web, 'page.ts'), 'one\n')
    await endTurnCheckpoint(target, facts)
    const second = await heard

    expect(second.changes).toMatchObject({ filesChanged: 3, additions: 6, deletions: 0 })
    expect(second.changes.files.map((file) => file.path)).toEqual(['tracked.txt', '../api/handler.ts', '../web/page.ts'])
    expect(second.changes.repositories).toEqual([
      { repositoryPath: app, name: 'app', files: [{ path: 'tracked.txt', additions: 3, deletions: 0, status: 'M' }], filesChanged: 1, additions: 3, deletions: 0 },
      { repositoryPath: api, name: 'api', files: [{ path: 'handler.ts', additions: 2, deletions: 0, status: 'A' }], filesChanged: 1, additions: 2, deletions: 0 },
      { repositoryPath: web, name: 'Web client', files: [{ path: 'page.ts', additions: 1, deletions: 0, status: 'A' }], filesChanged: 1, additions: 1, deletions: 0 },
    ])
    expect(second.turn).toMatchObject({ filesChanged: 2, additions: 4, deletions: 0 })
    expect(second.turn.repositories).toEqual([
      { repositoryPath: app, name: 'app', filesChanged: 1, additions: 3, deletions: 0 },
      { repositoryPath: web, name: 'Web client', filesChanged: 1, additions: 1, deletions: 0 },
    ])
  })
})

describe('turn activity for each repository', () => {
  // WHY: a session with two repositories has an open turn in each. With one
  // open turn for a session, the start in the second repository ended the turn
  // in the first, and another session's writes there were no longer told apart.
  test('two open turns of one session in two repositories do not end each other', () => {
    const activity = new TurnActivity()
    activity.turnStarted('other', '/repo/a')
    activity.turnStarted('other', '/repo/b')
    activity.turnStarted('own', '/repo/a')
    activity.turnStarted('own', '/repo/b')

    expect(activity.concurrentTurn('own', '/repo/a')).not.toBeNull()
    expect(activity.concurrentTurn('own', '/repo/b')).not.toBeNull()

    activity.turnEnded('own', '/repo/b')
    expect(activity.concurrentTurn('own', '/repo/b')).toBeNull()
    expect(activity.concurrentTurn('own', '/repo/a')).not.toBeNull()

    // A tool call of the session counts in each repository it has an open turn in.
    activity.turnStarted('own', '/repo/b')
    activity.observe('own', { type: 'tool_call', toolName: 'Bash', toolId: 'tool', index: 0 })
    const now = Date.now()
    expect(activity.concurrentTurn('own', '/repo/a')?.isOwnToolCallAt(now)).toBe(true)
    expect(activity.concurrentTurn('own', '/repo/b')?.isOwnToolCallAt(now)).toBe(true)

    activity.sessionTurnsEnded('own')
    expect(activity.concurrentTurn('own', '/repo/a')).toBeNull()
    expect(activity.concurrentTurn('own', '/repo/b')).toBeNull()
  })
})
