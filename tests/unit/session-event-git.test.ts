import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { GitState, Session, Tab } from '@solus/contracts/types'
import type { SessionFolder } from '@solus/contracts/codebases'
import { checkoutGit, folderLocation, runHost } from '@solus/workspace-ui/contexts/workspace/run-location'

const previousState = (globalThis as unknown as { $state?: unknown }).$state
const branchWrites: unknown[][] = []

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    serverIds: () => [],
    onConnectionCreated: () => () => {},
    onReadinessChange: () => () => {},
    resolveId: (serverId: string) => serverId,
    apiFor: (serverId: string) => ({
      setSessionBranch: async (...args: unknown[]) => { branchWrites.push([serverId, ...args]) },
    }),
  },
}))

afterEach(() => {
  branchWrites.length = 0
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

describe('SessionEventReducer Git events', () => {
  test('applies environment changes while a session is interrupted', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { SessionEventReducer } = await import('@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte')
    const session = {
      status: 'interrupted',
      sessionFolders: [],
      run: {
        location: folderLocation(
          { serverId: 'local', path: '/repo' },
          { git: { repoRoot: '/repo', branch: 'main', targetBranch: 'main' } },
        ),
      } as Session['run'],
    } as Session
    const tab = { id: 'tab-1', sessionId: 'session-1' } as Tab
    let pushedStatus: GitState | null | undefined
    // The watcher's push names a path on the session's host; landing it under
    // the path alone let another host with that path read it.
    let pushedServerId: string | undefined
    const reducer = new SessionEventReducer({
      sessions: { byId: { 'session-1': session } },
      registry: {
        tabs: { 'tab-1': tab },
        sessionFor: (tabId: string) => tabId === 'tab-1' ? session : undefined,
      tabIdsBySession: new Map([['session-1', ['tab-1']]]),
      },
      settings: { rateLimitBehavior: 'ask' },
      setGitStatus: (serverId: string, _cwd: string, status: GitState | null) => { pushedServerId = serverId; pushedStatus = status },
      log: () => {},
    } as any)

    reducer.apply('session-1', {
      type: 'git_context',
      cwd: '/repo',
      gitContext: { repoRoot: '/repo', branch: 'feature', targetBranch: 'main' },
    })
    const status: GitState = {
      repoRoot: '/repo',
      headSha: 'abc123',
      branch: 'feature',
      targetBranch: 'main',
      uncommittedChanges: { files: [], hasMoreFiles: false, fileCount: 0, mergeInProgress: false },
    }
    reducer.apply('session-1', { type: 'git_status', cwd: '/repo', state: status })

    expect(checkoutGit(session.run)?.branch).toBe('feature')
    expect(pushedStatus).toBe(status)
    expect(pushedServerId).toBe(runHost(session.run))
  })

  test('writes a late dispatched worktree branch back to the task host', async () => {
    // WHY: remote worktree creation can finish after session_init. Without this
    // second write, refresh restores a branchless task attempt and cannot match
    // its pull request.
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { SessionEventReducer } = await import('@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte')
    const session = {
      id: 'session-1',
      agentSessionId: 'provider-session',
      status: 'idle',
      sessionFolders: [],
      run: {
        location: folderLocation(
          { serverId: 'run-host', path: '/repo' },
          { git: { repoRoot: '/repo', branch: 'main', targetBranch: 'main' }, project: { serverId: 'task-host', path: '/home/repo' } },
        ),
      } as Session['run'],
    } as Session
    const tab = { id: 'tab-1', sessionId: 'session-1' } as Tab
    const reducer = new SessionEventReducer({
      sessions: { byId: { 'session-1': session } },
      registry: {
        tabs: { 'tab-1': tab },
        sessionFor: (tabId: string) => tabId === 'tab-1' ? session : undefined,
        tabIdsBySession: new Map([['session-1', ['tab-1']]]),
      },
      settings: { rateLimitBehavior: 'ask' },
      tasksStore: {
        refreshSessionBinding: async () => null,
      },
      log: () => {},
    } as any)

    reducer.apply('session-1', {
      type: 'git_context',
      cwd: '/repo/.git/solus/worktrees/toast',
      gitContext: {
        repoRoot: '/repo',
        branch: 'solus/shadcn-toast-styling-hpzih',
        targetBranch: 'main',
        worktreePath: '/repo/.git/solus/worktrees/toast',
      },
    })
    await Promise.resolve()

    expect(branchWrites).toEqual([[
      'task-host',
      'session-1',
      'solus/shadcn-toast-styling-hpzih',
    ]])
  })

  test('the checkout of a session folder does not change where the run works', async () => {
    // WHY: docs/plans/codebases.md §6. A session gets a `git_context` for each
    // of its Git folders. The run location is the working place only: if the
    // checkout of a session folder replaced it, the tab would read files and
    // Git from a different repository, and the next prompt would start there.
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { SessionEventReducer } = await import('@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte')
    const { workingPlace } = await import('@solus/workspace-ui/contexts/workspace/run-location')
    const session = {
      id: 'session-1',
      agentSessionId: 'provider-session',
      status: 'running',
      sessionFolders: [],
      run: {
        location: folderLocation(
          { serverId: 'local', path: '/shop/api' },
          { git: { repoRoot: '/shop/api', branch: 'main', targetBranch: 'main' } },
        ),
      } as Session['run'],
    } as unknown as Session
    const tab = { id: 'tab-1', sessionId: 'session-1' } as Tab
    const reducer = new SessionEventReducer({
      sessions: { byId: { 'session-1': session } },
      registry: {
        tabs: { 'tab-1': tab },
        sessionFor: (tabId: string) => tabId === 'tab-1' ? session : undefined,
        tabIdsBySession: new Map([['session-1', ['tab-1']]]),
      },
      settings: { rateLimitBehavior: 'ask' },
      tasksStore: { refreshSessionBinding: async () => null },
      log: () => {},
    } as any)
    const folders: SessionFolder[] = [{ path: '/shop/web', name: 'web', state: 'git', repositoryPath: '/shop/web', source: 'codebase', granted: true }]

    reducer.apply('session-1', { type: 'session_folders', folders })
    reducer.apply('session-1', {
      type: 'git_context',
      cwd: '/shop/web',
      gitContext: { repoRoot: '/shop/web', branch: 'release', targetBranch: 'main', worktreePath: '/shop/web/.git/solus/worktrees/x' },
    })
    await Promise.resolve()

    expect(session.sessionFolders).toEqual(folders)
    expect(workingPlace(session.run)).toEqual({ serverId: 'local', path: '/shop/api' })
    expect(checkoutGit(session.run)?.branch).toBe('main')
    // The branch of a session folder is not the branch of the session.
    expect(branchWrites).toEqual([])

    // The working place still follows its own checkout: a worktree the host made moves the run.
    reducer.apply('session-1', {
      type: 'git_context',
      cwd: '/shop/api/.git/solus/worktrees/fix',
      gitContext: { repoRoot: '/shop/api', branch: 'solus/fix', targetBranch: 'main', worktreePath: '/shop/api/.git/solus/worktrees/fix' },
    })
    expect(workingPlace(session.run)).toEqual({ serverId: 'local', path: '/shop/api/.git/solus/worktrees/fix' })
    expect(checkoutGit(session.run)?.branch).toBe('solus/fix')
  })
})
