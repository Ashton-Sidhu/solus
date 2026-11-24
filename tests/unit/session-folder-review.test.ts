import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionFolder } from '@solus/contracts/codebases'
import type { ChangedFileStat, DiffRequest, DiffResult, DiffScope, TurnSnapshot } from '@solus/contracts/git-types'
import type { GitCheckoutBranchResult, IpcContext, NormalizedEvent } from '@solus/contracts/types'
import type { Actor } from '@solus/server/admission/actor'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'
import { git } from '@solus/server/git/exec'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/codebases.md §8: review and Git actions for each repository of a
// session. A client names a repository of the session in a diff request, and
// aims a Git action at a session folder with the context of that folder. The
// session stays bound to its one working directory through all of it.

type Runtime = import('@solus/server/execution/session-runtime').SessionRuntime
type Handler = (args: unknown[], ctx: { actor: Actor }) => Promise<unknown>

let root: string
let runtime: Runtime
let HOST_ACTOR: Actor
let database: typeof import('@solus/server/db')
let checkpoints: typeof import('@solus/server/git/turn-checkpoints')
const handlers = new Map<string, Handler>()
const events: NormalizedEvent[] = []
const previousDataDir = process.env.SOLUS_DATA_DIR
const SESSION = 'review-session'

// The handlers under test start Git processes; with no caller, they act as the host.
actAsHostForTests()

const at = (path: string): string => join(root, path)

function createRepo(name: string): void {
  mkdirSync(at(name), { recursive: true })
  git(['init', '-b', 'main'], at(name))
  git(['config', 'user.email', 'test@example.com'], at(name))
  git(['config', 'user.name', 'Test'], at(name))
  writeFileSync(join(at(name), 'tracked.txt'), 'first\n')
  git(['add', '.'], at(name))
  git(['commit', '-m', 'base'], at(name))
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-folder-review-')))
  process.env.SOLUS_DATA_DIR = join(root, 'data')
  const { SessionRuntime } = await import('@solus/server/execution/session-runtime')
  ;({ HOST_ACTOR } = await import('@solus/server/admission/actor'))
  database = await import('@solus/server/db')
  checkpoints = await import('@solus/server/git/turn-checkpoints')
  const { registerWorktreeHandlers } = await import('@solus/server/transport/handlers/worktree-handlers')
  const { registerGitPublishHandlers } = await import('@solus/server/transport/handlers/git-publish-handlers')

  for (const name of ['app', 'api', 'outside']) createRepo(name)
  mkdirSync(at('notes'))
  writeFileSync(join(at('notes'), 'plan.md'), 'a plan\n')

  runtime = new SessionRuntime(new Map())
  runtime.on('event', (id: string, event: NormalizedEvent) => { if (id === SESSION) events.push(event) })
  const server = { register: (method: string, handler: Handler) => { handlers.set(method, handler) } }
  // SAFETY: the handlers under test use only the runtime; no test here reaches the other dependencies.
  registerWorktreeHandlers(server as never, { sessionRuntime: runtime } as never)
  registerGitPublishHandlers(server as never, { sessionFolders: runtime.sessionFolders })

  // The session works in `app`, and has `api` (a repository) and `notes` (a plain folder) attached.
  await runtime.sessionFolders.resolve(SESSION, { workingDirectory: at('app'), actor: HOST_ACTOR })
  await runtime.sessionFolders.attach(SESSION, at('api'), 'attached', HOST_ACTOR)
  await runtime.sessionFolders.attach(SESSION, at('notes'), 'attached', HOST_ACTOR)
  runtime.sessionCheckouts.setSessionGitEnvironment(SESSION, at('app'), { branch: 'main', targetBranch: 'main' })
})

afterAll(() => {
  database.closeDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

/** The context of the session's own checkout, as its tab sends it. */
function sessionCtx(): IpcContext {
  // SAFETY: the handlers under test read only these fields of a context.
  return { session: { sessionId: SESSION, agentSessionId: null, workingDirectory: at('app'), gitContext: null }, statusBar: {} } as never
}

/** The context a client builds to aim a Git action at a session folder: the folder is its working directory. */
function folderCtx(path: string): IpcContext {
  // SAFETY: as above.
  return { session: { sessionId: SESSION, agentSessionId: null, workingDirectory: path, gitContext: null }, statusBar: {} } as never
}

const call = <T>(method: string, ...args: unknown[]): Promise<T> => handlers.get(method)!(args, { actor: HOST_ACTOR }) as Promise<T>
const stats = (request: DiffRequest) => call<ChangedFileStat[]>('diffStats', sessionCtx(), request)
const pathsOf = async (request: DiffRequest) => (await stats(request)).map((file) => file.path)
const boundDirectory = () => runtime.sessionCheckouts.sessionCheckoutPaths.get(SESSION)

describe('the diff of one repository of a session', () => {
  test('each scope reads the session folder that the request names, and no name reads the working directory', async () => {
    const repositoryPath = at('api')
    const target = { sessionId: SESSION, workTree: at('app'), folders: () => runtime.sessionFolders.checkpointTargets(SESSION) }
    git(['checkout', '-b', 'feature'], repositoryPath)
    writeFileSync(join(repositoryPath, 'committed.txt'), 'on the branch\n')
    git(['add', '.'], repositoryPath)
    git(['commit', '-m', 'feature'], repositoryPath)

    await checkpoints.beginTurnCheckpoint(target)
    writeFileSync(join(repositoryPath, 'tracked.txt'), 'first\nby the turn\n')
    writeFileSync(join(at('app'), 'app-only.txt'), 'in the working directory\n')
    await checkpoints.endTurnCheckpoint(target, { partial: false, userMessagePreview: 'work', traceId: 'trace-1' })

    const turns = await call<TurnSnapshot[]>('listTurnSnapshots', sessionCtx(), repositoryPath)
    expect(turns.map((turn) => [turn.index, turn.filesChanged, turn.traceId])).toEqual([[0, 1, 'trace-1']])

    const scopes: Array<[DiffScope, string[]]> = [
      [{ kind: 'session' }, ['tracked.txt']],
      [{ kind: 'turn', index: 0 }, ['tracked.txt']],
      [{ kind: 'working-tree' }, ['tracked.txt']],
      [{ kind: 'branch' }, ['committed.txt', 'tracked.txt']],
    ]
    for (const [scope, expected] of scopes) {
      expect((await pathsOf({ scope, repositoryPath })).sort()).toEqual(expected)
      expect((await call<DiffResult | null>('diff', sessionCtx(), { scope, repositoryPath }))?.patch).toContain('b/tracked.txt')
    }
    expect((await call<ChangedFileStat[][]>('diffStatsBatch', sessionCtx(), [{ scope: { kind: 'session' }, repositoryPath }, { scope: { kind: 'session' } }]))
      .map((files) => files.map((file) => file.path))).toEqual([['tracked.txt'], ['app-only.txt']])
    const contents = await call<{ newFile: { contents: string } | null } | null>('diffFileContents', sessionCtx(), { scope: { kind: 'session' }, path: 'tracked.txt', repositoryPath })
    expect(contents?.newFile?.contents).toBe('first\nby the turn\n')

    // Without a repository, and with the working directory as the repository, the answer is today's.
    expect(await pathsOf({ scope: { kind: 'session' } })).toEqual(['app-only.txt'])
    expect(await pathsOf({ scope: { kind: 'session' }, repositoryPath: at('app') })).toEqual(['app-only.txt'])
  })

  // WHY: a diff request needs only read access to its session. With a free
  // path in it, that access would read the changes of any repository on the host.
  test('a repository that is not a folder of the session is refused', async () => {
    await expect(stats({ scope: { kind: 'working-tree' }, repositoryPath: at('outside') })).rejects.toThrow('is not a repository of this session')
    await expect(call('diff', sessionCtx(), { scope: { kind: 'working-tree' }, repositoryPath: at('outside') })).rejects.toThrow('is not a repository of this session')
    await expect(call('listTurnSnapshots', sessionCtx(), at('outside'))).rejects.toThrow('is not a repository of this session')
    // A plain session folder has no repository to read.
    await expect(stats({ scope: { kind: 'working-tree' }, repositoryPath: at('notes') })).rejects.toThrow('is not a repository of this session')
  })
})

describe('a Git action in a session folder', () => {
  // WHY: the Git handlers bind the session to the checkout they acted in. In a
  // session folder that replaced the session's one working directory, so the
  // next turn of the session started in the wrong repository.
  test('leaves the session bound to its working directory, and the folder reports its new branch', async () => {
    expect(boundDirectory()).toBe(at('app'))
    events.length = 0

    const result = await call<GitCheckoutBranchResult>('gitCheckoutBranch', folderCtx(at('api')), 'topic', { create: true })
    expect(result).toMatchObject({ success: true, workingDirectory: at('api'), gitContext: { branch: 'topic' } })
    await call('gitRegisterEnvironment', folderCtx(at('api')), at('api'), result.gitContext)

    expect(boundDirectory()).toBe(at('app'))
    expect(runtime.sessionCheckouts.getGitContext(SESSION)?.branch).toBe('main')
    expect(events).toContainEqual(expect.objectContaining({ type: 'git_context', cwd: at('api'), gitContext: expect.objectContaining({ branch: 'topic' }) }))
  })

  test('in the working directory still records the new branch for the session', async () => {
    const result = await call<GitCheckoutBranchResult>('gitCheckoutBranch', sessionCtx(), 'app-topic', { create: true })
    expect(result.success).toBe(true)
    expect(boundDirectory()).toBe(at('app'))
    expect(runtime.sessionCheckouts.getGitContext(SESSION)?.branch).toBe('app-topic')
  })
})

describe('Track with Git in a plain session folder', () => {
  test('makes it a `git` folder of the session that is watched', async () => {
    const stateOf = (path: string): SessionFolder['state'] | undefined => runtime.sessionFolders.foldersOf(SESSION).find((folder) => folder.path === path)?.state
    expect(stateOf(at('notes'))).toBe('plain')
    events.length = 0

    await call('gitInitRepository', at('notes'))

    expect(stateOf(at('notes'))).toBe('git')
    expect(runtime.sessionFolders.checkpointTargets(SESSION).map((folder) => folder.path)).toContain(at('notes'))
    expect(events).toContainEqual(expect.objectContaining({ type: 'session_folders', folders: expect.arrayContaining([expect.objectContaining({ path: at('notes'), state: 'git' })]) }))
    // The folder is registered with the checkout service: the session hears its Git state from now on.
    await runtime.checkouts.refresh(at('notes'))
    expect(events).toContainEqual(expect.objectContaining({ type: 'git_context', cwd: at('notes') }))
  })
})
