import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Session } from '../../src/shared/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connectionCalls: string[] = []

mock.module('@client-core/server-connections', () => ({
  serverConnections: {
    ...singleHostServerConnections(),
    retain: (id: string) => connectionCalls.push(`retain:${id}`),
    unretain: (id: string) => connectionCalls.push(`unretain:${id}`),
    release: (id: string) => connectionCalls.push(`release:${id}`),
    ensure: (id: string) => connectionCalls.push(`ensure:${id}`),
  },
}))
const {
  moveTabToHost,
  worktreeBlockedReason,
} = await import('../../src/renderer/components/servers/run-on')
const { isDispatch, startsWorktree, withPendingHost } = await import('../../src/renderer/contexts/workspace/run-config')

function workspaceWith(run: Partial<Session['run']>) {
  const built = {
    run: { serverId: 'local', taskServerId: 'local', worktree: null, workingDirectory: '/home/dev/solus', ...run },
  } as Session
  return {
    workspace: {
      tabOrder: ['tab-1'],
      sessionFor: () => built,
      ctxFor: () => ({}) as never,
      apiFor: () => ({ unwatchSession: async () => {} }),
      refreshStartTarget: () => {},
    },
    session: built,
  }
}

beforeEach(() => {
  connectionCalls.length = 0
})

describe('choosing which host a tab will run on', () => {
  test('picker selection only records intent and does not connect or move the tab', () => {
    // WHY: host preparation belongs to Send. Merely inspecting or changing the
    // picker must not touch the network, filesystem, or conversation surface.
    const { session } = workspaceWith({ pendingHostDispatch: null })
    session.run = withPendingHost(session.run, {
      serverId: 'studio',
      intent: 'dispatch',
      repoKey: 'github.com/solus-sh/solus',
    })

    expect(session.run.serverId).toBe('local')
    expect(session.run.workingDirectory).toBe('/home/dev/solus')
    expect(session.statusCard).toBeUndefined()
    expect(session.run.pendingHostDispatch?.serverId).toBe('studio')
    expect(connectionCalls).toEqual([])
  })

  test('a move with no directory on the target is refused, not silently kept local', () => {
    // WHY: the session's directory is a path on the host it is leaving. Carrying
    // it across starts the agent in a directory that does not exist there — the
    // failure surfaces as a confusing agent error minutes later, not here.
    const { workspace, session } = workspaceWith({})
    const result = moveTabToHost({
      workspace,
      tabId: 'tab-1',
      serverId: 'studio',
      isLocalHost: false,
      intent: 'dispatch',
    })

    expect(result).toEqual({ ok: false, reason: 'no-path-on-host' })
    expect(session.run.serverId).toBe('local')
    expect(session.run.workingDirectory).toBe('/home/dev/solus')
    expect(connectionCalls).toEqual([])
  })

  test('a move that carries a directory lands on the new host', () => {
    const { workspace, session } = workspaceWith({
      gitContext: { branch: 'main', targetBranch: 'main', repoRoot: '/home/dev/solus' },
    })
    const result = moveTabToHost({
      workspace,
      tabId: 'tab-1',
      serverId: 'studio',
      isLocalHost: false,
      path: '/srv/projects/solus',
      repoKey: 'github.com/solus-sh/solus',
      intent: 'dispatch',
    })

    expect(result).toEqual({ ok: true })
    expect(session.run.serverId).toBe('studio')
    expect(session.run.workingDirectory).toBe('/srv/projects/solus')
    // WHY: paths are host-local. The logical project must keep the source
    // project's sidebar key or a remote clone appears as a second project.
    expect(session.run.projectGroupPath).toBe('/home/dev/solus')
  })

  test('dispatch leaves the task on this host; opening a project moves it', () => {
    // WHY: this is the whole difference between the two remote flows. A dispatch
    // hands another machine a clone, so the project — and every task it files —
    // stays here. Opening a folder on a host makes it that host's project
    // outright. `serverId !== taskServerId` is what later reads back as
    // "dispatched"; checkout shape remains an independent choice.
    const dispatched = workspaceWith({ worktree: { baseBranch: 'main' } })
    moveTabToHost({
      workspace: dispatched.workspace,
      tabId: 'tab-1',
      serverId: 'studio',
      isLocalHost: false,
      path: '/srv/projects/solus',
      intent: 'dispatch',
    })

    const openedThere = workspaceWith({})
    moveTabToHost({
      workspace: openedThere.workspace,
      tabId: 'tab-1',
      serverId: 'studio',
      isLocalHost: false,
      path: '/srv/projects/solus',
      intent: 'open-project',
    })

    expect(dispatched.session.run.serverId).toBe('studio')
    expect(dispatched.session.run.taskServerId).toBe('local')
    expect(isDispatch(dispatched.session.run)).toBe(true)
    expect(startsWorktree(dispatched.session.run)).toBe(true)

    expect(openedThere.session.run.serverId).toBe('studio')
    expect(openedThere.session.run.taskServerId).toBe('studio')
    expect(isDispatch(openedThere.session.run)).toBe(false)
    // WHY: a project that merely lives elsewhere is no different from a local
    // one, so worktree mode stays the user's choice rather than being forced.
    expect(startsWorktree(openedThere.session.run)).toBe(false)
  })

  test('the old host’s checkout does not travel to the new machine', () => {
    // WHY: gitContext describes a filesystem the session no longer runs on.
    // Kept, it would be re-read as truth — wrong branch, wrong worktree path.
    const { workspace, session } = workspaceWith({
      gitContext: { branch: 'main', targetBranch: 'main', repoRoot: '/home/dev/solus' },
      worktree: { baseBranch: 'main' },
    })
    moveTabToHost({
      workspace,
      tabId: 'tab-1',
      serverId: 'studio',
      isLocalHost: false,
      path: '/srv/projects/solus',
      intent: 'dispatch',
    })

    expect(session.run.gitContext).toBeNull()
    expect(session.run.worktree).toEqual({ baseBranch: null })
  })

  test('a materialized origin branch moves as an exact target worktree', () => {
    let refreshRequest: [string, string, boolean] | null = null
    const { workspace, session } = workspaceWith({
      gitContext: { branch: 'main', targetBranch: 'main', repoRoot: '/home/dev/solus' },
      worktree: { baseBranch: 'release' },
      pendingHostDispatch: {
        serverId: 'studio',
        intent: 'dispatch',
        repoKey: 'github.com/solus-sh/solus',
        baseBranch: 'release',
      },
    })
    workspace.refreshStartTarget = (tabId, path, createWorktree) => {
      refreshRequest = [tabId, path, createWorktree]
    }

    moveTabToHost({
      workspace,
      tabId: 'tab-1',
      serverId: 'studio',
      isLocalHost: false,
      path: '/srv/projects/solus/.solus-worktrees/release',
      intent: 'dispatch',
    })

    // WHY: host preparation has already materialized origin/release as the
    // release worktree. Session start must use it rather than branch again.
    expect(refreshRequest).toEqual([
      'tab-1',
      '/srv/projects/solus/.solus-worktrees/release',
      false,
    ])
    expect(session.run.worktree).toBeNull()
    expect(session.run.gitContext).toEqual({
      repoRoot: '/srv/projects/solus',
      branch: 'release',
      targetBranch: 'release',
      worktreePath: '/srv/projects/solus/.solus-worktrees/release',
    })
  })

  test('an existing remote worktree stays an exact worktree after the host move', () => {
    const selectedPath = '/srv/projects/solus/.solus-worktrees/release'
    let refreshRequest: [string, string, boolean] | null = null
    const { workspace, session } = workspaceWith({
      gitContext: { branch: 'main', targetBranch: 'main', repoRoot: '/home/dev/solus' },
      worktree: null,
      pendingHostDispatch: {
        serverId: 'studio',
        intent: 'dispatch',
        repoKey: 'github.com/solus-sh/solus',
        worktree: { path: selectedPath, branch: 'release' },
      },
    })
    workspace.refreshStartTarget = (tabId, path, createWorktree) => {
      refreshRequest = [tabId, path, createWorktree]
    }

    moveTabToHost({
      workspace,
      tabId: 'tab-1',
      serverId: 'studio',
      isLocalHost: false,
      path: selectedPath,
      intent: 'dispatch',
    })

    // WHY: reusing an existing worktree must not create another one, and the Git
    // environment must retain the selected target-host worktree path.
    expect(refreshRequest).toEqual(['tab-1', selectedPath, false])
    expect(session.run.workingDirectory).toBe(selectedPath)
    expect(session.run.gitContext?.worktreePath).toBe(selectedPath)
  })

  test('staying on the same host is not a dispatch', () => {
    // WHY: choosing the host you are already using must not force a worktree or
    // discard the checkout the session is sitting in.
    const { workspace, session } = workspaceWith({
      serverId: 'studio',
      gitContext: { branch: 'main', targetBranch: 'main', repoRoot: '/srv/projects/solus' },
    })
    const result = moveTabToHost({
      workspace,
      tabId: 'tab-1',
      serverId: 'studio',
      isLocalHost: false,
      intent: 'dispatch',
    })

    expect(result).toEqual({ ok: true })
    expect(session.run.gitContext).not.toBeNull()
  })

  test('the old host is released only after its last tab moves away', () => {
    // WHY: a shared host socket belongs to all tabs on it. Releasing it while a
    // sibling remains would sever that session when another tab changes hosts.
    const first = workspaceWith({})
    const second = { ...first.session, run: { ...first.session.run, serverId: 'local' } } as Session
    const workspace = {
      ...first.workspace,
      tabOrder: ['tab-1', 'tab-2'],
      sessionFor: (tabId: string) => tabId === 'tab-1' ? first.session : second,
    }

    moveTabToHost({
      workspace,
      tabId: 'tab-1',
      serverId: 'studio',
      isLocalHost: false,
      path: '/srv/projects/solus',
      intent: 'dispatch',
    })

    expect(connectionCalls).not.toContain('release:local')
    second.run.serverId = 'other'
    moveTabToHost({
      workspace,
      tabId: 'tab-1',
      serverId: 'local',
      isLocalHost: true,
      path: '/home/dev/solus',
      intent: 'dispatch',
    })

    expect(connectionCalls).toContain('release:studio')
  })
})

describe('worktree eligibility copy', () => {
  test('a checkout without a base branch is not mislabeled as non-Git', () => {
    expect(worktreeBlockedReason(false)).toBe(
      'This checkout has no base branch to create a worktree from.',
    )
  })

  test('an eligible checkout needs no blocked reason', () => {
    expect(worktreeBlockedReason(true)).toBeNull()
  })
})
