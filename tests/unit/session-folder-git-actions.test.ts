import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import type { GitActionResult, GitState, IpcContext, RunConfig, Session } from '@solus/contracts/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const progress = { update() {}, success() {}, info() {}, error() {}, dismiss() {} }
mock.module('@solus/workspace-ui/lib/toasts', () => ({
  toasts: { progress: () => progress, error: () => {}, info: () => {}, success: () => {}, warning: () => {} },
}))
mock.module('@solus/workspace-ui/lib/inputFocus', () => ({
  FOCUS_INPUT_EVENT: 'solus:focus-input',
  requestInputFocus: () => {},
  blurActiveTextInputOnMobile: () => {},
}))
const connections = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))

const testGlobal = globalThis as unknown as { $state?: unknown }
const previousState = testGlobal.$state

beforeAll(() => {
  testGlobal.$state = Object.assign(<T>(value: T): T => value, { snapshot: <T>(value: T): T => value })
})

afterAll(() => {
  if (previousState === undefined) delete testGlobal.$state
  else testGlobal.$state = previousState
})

/**
 * A Git action in a session folder (docs/plans/codebases.md §8). The host
 * takes the checkout from the context of the call: the session's id, the
 * folder's path as the working directory, and the folder's own checkout. The
 * session stays in its working directory, so no answer for a folder may reach
 * the run of the tab.
 */

const TASK_FOLDER = '/data/solus-task-folders/fix-login-1a2b3c4d'
const WORKING = { repoRoot: '/code/shop/web', branch: 'main', targetBranch: 'main' }

function gitState(repoRoot: string, branch: string): GitState {
  return {
    repoRoot, headSha: `head-${branch}`, branch, targetBranch: 'main', upstreamRef: null, aheadCount: 0, behindCount: 0,
    uncommittedChanges: { files: [], hasMoreFiles: false, fileCount: 0, mergeInProgress: false },
  }
}

async function workspaceWith(folders: Session['sessionFolders']) {
  const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
  const { IpcContextBuilder } = await import('@solus/workspace-ui/contexts/workspace/ipc-context')
  const { folderLocation } = await import('@solus/workspace-ui/contexts/workspace/run-location')
  const run = {
    location: folderLocation({ serverId: 'local', path: '/code/shop/web' }, { git: WORKING, codebaseId: 'shop' }),
    permissionMode: 'full-access', provider: 'codex',
    modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
  } as unknown as RunConfig
  const session = { id: 'session-1', agentSessionId: 'thread-1', status: 'idle', sessionFolders: folders, run } as unknown as Session
  const builder = new IpcContextBuilder({
    sessionFor: () => session, runFor: () => run, hasDraft: () => false, defaultRunConfig: () => run,
    settings: { ctx: {} }, statusBar: { ctx: {}, ctxFor: () => ({}), ctxForRun: () => ({}) },
  } as never)
  const store = new SessionEnvironmentStore()
  const landed: unknown[] = []
  const workspace = {
    activeTabId: 'tab-1', tabOrder: ['tab-1'], defaultRunConfig: run,
    runFor: () => run,
    moveRun: (_sourceId: string, next: unknown) => { landed.push(next) },
    sessionFor: () => session,
    ctxFor: () => builder.forTab('tab-1'),
    ctxForEnvironment: (cwd: string, checkout: IpcContext['session']['gitContext'], tabId: string) => builder.forEnvironment(tabId, cwd, checkout),
    serverIdFor: () => 'local',
    apiFor: () => asHostApi(window.solus),
  }
  store.bindWorkspace(workspace)
  return { store, workspace, run, landed }
}

describe('the environment of a session folder', () => {
  test('is read by its own path, with its own branch', async () => {
    const { store, run } = await workspaceWith([])
    store.set('local', '/code/shop/api', gitState('/code/shop/api', 'api-fix'))
    const environment = store.environmentIn(run, { path: '/code/shop/api', repositoryPath: '/code/shop/api' })
    expect(environment).toMatchObject({ cwd: '/code/shop/api', branch: 'api-fix', repoRoot: '/code/shop/api', isolated: false, pending: false })
    // The run of the tab is a different place.
    expect(store.environmentIn(run, null).cwd).toBe('/code/shop/web')
  })

  // The path of a worktree in a task folder does not name its repository.
  test('a worktree in a task folder names its repository', async () => {
    const { store, run } = await workspaceWith([])
    const worktree = `${TASK_FOLDER}/shop/api`
    store.set('local', worktree, gitState('/code/shop/api', 'fix-login'))
    const environment = store.environmentIn(run, { path: worktree, repositoryPath: '/code/shop/api' })
    expect(environment.checkout).toMatchObject({ branch: 'fix-login', repoRoot: '/code/shop/api', worktreePath: worktree })
    expect(environment.isolated).toBe(true)
  })
})

describe('a Git action for the row of a session folder', () => {
  const worktree = `${TASK_FOLDER}/shop/api`
  const folder = { path: worktree, name: 'api', state: 'git' as const, repositoryPath: '/code/shop/api', source: 'codebase' as const, granted: true }

  test("sends the folder's path, the folder's checkout, and the session's id", async () => {
    const { store, workspace } = await workspaceWith([folder])
    store.set('local', worktree, gitState('/code/shop/api', 'fix-login'))
    const sent: IpcContext[] = []
    const result = { commit: { status: 'created', subject: 'Change' }, push: { status: 'skipped' }, pullRequest: { status: 'skipped' } } as GitActionResult
    ;(globalThis as unknown as { window: { solus: object } }).window = {
      solus: {
        gitRunAction: async (ctx: IpcContext) => { sent.push(ctx); return result },
        gitRefreshState: async () => gitState('/code/shop/api', 'fix-login'),
        checkoutSnapshot: async () => ({ generation: 'test-host', revision: 0, states: [] }),
      },
    }
    const { GitActions } = await import('@solus/workspace-ui/lib/git-actions.svelte')
    const actions = new GitActions(workspace as never, 'tab-1', store, { get: () => ({ prForCheckout: () => null, absorbCreated: () => {} }) } as never, folder)
    await actions.run('commit')

    expect(sent).toHaveLength(1)
    expect(sent[0]!.session).toMatchObject({
      sessionId: 'session-1',
      workingDirectory: worktree,
      // A place in a task folder does not name its project: the checkout does.
      projectPath: '/code/shop/api',
      gitContext: { branch: 'fix-login', repoRoot: '/code/shop/api', worktreePath: worktree },
    })
  })

  // The host does not bind the session to the folder. The client must agree:
  // a read for a folder goes to the status cache, and the run stays.
  test('a read of the folder after the action never moves the run of the tab', async () => {
    const { store, workspace, landed } = await workspaceWith([folder])
    let registered = 0
    ;(globalThis as unknown as { window: { solus: object } }).window = {
      solus: {
        gitRefreshState: async () => gitState('/code/shop/api', 'after-commit'),
        gitRegisterEnvironment: async () => { registered++ },
        checkoutSnapshot: async () => ({ generation: 'test-host', revision: 0, states: [] }),
      },
    }
    const outcome = await store.refreshEnvironment(workspace, { sourceId: 'tab-1', cwd: worktree, level: 'details' })
    expect(outcome.ok).toBe(true)
    expect(store.statusFor('local', worktree)?.branch).toBe('after-commit')
    expect(landed).toEqual([])
    expect(registered).toBe(0)
  })

  test('a branch change in a folder goes to the host with the context of the folder', async () => {
    const { checkoutFolderBranch } = await import('@solus/workspace-ui/components/project-panel/lib/repository-actions')
    const { store, workspace, run } = await workspaceWith([{ ...folder, path: '/code/shop/api' }])
    store.set('local', '/code/shop/api', gitState('/code/shop/api', 'main'))
    const environment = store.environmentIn(run, { path: '/code/shop/api', repositoryPath: '/code/shop/api' })
    const calls: [IpcContext, string][] = []
    const api = { gitCheckoutBranch: async (ctx: IpcContext, branch: string) => { calls.push([ctx, branch]); return { success: false, error: 'The branch has uncommitted changes.' } } }
    const failure = await checkoutFolderBranch(api, workspace.ctxForEnvironment('/code/shop/api', environment.checkout, 'tab-1'), 'release')
    expect(failure).toBe('The branch has uncommitted changes.')
    expect(calls[0]![1]).toBe('release')
    expect(calls[0]![0].session).toMatchObject({ sessionId: 'session-1', workingDirectory: '/code/shop/api', gitContext: { branch: 'main' } })
  })
})
