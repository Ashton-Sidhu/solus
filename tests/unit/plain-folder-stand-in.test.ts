import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { RunConfig, Session, StatusBarCtx, StatusCardState, Tab } from '@solus/contracts/types'
import { runInputFromContext } from '@solus/server/execution/agents/run-input'
import { IpcContextBuilder, type IpcContextBuilderDeps } from '@solus/workspace-ui/contexts/workspace/ipc-context'
import {
  checkoutGit,
  chooseStart,
  codebaseOf,
  folderLocation,
  projectHome,
  startsWorktree,
  workInStandIn,
  workingPlace,
} from '@solus/workspace-ui/contexts/workspace/run-location'

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    serverIds: () => [],
    onConnectionCreated: () => () => {},
    onReadinessChange: () => () => {},
    resolveId: (serverId: string) => serverId,
    apiFor: () => ({}),
  },
}))

const previousState = (globalThis as unknown as { $state?: unknown }).$state
afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

/**
 * A new worktree of a working folder that has no repository is a task folder
 * with links to the files of that folder (docs/plans/codebases.md §7). The
 * session has no checkout, so no `git_context` event moves its run: the
 * client moves it to the folder that stands in, and the project stays the
 * folder that a person knows.
 */

const MEMBER = '/code/shop'
const STAND_IN = '/data/solus-task-folders/fix-login-1a2b3c4d/shop'

describe('the run of a session that works in a stand-in folder', () => {
  const asked = chooseStart(folderLocation({ serverId: 'host', path: MEMBER }, { codebaseId: 'shop' }), { kind: 'new-worktree', baseBranch: 'main' })

  test('reads files and Git in the stand-in, and keeps the project and the codebase', () => {
    const settled = workInStandIn(asked, STAND_IN)
    expect(workingPlace({ location: settled })).toEqual({ serverId: 'host', path: STAND_IN })
    expect(projectHome({ location: settled })).toEqual({ serverId: 'host', path: MEMBER })
    expect(codebaseOf({ location: settled })).toBe('shop')
    expect(checkoutGit({ location: settled })).toBeNull()
  })

  // The task folder is the new worktree. A request that stays would show
  // "New worktree" for a session that is in one already.
  test('asks for no new worktree after the move', () => {
    expect(startsWorktree({ location: asked })).toBe(true)
    expect(startsWorktree({ location: workInStandIn(asked, STAND_IN) })).toBe(false)
  })

  // The host finds the task folder of a turn from the member that the turn
  // names as its project. A turn that named the stand-in as its project would
  // start a session with no codebase folder.
  test('the next turn still names the member as its project', () => {
    const run = {
      location: workInStandIn(asked, STAND_IN),
      permissionMode: 'full-access', provider: 'codex',
      modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
    } as unknown as RunConfig
    const deps = {
      sessionFor: () => undefined, runFor: () => run, hasDraft: () => false, defaultRunConfig: () => run,
      settings: { ctx: {} },
      statusBar: { ctx: {} as StatusBarCtx, ctxFor: () => ({}) as StatusBarCtx, ctxForRun: () => ({}) as StatusBarCtx },
    } as unknown as IpcContextBuilderDeps
    const context = new IpcContextBuilder(deps).forTab('tab-1')
    expect(context.session).toMatchObject({ workingDirectory: STAND_IN, projectPath: MEMBER, codebaseId: 'shop', gitContext: null, worktreeBaseBranch: null })
    expect(runInputFromContext(context, 'next prompt')).toMatchObject({ projectPath: MEMBER, codebaseId: 'shop' })
  })

  test('a clone that Send has not made is left alone', () => {
    const clone = { checkout: { kind: 'clone', serverId: 'other', repoKey: 'github.com/a/b', defaultBranch: 'main', start: { kind: 'default-branch' } }, project: { serverId: 'host', path: MEMBER }, codebaseId: 'shop' } as const
    expect(workInStandIn(clone, STAND_IN)).toBe(clone)
  })
})

describe('the end of a worktree setup', () => {
  function card(id: string, status: StatusCardState['status']): StatusCardState {
    return { id, title: 'Preparing worktree', status, steps: [] }
  }

  async function reducerFor(settled: string[]) {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { SessionEventReducer } = await import('@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte')
    const session = { status: 'running', sessionFolders: [], statusCard: null, run: { location: folderLocation({ serverId: 'host', path: MEMBER }) } } as unknown as Session
    const tab = { id: 'tab-1', sessionId: 'session-1' } as Tab
    return new SessionEventReducer({
      sessions: { byId: { 'session-1': session } },
      registry: { tabs: { 'tab-1': tab }, sessionFor: () => session, tabIdsBySession: new Map([['session-1', ['tab-1']]]) },
      settings: { rateLimitBehavior: 'ask' },
      setGitStatus: () => {},
      onWorktreeSetupDone: (sessionId: string) => { settled.push(sessionId) },
      log: () => {},
    } as never)
  }

  // A worktree of a repository names itself with `git_context`. A task folder
  // of a plain folder has no checkout to name, so the end of the setup is the
  // one moment the client can find where the session works.
  test('tells the workspace, so a run with no checkout finds its folder', async () => {
    const settled: string[] = []
    const reducer = await reducerFor(settled)
    reducer.apply('session-1', { type: 'status_card', card: card('worktree-1', 'active') })
    expect(settled).toEqual([])
    reducer.apply('session-1', { type: 'status_card', card: card('worktree-1', 'done') })
    expect(settled).toEqual(['session-1'])
  })

  test('a card that is not a worktree setup tells nothing', async () => {
    const settled: string[] = []
    const reducer = await reducerFor(settled)
    reducer.apply('session-1', { type: 'status_card', card: card('session-sync-1', 'done') })
    expect(settled).toEqual([])
  })
})
