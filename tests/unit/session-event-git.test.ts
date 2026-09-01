import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { GitState, Session, Tab } from '@solus/contracts/types'

const previousState = (globalThis as unknown as { $state?: unknown }).$state
const branchWrites: unknown[][] = []

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    connectedServerIds: () => [],
    onConnectionCreated: () => () => {},
    onStatusChange: () => () => {},
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
      run: {
        gitContext: { repoRoot: '/repo', branch: 'main', targetBranch: 'main' },
        worktree: null,
      } as Session['run'],
    } as Session
    const tab = { id: 'tab-1', sessionId: 'session-1' } as Tab
    let pushedStatus: GitState | null | undefined
    const reducer = new SessionEventReducer({
      registry: {
        tabs: { 'tab-1': tab },
        sessions: { 'session-1': session },
        sessionFor: (tabId: string) => tabId === 'tab-1' ? session : undefined,
      tabIdsBySession: new Map([['session-1', ['tab-1']]]),
      },
      settings: { rateLimitBehavior: 'ask' },
      setGitStatus: (_cwd: string, status: GitState | null) => { pushedStatus = status },
      log: () => {},
    } as any)

    reducer.apply('session-1', {
      type: 'git_context',
      gitContext: { repoRoot: '/repo', branch: 'feature', targetBranch: 'main' },
    })
    const status: GitState = {
      repoRoot: '/repo',
      headSha: 'abc123',
      branch: 'feature',
      targetBranch: 'main',
      uncommittedChanges: { files: [], hasMoreFiles: false, insertions: 0, deletions: 0, mergeInProgress: false },
    }
    reducer.apply('session-1', { type: 'git_status', cwd: '/repo', state: status })

    expect(session.run.gitContext?.branch).toBe('feature')
    expect(pushedStatus).toBe(status)
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
      run: {
        serverId: 'run-host',
        taskServerId: 'task-host',
        gitContext: { repoRoot: '/repo', branch: 'main', targetBranch: 'main' },
        worktree: null,
      } as Session['run'],
    } as Session
    const tab = { id: 'tab-1', sessionId: 'session-1' } as Tab
    const reducer = new SessionEventReducer({
      registry: {
        tabs: { 'tab-1': tab },
        sessions: { 'session-1': session },
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
})
