import { afterEach, describe, expect, test } from 'bun:test'
import type { GitState, Session, Tab } from '../../src/shared/types'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

describe('SessionEventReducer Git events', () => {
  test('applies environment changes while a session is interrupted', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { SessionEventReducer } = await import('../../src/renderer/contexts/workspace/session-event-reducer.svelte')
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
})
