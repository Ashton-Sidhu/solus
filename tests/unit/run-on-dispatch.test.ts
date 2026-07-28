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

const {
  queueSessionHostDispatch,
  retargetSessionHost,
  worktreeBlockedReason,
} = await import('../../src/renderer/components/servers/run-on')

function workspaceWith(session: Partial<Session>) {
  const built = { serverId: 'local', workingDirectory: '/home/dev/solus', ...session } as Session
  return {
    workspace: {
      tabOrder: ['tab-1'],
      sessionFor: () => built,
      ctxFor: () => ({}) as never,
      apiFor: () => ({ closeTab: async () => {} }),
      refreshStartTarget: () => {},
    },
    session: built,
  }
}

beforeEach(() => {
  connectionCalls.length = 0
})

describe('retargeting a session to another host', () => {
  test('picker selection only records intent and does not connect or move the session', () => {
    // WHY: host preparation belongs to Send. Merely inspecting or changing the
    // picker must not touch the network, filesystem, or conversation surface.
    const { session } = workspaceWith({ pendingHostDispatch: null })
    queueSessionHostDispatch(session, {
      serverId: 'studio',
      hostLabel: 'Studio',
      isLocalHost: false,
      repoKey: 'github.com/solus-sh/solus',
      checkout: null,
    })

    expect(session.serverId).toBe('local')
    expect(session.workingDirectory).toBe('/home/dev/solus')
    expect(session.statusCard).toBeUndefined()
    expect(session.pendingHostDispatch?.serverId).toBe('studio')
    expect(connectionCalls).toEqual([])
  })

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
    const { workspace, session } = workspaceWith({
      gitContext: { branch: 'main', targetBranch: 'main', repoRoot: '/home/dev/solus' },
    })
    const result = retargetSessionHost({
      workspace,
      tabId: 'tab-1',
      serverId: 'studio',
      isLocalHost: false,
      path: '/srv/projects/solus',
      repoKey: 'github.com/solus-sh/solus',
    })

    expect(result).toEqual({ ok: true })
    expect(session.serverId).toBe('studio')
    expect(session.workingDirectory).toBe('/srv/projects/solus')
    // WHY: paths are host-local. The logical project must keep the source
    // project's sidebar key or a remote clone appears as a second project.
    expect(session.projectGroupPath).toBe('/home/dev/solus')
    expect(session.worktreeRequired).toBe(false)
  })

  test('only an explicit Run on dispatch requires a remote worktree', () => {
    // WHY: opening a project that happens to live on a remote host should use
    // the normal worktree preference; only choosing a host for this session
    // makes isolation mandatory.
    const remoteProject = workspaceWith({})
    retargetSessionHost({
      workspace: remoteProject.workspace,
      tabId: 'tab-1',
      serverId: 'studio',
      isLocalHost: false,
      path: '/srv/projects/solus',
    })

    const dispatchedSession = workspaceWith({})
    retargetSessionHost({
      workspace: dispatchedSession.workspace,
      tabId: 'tab-1',
      serverId: 'studio',
      isLocalHost: false,
      path: '/srv/projects/solus',
      requireWorktree: true,
    })

    expect(remoteProject.session.worktreeRequired).toBe(false)
    expect(dispatchedSession.session.worktreeRequired).toBe(true)
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
    const result = retargetSessionHost({
      workspace,
      tabId: 'tab-1',
      serverId: 'studio',
      isLocalHost: false,
    })

    expect(result).toEqual({ ok: true })
    expect(session.gitContext).not.toBeNull()
  })

  test('the old host is released only after its last tab moves away', () => {
    // WHY: a shared host socket belongs to all tabs on it. Releasing it while a
    // sibling remains would sever that session when another tab changes hosts.
    const first = workspaceWith({})
    const second = { ...first.session, serverId: 'local' } as Session
    const workspace = {
      ...first.workspace,
      tabOrder: ['tab-1', 'tab-2'],
      sessionFor: (tabId: string) => tabId === 'tab-1' ? first.session : second,
    }

    retargetSessionHost({
      workspace,
      tabId: 'tab-1',
      serverId: 'studio',
      isLocalHost: false,
      path: '/srv/projects/solus',
    })

    expect(connectionCalls).not.toContain('release:local')
    second.serverId = 'other'
    retargetSessionHost({
      workspace,
      tabId: 'tab-1',
      serverId: 'local',
      isLocalHost: true,
      path: '/home/dev/solus',
    })

    expect(connectionCalls).toContain('release:studio')
  })
})

describe('worktree eligibility copy', () => {
  test('an existing worktree is identified as a worktree, not a non-Git folder', () => {
    // WHY: a disabled action must name the actual constraint. Calling an
    // existing checkout "not Git" sends the user toward the wrong fix.
    expect(worktreeBlockedReason(false, true)).toBe(
      'Already in a worktree — switch to the project root to branch another.',
    )
  })

  test('a checkout without a base branch is not mislabeled as non-Git', () => {
    expect(worktreeBlockedReason(false, false)).toBe(
      'This checkout has no base branch to create a worktree from.',
    )
  })

  test('an eligible checkout needs no blocked reason', () => {
    expect(worktreeBlockedReason(true, false)).toBeNull()
  })
})
