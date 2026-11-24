import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isTaskFolderPath, TASK_FOLDER_ROOT_NAME, type Codebase, type SessionFolder } from '@solus/contracts/codebases'
import { encodePathAsFolder, isSolusWorktreePath, SOLUS_WORKTREE_PATH_MARKER, type AgentMetadata, type GitCheckout, type NormalizedEvent, type SessionRunInput, type StatusCardState } from '@solus/contracts/types'
import type { Actor } from '@solus/server/admission/actor'
import type { AgentBackend, PermissionResponder, RunHandle } from '@solus/server/execution/agents/agent-backend'
import type { AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'
import type { WorktreeMoveRuntime } from '@solus/server/execution/sessions/worktree-move'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))
// The name that the writing model gives a new branch. Null: the model gave none, so the temporary branch stays.
let generatedName: string | null = null
mock.module('@solus/server/git/worktree-name', () => ({ generateWorktreeName: async () => generatedName }))
actAsHostForTests()

// docs/plans/codebases.md §7: a worktree session of several repositories, or of
// a plain folder, works in a task folder. These tests connect a real session
// runtime to real repositories, because each rule is about where a session
// works and what is on the disk after a change.

type Runtime = import('@solus/server/execution/session-runtime').SessionRuntime
const LONG = 60_000

let root: string
let runtimeModule: typeof import('@solus/server/execution/session-runtime')
let codebases: typeof import('@solus/server/data/codebases/codebases')
let store: typeof import('@solus/server/git/task-folder-store')
let taskFolders: typeof import('@solus/server/git/task-folders')
let indexer: typeof import('@solus/server/db/session-indexer')
let moveModule: typeof import('@solus/server/execution/sessions/worktree-move')
let HOST_ACTOR: Actor
let installationId: string
const previousEnv = { dataDir: process.env.SOLUS_DATA_DIR, globalConfig: process.env.GIT_CONFIG_GLOBAL, systemConfig: process.env.GIT_CONFIG_SYSTEM }

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
const branchOf = (checkout: string): string => git(checkout, 'rev-parse', '--abbrev-ref', 'HEAD')
const branchesOf = (repositoryPath: string): string[] => git(repositoryPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean)
const isLink = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false
const isLinkedWorktree = (path: string): boolean => lstatSync(join(path, '.git'), { throwIfNoEntry: false })?.isFile() ?? false

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-session-task-folders-')))
  process.env.SOLUS_DATA_DIR = join(root, 'data')
  mkdirSync(join(root, 'data'))
  // Git must not read the configuration of the person who runs the tests.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_SYSTEM = '/dev/null'
  runtimeModule = await import('@solus/server/execution/session-runtime')
  codebases = await import('@solus/server/data/codebases/codebases')
  store = await import('@solus/server/git/task-folder-store')
  taskFolders = await import('@solus/server/git/task-folders')
  indexer = await import('@solus/server/db/session-indexer')
  moveModule = await import('@solus/server/execution/sessions/worktree-move')
  ;({ HOST_ACTOR } = await import('@solus/server/admission/actor'))
  installationId = (await import('@solus/server/admission/auth')).getInstallationId()
})

afterAll(async () => {
  ;(await import('@solus/server/data/insights/metrics-db')).closeMetricsDb()
  ;(await import('@solus/server/db')).closeDb()
  rmSync(root, { recursive: true, force: true })
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  restore('SOLUS_DATA_DIR', previousEnv.dataDir)
  restore('GIT_CONFIG_GLOBAL', previousEnv.globalConfig)
  restore('GIT_CONFIG_SYSTEM', previousEnv.systemConfig)
})

class Permissions implements PermissionResponder {
  getPendingInfo(): undefined { return undefined }
  respondToPermission(): boolean { return false }
  respondToQuestion(): boolean { return false }
  clearPendingForSession(): void {}
  setCurrentSessionId(): void {}
}

/** A backend that records each run it is handed and starts it at once. The run does not end. */
class RecordingBackend extends EventEmitter implements AgentBackend {
  readonly id = 'claude-code' as const
  readonly metadata: AgentMetadata = { id: 'claude-code', label: 'Claude Code', models: [], defaultModel: 'claude-sonnet-5' }
  readonly permissions = new Permissions()
  readonly runs: AgentRunRequest[] = []

  startRun(request: AgentRunRequest): RunHandle {
    this.runs.push(request)
    return {
      agentSessionId: `claude-${this.runs.length}`,
      persistence: request.persistence,
      startedAt: Date.now(),
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController: new AbortController(),
      runPromise: new Promise<void>(() => {}),
      _resolveRun: () => {},
      _rejectRun: () => {},
    }
  }

  getSessionHandle(): RunHandle | undefined { return undefined }
  getPendingHandles(): RunHandle[] { return [] }
  cancelSession(): boolean { return false }
  isSessionRunning(): boolean { return false }
  async steerSession(): Promise<null> { return null }
  loadHistory(): Promise<never[]> { return Promise.resolve([]) }
  loadSessionSkills(): Promise<never[]> { return Promise.resolve([]) }
  getEnrichedError() { return { message: 'failed', isError: true, stderrTail: [] } }
}

/** A repository with one commit on `main`. */
function repository(path: string): string {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  writeFileSync(join(path, 'README.md'), 'readme\n')
  git(path, 'add', '.')
  git(path, 'commit', '-q', '-m', 'first')
  return path
}

interface Shop {
  shop: string
  api: string
  web: string
  codebase: Codebase
}

let nextShop = 0
/**
 * A plain folder `shop` with the repositories `api` and `web` and a file, and
 * a codebase of the container `shop` and a folder on a different host. The second root adds
 * no member on this host.
 */
async function shopCodebase(): Promise<Shop> {
  const shop = join(root, `work-${++nextShop}`, 'shop')
  mkdirSync(shop, { recursive: true })
  writeFileSync(join(shop, 'NOTES.md'), 'the shop\n')
  const codebase = await codebases.saveCodebase('local', 'owner', {
    id: `task-folder-codebase-${nextShop}`, name: 'shop', updatedAt: 1_000, deletedAt: null,
    roots: [{ installationId, path: shop, name: '', container: true }, { installationId: 'installation-build-server', path: '/srv/infra', name: 'infra' }],
  })
  return { shop, api: repository(join(shop, 'api')), web: repository(join(shop, 'web')), codebase }
}

function input(workingDirectory: string, overrides: Partial<SessionRunInput> = {}): SessionRunInput {
  return {
    codebaseId: null, provider: 'claude-code', agentSessionId: null, forked: false, workingDirectory, projectPath: workingDirectory,
    gitContext: null, worktreeBaseBranch: 'main', worktreeRepositories: null, contextWindow: null,
    model: 'claude-opus-5', preferredModel: 'claude-opus-5', reasoningEffort: 'medium', fastMode: false,
    permissionMode: 'supervised', rateLimitBehavior: 'queue', extraInstructions: '',
    ...overrides,
  }
}

interface Plane {
  runtime: Runtime
  backend: RecordingBackend
  events: { sessionId: string; event: NormalizedEvent }[]
  cardsOf(sessionId: string): StatusCardState[]
  foldersPublishedFor(sessionId: string): SessionFolder[][]
  /** Start the first turn of a session and wait until its provider has started. */
  start(sessionId: string, runInput: SessionRunInput): Promise<AgentRunRequest>
}

function plane(): Plane {
  const backend = new RecordingBackend()
  const runtime = new runtimeModule.SessionRuntime(new Map([['claude-code', backend]]))
  runtime.on('error', () => {})
  const events: Plane['events'] = []
  runtime.on('event', (sessionId: string, event: NormalizedEvent) => events.push({ sessionId, event }))
  const eventsOf = (sessionId: string) => events.filter((each) => each.sessionId === sessionId).map((each) => each.event)
  return {
    runtime,
    backend,
    events,
    cardsOf: (sessionId) => eventsOf(sessionId).flatMap((event) => (event.type === 'status_card' ? [event.card] : [])),
    foldersPublishedFor: (sessionId) => eventsOf(sessionId).flatMap((event) => (event.type === 'session_folders' ? [event.folders] : [])),
    start: async (sessionId, runInput) => {
      const lifecycle = await runtime.runTurn({ target: { kind: 'new-session' }, sessionId, input: runInput, tools: [], options: { prompt: 'do the work', promptSource: 'typed' } })
      await lifecycle.agentSessionId
      return backend.runs.at(-1)!
    },
  }
}

const taskFolderRoots = (): string[] => store.listTaskFolders().map((record) => record.root)

describe('the launch of a new worktree session', () => {
  test('a plain working member with two repositories works in a task folder', async () => {
    const { shop, api, web, codebase } = await shopCodebase()
    const { runtime, start, cardsOf, foldersPublishedFor } = plane()
    try {
      const run = await start('plain-member', input(shop, { codebaseId: codebase.id }))
      const taskFolder = store.findTaskFolderContaining(run.cwd)!

      // The session works in the folder that stands in for the member, and its project is the member.
      expect(isTaskFolderPath(run.cwd)).toBe(true)
      expect(run.cwd).toBe(taskFolder.primaryPath)
      expect(run.projectRoot).toBe(shop)
      expect(taskFolder).toMatchObject({ primaryRepositoryPath: shop, primaryIsWorktree: false, codebaseId: codebase.id })
      expect(isLink(join(run.cwd, 'NOTES.md'))).toBe(true)

      // Each repository has its worktree on the one branch, at the place of the original.
      const worktrees = { api: join(run.cwd, 'api'), web: join(run.cwd, 'web') }
      for (const worktree of Object.values(worktrees)) {
        expect(isLinkedWorktree(worktree)).toBe(true)
        expect(branchOf(worktree)).toBe(taskFolder.branch)
      }
      expect(branchOf(api)).toBe('main')

      // The folders of the session are the worktrees. The repository of each one stays the member.
      const folders = runtime.sessionFolders.foldersOf('plain-member')
      expect(folders).toEqual([
        { path: worktrees.api, name: 'api', state: 'git', repositoryPath: api, source: 'codebase', granted: true },
        { path: worktrees.web, name: 'web', state: 'git', repositoryPath: web, source: 'codebase', granted: true },
      ])
      expect(foldersPublishedFor('plain-member').at(-1)).toEqual(folders)
      // A turn checkpoint is made in each worktree, not in the shared checkout.
      expect(runtime.sessionFolders.checkpointTargets('plain-member').map((folder) => folder.path)).toEqual([worktrees.api, worktrees.web])

      // The prompt block names the worktrees, not the shared checkouts.
      expect(run.codebase).toEqual({
        name: 'shop',
        workingDirectory: { name: 'shop', path: run.cwd, state: 'plain' },
        folders: [{ name: 'api', path: worktrees.api, state: 'git' }, { name: 'web', path: worktrees.web, state: 'git' }],
        otherHosts: [{ name: 'infra', path: '/srv/infra', host: 'installation-build-server' }],
      })
      // The worktrees are in the working directory. The provider gets only the Git data of each repository, to commit there.
      expect(run.additionalDirectories).toEqual([join(api, '.git'), join(web, '.git')])

      // The setup card had progress for each repository.
      const cards = cardsOf('plain-member')
      const output = cards.at(-1)!.output ?? []
      expect(output.filter((line) => /^Worktree \d of 2: (api|web)$/.test(line)).sort()).toHaveLength(2)
      expect(output.some((line) => line.startsWith('Worktree 2 of 2: '))).toBe(true)
      // WHY: with several repositories, a person must see which one a step is on, so each step has one sub-step for each repository.
      const stepOf = (id: string) => cards.at(-1)!.steps.find((step) => step.id === id)!
      for (const id of ['fetch', 'checkout', 'submodules']) {
        expect(stepOf(id).substeps?.map((substep) => substep.label)).toEqual(['api', 'web'])
        expect(stepOf(id).detail).toBeUndefined()
      }
      // These repositories have no origin and no submodules, so only the checkout did work.
      expect(stepOf('fetch').substeps?.map((substep) => substep.status)).toEqual(['skipped', 'skipped'])
      expect(stepOf('checkout')).toMatchObject({ status: 'done', substeps: [{ id: api, status: 'done' }, { id: web, status: 'done' }] })
      for (const substep of stepOf('checkout').substeps ?? []) expect(substep.endedAt).toBeGreaterThanOrEqual(substep.startedAt!)
      expect(cards.at(-1)!.steps.find((step) => step.id === 'agent')?.substeps).toBeUndefined()

      // The client of this session names the member at the next turn: the session continues in its task folder.
      expect(runtime.taskFolders.ofTurn('plain-member', shop, shop)?.root).toBe(taskFolder.root)
      expect(runtime.taskFolders.ofTurn('a-different-session', shop, shop)).toBeNull()
    } finally {
      runtime.shutdown()
    }
  }, LONG)

  test('a repository with a second repository works in a task folder, with its checkout', async () => {
    const { api, web, codebase } = await shopCodebase()
    const { runtime, start, events } = plane()
    try {
      const run = await start('two-repositories', input(api, { codebaseId: codebase.id }))
      const taskFolder = store.findTaskFolderContaining(run.cwd)!
      expect(taskFolder).toMatchObject({ primaryPath: run.cwd, primaryRepositoryPath: api, primaryIsWorktree: true })

      // The checkout names the repository, which the path of a task folder cannot do.
      const checkout: GitCheckout = { branch: taskFolder.branch, targetBranch: 'main', worktreePath: run.cwd, repoRoot: api }
      expect(runtime.sessionCheckouts.getGitContext('two-repositories')).toEqual(checkout)
      expect(events).toContainEqual({ sessionId: 'two-repositories', event: { type: 'git_context', cwd: run.cwd, gitContext: checkout } })
      expect(run.projectRoot).toBe(api)

      const webWorktree = taskFolder.repositories[0]!.worktreePath
      expect(runtime.sessionFolders.foldersOf('two-repositories')).toEqual([
        { path: webWorktree, name: 'web', state: 'git', repositoryPath: web, source: 'codebase', granted: true },
      ])
      // The worktree of `web`, the Git data of its repository, and, as for each worktree session, the project root.
      expect(run.additionalDirectories).toEqual([join(web, '.git'), webWorktree, api])
    } finally {
      runtime.shutdown()
    }
  }, LONG)

  test('one repository chosen keeps the worktree inside the repository', async () => {
    const { api, codebase } = await shopCodebase()
    const before = taskFolderRoots()
    const { runtime, start } = plane()
    try {
      const run = await start('one-repository', input(api, { codebaseId: codebase.id, worktreeRepositories: [] }))
      expect(run.cwd.startsWith(`${api}${SOLUS_WORKTREE_PATH_MARKER}`)).toBe(true)
      expect(taskFolderRoots()).toEqual(before)
      // A single worktree cannot hold a second repository.
      await expect(runtime.taskFolders.addRepository('one-repository', join(api, '..', 'web'), HOST_ACTOR)).rejects.toThrow('Start a new worktree session')
      expect(await runtime.taskFolders.candidates('one-repository', HOST_ACTOR)).toEqual([])
    } finally {
      runtime.shutdown()
    }
  }, LONG)

  test('a session with no codebase is unchanged', async () => {
    const lone = repository(join(root, 'lone'))
    const before = taskFolderRoots()
    const { runtime, start } = plane()
    try {
      const run = await start('no-codebase', input(lone))
      expect(run.cwd.startsWith(`${lone}${SOLUS_WORKTREE_PATH_MARKER}`)).toBe(true)
      expect(run.additionalDirectories).toEqual([lone])
      expect(run.codebase).toBeUndefined()
      expect(taskFolderRoots()).toEqual(before)
    } finally {
      runtime.shutdown()
    }
  }, LONG)

  test('a choice that cannot be made is the error of the launch', async () => {
    const { shop, codebase } = await shopCodebase()
    const { runtime, start, cardsOf } = plane()
    try {
      await expect(start('refused-plan', input(shop, { codebaseId: codebase.id, worktreeRepositories: [join(root, 'not-a-member')] })))
        .rejects.toThrow("is not a folder of this session's codebase")
      const card = cardsOf('refused-plan').at(-1)!
      expect(card.status).toBe('error')
      expect(card.steps.find((step) => step.status === 'error')?.detail).toContain("is not a folder of this session's codebase")
    } finally {
      runtime.shutdown()
    }
  }, LONG)

  test('a repository whose checkout fails names the error in its sub-step', async () => {
    const { shop, web, codebase } = await shopCodebase()
    // Git cannot register a worktree of this repository.
    writeFileSync(join(web, '.git', 'worktrees'), 'not a folder\n')
    const { runtime, start, cardsOf } = plane()
    try {
      const failure = await start('failed-repository', input(shop, { codebaseId: codebase.id })).then(() => null, (error: Error) => error)
      expect(failure).toBeInstanceOf(Error)
      const card = cardsOf('failed-repository').at(-1)!
      expect(card.status).toBe('error')
      expect(card.recovery).toBe('worktree')
      // WHY: the person must know which repository to repair, so only that row has the message.
      const substeps = card.steps.flatMap((step) => step.substeps ?? [])
      const named = substeps.filter((substep) => substep.detail)
      expect(named.map((substep) => [substep.label, substep.status])).toEqual([['web', 'error']])
      expect(named[0]!.detail).toBe(failure!.message)
      // The step of that row failed, and it does not say the message a second time.
      const failedStep = card.steps.find((step) => step.substeps?.some((substep) => substep.detail))!
      expect(failedStep).toMatchObject({ id: 'checkout', status: 'error' })
      expect(failedStep.detail).toBeUndefined()
      // WHY: a failed card is final, so no row can show work in progress.
      expect(substeps.some((substep) => substep.status === 'active')).toBe(false)
    } finally {
      runtime.shutdown()
    }
  }, LONG)

  test('one repository gives a card with no sub-steps', async () => {
    const lone = repository(join(root, 'lone-card'))
    const { runtime, start, cardsOf } = plane()
    try {
      await start('one-repository-card', input(lone))
      const cards = cardsOf('one-repository-card')
      expect(cards.length).toBeGreaterThan(0)
      expect(cards.flatMap((card) => card.steps).some((step) => step.substeps !== undefined)).toBe(false)
    } finally {
      runtime.shutdown()
    }
  }, LONG)

  test('Stop during the creation leaves no folder, no record, and no branch', async () => {
    const { shop, api, web, codebase } = await shopCodebase()
    const before = taskFolderRoots()
    const { runtime, start } = plane()
    try {
      // The person stops when the first files are checked out.
      let stopped = false
      runtime.on('event', (sessionId: string, event: NormalizedEvent) => {
        if (stopped || sessionId !== 'stopped' || event.type !== 'status_card') return
        if (event.card.steps.some((step) => step.id === 'checkout' && step.status === 'active')) {
          stopped = true
          runtime.stopSession('stopped', HOST_ACTOR)
        }
      })
      await expect(start('stopped', input(shop, { codebaseId: codebase.id }))).rejects.toThrow()
      expect(stopped).toBe(true)

      expect(taskFolderRoots()).toEqual(before)
      const holder = join(root, 'data', TASK_FOLDER_ROOT_NAME)
      expect(existsSync(holder) ? readdirSync(holder).filter((name) => !before.some((known) => known.endsWith(name))) : []).toEqual([])
      expect(branchesOf(api)).toEqual(['main'])
      expect(branchesOf(web)).toEqual(['main'])
    } finally {
      runtime.shutdown()
    }
  }, LONG)
})

describe('a session in a task folder', () => {
  test('the branch namer renames each repository, and a refused rename renames none', async () => {
    const { shop, codebase } = await shopCodebase()
    const { runtime, start } = plane()
    try {
      generatedName = null
      const run = await start('named', input(shop, { codebaseId: codebase.id }))
      const taskFolder = store.findTaskFolderContaining(run.cwd)!
      const worktrees = taskFolder.repositories.map((each) => each.worktreePath)
      const temporary = taskFolder.branch

      // A person put one worktree on a different branch: that choice wins, and no repository is renamed.
      git(worktrees[1]!, 'switch', '-q', '-c', 'my-own-branch')
      generatedName = 'Fix Login'
      await runtime.taskFolders.nameBranch('named', taskFolder.root, 'fix the login', HOST_ACTOR)
      expect(branchOf(worktrees[0]!)).toBe(temporary)
      expect(store.findTaskFolderContaining(run.cwd)!.branch).toBe(temporary)

      git(worktrees[1]!, 'switch', '-q', temporary)
      await runtime.taskFolders.nameBranch('named', taskFolder.root, 'fix the login', HOST_ACTOR)
      expect(worktrees.map(branchOf)).toEqual(['solus/fix-login', 'solus/fix-login'])
      expect(store.findTaskFolderContaining(run.cwd)!.branch).toBe('solus/fix-login')
    } finally {
      generatedName = null
      runtime.shutdown()
    }
  }, LONG)

  test('a worktree folder that was deleted comes back at the next turn', async () => {
    const { shop, web, codebase } = await shopCodebase()
    const first = plane()
    let cwd: string
    try {
      cwd = (await first.start('restored', input(shop, { codebaseId: codebase.id }))).cwd
    } finally {
      first.runtime.shutdown()
    }
    const taskFolder = store.findTaskFolderContaining(cwd)!
    // The index of the session is what stays when the host starts again.
    indexer.persistIndexedSessionStart('restored', 'claude-code', cwd, encodePathAsFolder(cwd), 'claude-opus-5', 'medium')
    const webWorktree = join(cwd, 'web')
    writeFileSync(join(webWorktree, 'work.txt'), 'work\n')
    git(webWorktree, 'add', '.')
    git(webWorktree, 'commit', '-q', '-m', 'work')
    rmSync(webWorktree, { recursive: true, force: true })

    const second = plane()
    try {
      // The client names the member, and still asks for a new worktree: the session has its task folder.
      const run = await second.start('restored', input(shop, { codebaseId: codebase.id }))
      expect(run.cwd).toBe(cwd)
      expect(taskFolderRoots().filter((each) => each === taskFolder.root)).toHaveLength(1)
      expect(store.listTaskFolders().filter((record) => record.primaryRepositoryPath === shop)).toHaveLength(1)
      expect(isLinkedWorktree(webWorktree)).toBe(true)
      expect(branchOf(webWorktree)).toBe(taskFolder.branch)
      expect(existsSync(join(webWorktree, 'work.txt'))).toBe(true)
      expect(branchOf(web)).toBe('main')
    } finally {
      second.runtime.shutdown()
    }
  }, LONG)

  test('a repository of the codebase gets its worktree, and the new folders are published', async () => {
    const { shop, api, web, codebase } = await shopCodebase()
    // A plain folder is not offered: only a repository gets a worktree.
    mkdirSync(join(shop, 'docs'))
    const { runtime, start, foldersPublishedFor } = plane()
    try {
      const run = await start('added', input(shop, { codebaseId: codebase.id, worktreeRepositories: [api] }))
      expect(runtime.sessionFolders.foldersOf('added').map((folder) => folder.repositoryPath)).toEqual([api])
      // `web` has no worktree here, so the session does not reach its shared checkout.
      expect(isLinkedWorktree(join(run.cwd, 'web'))).toBe(false)
      expect(existsSync(join(run.cwd, 'web'))).toBe(false)
      expect((await runtime.taskFolders.candidates('added', HOST_ACTOR)).map((member) => member.path)).toEqual([web])

      const folders = await runtime.taskFolders.addRepository('added', web, HOST_ACTOR)
      expect(folders.map(({ path, repositoryPath }) => ({ path, repositoryPath }))).toEqual([
        { path: join(run.cwd, 'api'), repositoryPath: api },
        { path: join(run.cwd, 'web'), repositoryPath: web },
      ])
      expect(foldersPublishedFor('added').at(-1)).toEqual(folders)
      expect(branchOf(join(run.cwd, 'web'))).toBe(store.findTaskFolderContaining(run.cwd)!.branch)
      expect(await runtime.taskFolders.candidates('added', HOST_ACTOR)).toEqual([])
      await expect(runtime.taskFolders.addRepository('added', web, HOST_ACTOR)).rejects.toThrow('has no worktree in its task folder')
      await expect(runtime.taskFolders.addRepository('added', join(root, 'lone'), HOST_ACTOR)).rejects.toThrow('is not a repository of this session')
    } finally {
      runtime.shutdown()
    }
  }, LONG)

  test('a session in a container that had no codebase gets its task folder, and adds a repository of the container later', async () => {
    // WHY: a container is a codebase (decision 14). The host forms it before the plan of the worktree, so the first
    // worktree session of the folder is isolated, and a later repository comes from the same members.
    const shop = join(root, `work-${++nextShop}`, 'shop')
    const api = repository(join(shop, 'api'))
    const web = repository(join(shop, 'web'))
    const { runtime, start } = plane()
    try {
      const run = await start('container-added', input(shop, { worktreeRepositories: [api] }))
      expect(isTaskFolderPath(run.cwd)).toBe(true)
      const codebaseId = await runtime.sessionFolders.codebaseIdOf('container-added')
      expect(await codebases.getCodebase('local', codebaseId!)).toMatchObject({ roots: [{ path: shop, container: true }] })
      expect((await runtime.taskFolders.candidates('container-added', HOST_ACTOR)).map((member) => member.path)).toEqual([web])

      const folders = await runtime.taskFolders.addRepository('container-added', web, HOST_ACTOR)
      expect(folders.map(({ path, repositoryPath, source }) => ({ path, repositoryPath, source }))).toEqual([
        { path: join(run.cwd, 'api'), repositoryPath: api, source: 'codebase' },
        { path: join(run.cwd, 'web'), repositoryPath: web, source: 'codebase' },
      ])
    } finally {
      runtime.shutdown()
    }
  }, LONG)

  test('the attach rule gives the worktree of a repository, not its shared checkout', async () => {
    const { shop, api, web, codebase } = await shopCodebase()
    const { runtime, start } = plane()
    try {
      const run = await start('isolated', input(shop, { codebaseId: codebase.id, worktreeRepositories: [api] }))
      // WHY: a member needs no card, so without this rule an agent that names the original gets the checkout that each session shares.
      // The repositories of this file are in the temporary directory of the system, which an automatic trigger does not
      // attach. A member of the codebase is not such a trigger: a person put it in the codebase.
      expect(await runtime.sessionFolders.requestAttach('isolated', join(api, 'README.md'), 'attached', HOST_ACTOR)).toEqual({ kind: 'available', folder: join(run.cwd, 'api') })
      expect(await runtime.sessionFolders.requestAttach('isolated', web, 'attached', HOST_ACTOR)).toEqual({ kind: 'attached', folder: join(run.cwd, 'web'), addedToCodebase: false })
      expect(runtime.sessionFolders.foldersOf('isolated').map((folder) => folder.path)).toEqual([join(run.cwd, 'api'), join(run.cwd, 'web')])
    } finally {
      runtime.shutdown()
    }
  }, LONG)

  test('a move out with remove_worktree keeps a worktree that has changes, and says so', async () => {
    const { api, web, codebase } = await shopCodebase()
    const { runtime, start } = plane()
    try {
      const run = await start('moved-out', input(api, { codebaseId: codebase.id }))
      const taskFolder = store.findTaskFolderContaining(run.cwd)!
      const webWorktree = taskFolder.repositories[0]!.worktreePath
      writeFileSync(join(webWorktree, 'not-committed.txt'), 'work\n')

      const continued: string[] = []
      const { sessionCheckouts } = runtime
      const moveRuntime: WorktreeMoveRuntime = {
        checkouts: runtime.checkouts,
        getGitContext: (sessionId) => sessionCheckouts.getGitContext(sessionId),
        trackWorktreeMove: (sessionId, controller) => sessionCheckouts.trackWorktreeMove(sessionId, controller),
        moveSessionCheckout: (sessionId, directory, checkout) => sessionCheckouts.moveSessionCheckout(sessionId, directory, checkout),
        boundDirectories: () => sessionCheckouts.sessionCheckoutPaths.entries(),
        holdNextTurn: (sessionId, finish) => sessionCheckouts.holdNextTurn(sessionId, finish),
        continueSession: async (_sessionId, prompt) => { continued.push(prompt) },
        recordActivity: (subject, actor, kind) => runtime.recordActivity(subject, actor, kind),
        nameWorktreeBranch: (...args) => sessionCheckouts.nameWorktreeBranch(...args),
        taskFolders: runtime.taskFolders,
      }
      const mover = new moveModule.WorktreeMover(moveRuntime)
      const result = await mover.moveForAgent({ sessionId: 'moved-out', cwd: run.cwd, checkout: api, branch: 'main', removeWorktree: true, continueWith: 'go on', actor: HOST_ACTOR })

      // The agent hears in its turn what will stay, and the session is bound to a folder that exists.
      expect(result).toMatchObject({ success: true, directory: api, movesAtTurnEnd: false })
      expect(result.steps).toHaveLength(1)
      expect(result.steps[0]).toContain(`remove the task folder ${taskFolder.root}`)
      expect(result.steps[0]).toContain(`${webWorktree} has uncommitted changes and will stay`)
      expect(sessionCheckouts.sessionCheckoutPaths.get('moved-out')).toBe(api)

      mover.turnSettled('moved-out', 'completed')
      await sessionCheckouts.finishHeldMove('moved-out')
      await new Promise((resolve) => setTimeout(resolve, 0))

      // The clean worktree is gone, the one with changes stays with its file, and the next turn says so.
      expect(existsSync(run.cwd)).toBe(false)
      expect(existsSync(join(webWorktree, 'not-committed.txt'))).toBe(true)
      expect(store.findTaskFolderContaining(webWorktree)?.repositories.map((each) => each.worktreePath)).toEqual([webWorktree])
      expect(continued).toHaveLength(1)
      expect(continued[0]).toContain(`${webWorktree} (has uncommitted changes)`)
      expect(continued[0]!.endsWith('go on')).toBe(true)
      expect(branchOf(web)).toBe('main')
    } finally {
      runtime.shutdown()
    }
  }, LONG)
})

describe('the task folders at the start of the host', () => {
  test('a task folder that no session names is removed, and one that a session names stays', async () => {
    const named = await shopCodebase()
    const interrupted = await shopCodebase()
    const { runtime } = plane()
    try {
      const make = async ({ shop, codebase }: Shop, sessionId: string) => {
        const plan = await runtime.taskFolders.plan(sessionId, { codebaseId: codebase.id, projectFolder: shop, repositories: null, actor: HOST_ACTOR })
        return (await runtime.taskFolders.create(sessionId, plan!, { actor: HOST_ACTOR, baseBranch: 'main' })).taskFolder
      }
      const kept = await make(named, 'kept-session')
      const orphan = await make(interrupted, 'interrupted-session')
      // Only the first session reached its provider: its index names its working directory.
      indexer.persistIndexedSessionStart('kept-session', 'claude-code', kept.primaryPath, encodePathAsFolder(kept.primaryPath), 'claude-opus-5', 'medium')

      await runtime.taskFolders.sweepUnnamed()

      const roots = taskFolderRoots()
      expect(roots).toContain(kept.root)
      expect(roots).not.toContain(orphan.root)
      expect(existsSync(orphan.root)).toBe(false)
      expect(isLinkedWorktree(join(kept.primaryPath, 'api'))).toBe(true)
      // The removal of the task folder does not change the member that it stood in for.
      expect(existsSync(join(interrupted.shop, 'NOTES.md'))).toBe(true)
      expect(taskFolders.listTaskFolders().some((record) => record.root === orphan.root)).toBe(false)
    } finally {
      runtime.shutdown()
    }
  }, LONG)
})

describe('a session that moved into a new task folder, and a restart of the host before its next turn', () => {
  // WHY: the index of a session names its new working directory only at the
  // next turn. Without the session in the record of the task folder, the sweep
  // removed the folder, and the session then pointed at a path that was gone.
  test('the task folder stays while the index knows the session, and an interrupted creation for that session goes', async () => {
    const moved = await shopCodebase()
    const first = plane()
    let kept: string
    let unfinished: string
    try {
      // The session had its turns in the repository `api`: its index names that directory.
      indexer.persistIndexedSessionStart('moved-in', 'claude-code', moved.api, encodePathAsFolder(moved.api), 'claude-opus-5', 'medium')
      await first.runtime.sessionFolders.resolve('moved-in', { workingDirectory: moved.api, codebaseId: moved.codebase.id, actor: HOST_ACTOR })
      const checkout = await first.runtime.taskFolders.createForMove('moved-in', moved.api, { actor: HOST_ACTOR, baseBranch: 'main' })
      kept = store.findTaskFolderContaining(checkout!.worktreePath!)!.root
      expect(store.findTaskFolderContaining(kept)).toMatchObject({ sessionId: 'moved-in' })

      // A creation for the same session that the host did not finish: its record names no session.
      const plan = await first.runtime.taskFolders.plan('moved-in', { projectFolder: moved.shop, repositories: null, actor: HOST_ACTOR })
      const made = (await first.runtime.taskFolders.create('moved-in', plan!, { actor: HOST_ACTOR, baseBranch: 'main' })).taskFolder
      store.putTaskFolder({ ...store.findTaskFolderContaining(made.root)!, sessionId: null })
      unfinished = made.root
    } finally {
      first.runtime.shutdown()
    }

    const restarted = plane()
    try {
      await restarted.runtime.taskFolders.sweepUnnamed()

      expect(taskFolderRoots()).toContain(kept)
      expect(isLinkedWorktree(join(kept, 'api'))).toBe(true)
      expect(restarted.runtime.taskFolders.ofTurn('moved-in', join(kept, 'api'), null)?.root).toBe(kept)
      expect(taskFolderRoots()).not.toContain(unfinished)
      expect(existsSync(unfinished)).toBe(false)
    } finally {
      restarted.runtime.shutdown()
    }
  }, LONG)
})

describe('the record of a session in a task folder', () => {
  test('the index gives the member as the project root, and marks the session as a worktree session', async () => {
    const { shop, api, codebase } = await shopCodebase()
    const { runtime, start } = plane()
    try {
      const run = await start('indexed', input(shop, { codebaseId: codebase.id }))
      // WHY: the sidebar groups a session by `projectRoot`, and the path of a task folder does not name its project.
      indexer.persistIndexedSessionStart('indexed-thread', 'claude-code', run.cwd, encodePathAsFolder(run.cwd), 'claude-opus-5', 'medium')
      expect(indexer.getIndexedSession('indexed-thread')).toMatchObject({ cwd: run.cwd, projectRoot: shop, isWorktree: true })
      // A session row below a task gets the same project from the link, which has the checkout path beside it.
      const { sessionRecordsFor } = await import('@solus/server/data/tasks/host-records')
      expect(sessionRecordsFor(['indexed-thread']).get('indexed-thread')).toMatchObject({ checkout_path: run.cwd, project_root: shop })

      // A place in a worktree answers the repository of that worktree. A place in the stand-in answers the member.
      expect(store.projectRootOfPath(join(run.cwd, 'api', 'src'))).toBe(api)
      expect(store.projectRootOfPath(join(run.cwd, 'docs'))).toBe(shop)
      expect(store.projectRootOfPath(join(api, '.git/solus/worktrees/fix'))).toBe(api)
      expect(store.projectRootOfPath(shop)).toBe(shop)
      // A task folder that has no record cannot name a project.
      const unknown = join(root, 'data', TASK_FOLDER_ROOT_NAME, 'gone-0a1b2c3d', 'shop')
      expect(store.projectRootOfPath(unknown)).toBe(unknown)
      expect(isSolusWorktreePath(unknown)).toBe(true)
    } finally {
      runtime.shutdown()
    }
  }, LONG)
})
