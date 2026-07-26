import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Session } from '../../src/shared/types'

const connectionCalls: string[] = []

mock.module('@client-core/server-connections', () => ({
  serverConnections: {
    retain: (id: string) => connectionCalls.push(`retain:${id}`),
    unretain: (id: string) => connectionCalls.push(`unretain:${id}`),
    release: (id: string) => connectionCalls.push(`release:${id}`),
    ensure: (id: string) => connectionCalls.push(`ensure:${id}`),
  },
}))
mock.module('@client-core/run-on-preferences', () => ({ rememberRunOnHost: () => {} }))

const { retargetSessionHost } = await import('../../src/renderer/components/servers/run-on')

function workspaceWith(session: Partial<Session>) {
  const built = { serverId: 'local', workingDirectory: '/home/dev/solus', ...session } as Session
  return {
    workspace: {
      tabOrder: ['tab-1'],
      sessionFor: () => built,
      ctxFor: () => ({}) as never,
      apiFor: () => ({ closeTab: async () => {} }),
    },
    session: built,
  }
}

beforeEach(() => {
  connectionCalls.length = 0
})

describe('retargeting a session to another host', () => {
  test('a move with no directory on the target is refused, not silently kept local', () => {
    // WHY: the session's directory is a path on the host it is leaving. Carrying
    // it across starts the agent in a directory that does not exist there — the
    // failure surfaces as a confusing agent error minutes later, not here.
    const { workspace, session } = workspaceWith({})
    const result = retargetSessionHost({
      workspace,
      tabId: 'tab-1',
      serverId: 'studio',
      isLocalHost: false,
    })

    expect(result).toEqual({ ok: false, reason: 'no-path-on-host' })
    expect(session.serverId).toBe('local')
    expect(session.workingDirectory).toBe('/home/dev/solus')
    expect(connectionCalls).toEqual([])
  })

  test('a move that carries a directory lands on the new host', () => {
    const { workspace, session } = workspaceWith({})
    const dispatched: string[] = []
    const result = retargetSessionHost({
      workspace,
      tabId: 'tab-1',
      serverId: 'studio',
      isLocalHost: false,
      path: '/srv/projects/solus',
      onDispatched: (path) => dispatched.push(path),
    })

    expect(result).toEqual({ ok: true })
    expect(session.serverId).toBe('studio')
    expect(session.workingDirectory).toBe('/srv/projects/solus')
    expect(dispatched).toEqual(['/srv/projects/solus'])
  })

  test('the old host’s checkout does not travel with the session', () => {
    // WHY: gitContext describes a filesystem the session no longer runs on.
    // Kept, it would be re-read as truth — wrong branch, wrong worktree path.
    const { workspace, session } = workspaceWith({
      gitContext: { branch: 'main', targetBranch: 'main', repoRoot: '/home/dev/solus' },
      worktreeBaseBranch: 'main',
    })
    retargetSessionHost({
      workspace,
      tabId: 'tab-1',
      serverId: 'studio',
      isLocalHost: false,
      path: '/srv/projects/solus',
    })

    expect(session.gitContext).toBeNull()
    expect(session.worktreeBaseBranch).toBeNull()
  })

  test('staying on the same host is not a dispatch', () => {
    // WHY: choosing the host you are already using must not force a worktree or
    // discard the checkout the session is sitting in.
    const { workspace, session } = workspaceWith({
      serverId: 'studio',
      gitContext: { branch: 'main', targetBranch: 'main', repoRoot: '/srv/projects/solus' },
    })
    const dispatched: string[] = []
    const result = retargetSessionHost({
      workspace,
      tabId: 'tab-1',
      serverId: 'studio',
      isLocalHost: false,
      onDispatched: (path) => dispatched.push(path),
    })

    expect(result).toEqual({ ok: true })
    expect(dispatched).toEqual([])
    expect(session.gitContext).not.toBeNull()
  })
})
