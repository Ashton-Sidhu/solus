import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { RunLocation, Session } from '@solus/contracts/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connectionCalls: string[] = []

mock.module('@solus/client-core/server-connections', () => ({
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
} = await import('@solus/workspace-ui/components/servers/run-on')
const {
  checkoutGit,
  checkoutPlace,
  chooseStart,
  dispatchTo,
  folderLocation,
  isDispatch,
  landClone,
  openFolder,
  pendingClone,
  projectHome,
  runHost,
  startsWorktree,
  worktreeBaseBranch,
  workingPlace,
} = await import('@solus/workspace-ui/contexts/workspace/run-location')

const HOME = { serverId: 'local', path: '/home/dev/solus' }
const MAIN = { branch: 'main', targetBranch: 'main', repoRoot: '/home/dev/solus' }

function workspaceWith(location: RunLocation = folderLocation(HOME)) {
  const built = {
    id: 'session-1',
    run: { location },
    task: { kind: 'existing', taskId: 'old-project-task' },
  } as Session
  const refreshRequests: [string, string, boolean][] = []
  return {
    workspace: {
      tabOrder: ['tab-1'],
      sessionFor: () => built,
      ctxFor: () => ({}) as never,
      apiFor: () => ({ unwatchSession: async () => {} }),
      refreshStartTarget: (tabId: string, path: string, createWorktree: boolean) => {
        refreshRequests.push([tabId, path, createWorktree])
      },
    },
    session: built,
    refreshRequests,
  }
}

beforeEach(() => {
  connectionCalls.length = 0
})

describe('choosing which host a tab will run on', () => {
  test('picker selection only records intent and does not connect or move the tab', () => {
    // WHY: host preparation belongs to Send. Merely inspecting or changing the
    // picker must not touch the network, filesystem, or conversation surface.
    const { session } = workspaceWith()
    session.run.location = dispatchTo(session.run.location, 'studio', 'github.com/solus-sh/solus')

    expect(pendingClone(session.run)?.serverId).toBe('studio')
    expect(checkoutPlace(session.run)).toEqual(HOME)
    expect(session.statusCard).toBeUndefined()
    expect(connectionCalls).toEqual([])
  })

  test('a dispatch with no folder on the target is a clone, not the old path on the new host', () => {
    // WHY: the session's directory is a path on the host it is leaving. Carrying
    // it across starts the agent in a directory that does not exist there — the
    // failure surfaces as a confusing agent error minutes later, not here. Until
    // Send lands the clone, every path the run names stays on the run's project home.
    const { session } = workspaceWith()
    session.run.location = dispatchTo(session.run.location, 'studio', 'github.com/solus-sh/solus')

    expect(runHost(session.run)).toBe('studio')
    expect(pendingClone(session.run)?.repoKey).toBe('github.com/solus-sh/solus')
    expect(workingPlace(session.run)).toEqual(HOME)
    expect(checkoutGit(session.run)).toBeNull()
  })

  test('a move that carries a directory lands on the new host', () => {
    const { workspace, session } = workspaceWith(folderLocation(HOME, { git: MAIN }))
    const result = moveTabToHost({
      workspace,
      tabId: 'tab-1',
      location: openFolder(session.run.location, { serverId: 'studio', path: '/srv/projects/solus' }, { keepProject: true }),
    })

    expect(result).toEqual({ ok: true })
    expect(runHost(session.run)).toBe('studio')
    expect(checkoutPlace(session.run).path).toBe('/srv/projects/solus')
    // WHY: paths are host-local. The logical project must keep the source
    // project's sidebar key or a remote clone appears as a second project.
    expect(projectHome(session.run)).toEqual(HOME)
  })

  test('a landed clone keeps the project home', () => {
    // WHY: the same rule for a clone Send made: the folder over there is the
    // checkout, while the project and its sidebar key stay home.
    const { session } = workspaceWith(folderLocation(HOME, { git: MAIN }))
    session.run.location = landClone(
      dispatchTo(session.run.location, 'studio', 'github.com/solus-sh/solus'),
      '/srv/projects/solus',
    )

    expect(runHost(session.run)).toBe('studio')
    expect(checkoutPlace(session.run).path).toBe('/srv/projects/solus')
    expect(projectHome(session.run)).toEqual(HOME)
    expect(isDispatch(session.run)).toBe(true)
  })

  test('dispatch leaves the project on this host; opening a project moves it', () => {
    // WHY: this is the whole difference between the two remote flows. A dispatch
    // hands another machine a checkout, so the project — and every task it
    // files — stays home. Opening a folder on a host makes it that host's
    // project outright, at once. A run host that differs from the project home
    // is what later reads back as "dispatched"; checkout shape remains an
    // independent choice.
    const dispatched = workspaceWith(folderLocation(HOME, { newWorktree: { baseBranch: 'main' } }))
    moveTabToHost({
      workspace: dispatched.workspace,
      tabId: 'tab-1',
      location: openFolder(dispatched.session.run.location, { serverId: 'studio', path: '/srv/projects/solus' }, { keepProject: true }),
    })

    const openedThere = workspaceWith()
    moveTabToHost({
      workspace: openedThere.workspace,
      tabId: 'tab-1',
      location: openFolder(openedThere.session.run.location, { serverId: 'studio', path: '/srv/projects/solus' }),
    })

    expect(runHost(dispatched.session.run)).toBe('studio')
    expect(projectHome(dispatched.session.run).serverId).toBe('local')
    expect(dispatched.session.task).toEqual({ kind: 'existing', taskId: 'old-project-task' })
    expect(isDispatch(dispatched.session.run)).toBe(true)
    expect(startsWorktree(dispatched.session.run)).toBe(true)

    expect(runHost(openedThere.session.run)).toBe('studio')
    expect(projectHome(openedThere.session.run)).toEqual({ serverId: 'studio', path: '/srv/projects/solus' })
    expect(isDispatch(openedThere.session.run)).toBe(false)
    // WHY: a project that merely lives elsewhere is no different from a local
    // one, so worktree mode stays the user's choice rather than being forced.
    expect(startsWorktree(openedThere.session.run)).toBe(false)
  })

  test('the old host’s checkout does not travel to the new machine', () => {
    // WHY: Git's answer describes a filesystem the session no longer runs on.
    // Kept, it would be re-read as truth — wrong branch, wrong worktree path.
    // The wish for a worktree survives; its base branch named the old folder's branch.
    const { workspace, session } = workspaceWith(folderLocation(HOME, { git: MAIN, newWorktree: { baseBranch: 'main' } }))
    moveTabToHost({
      workspace,
      tabId: 'tab-1',
      location: openFolder(session.run.location, { serverId: 'studio', path: '/srv/projects/solus' }, { keepProject: true }),
    })

    expect(checkoutGit(session.run)).toBeNull()
    expect(startsWorktree(session.run)).toBe(true)
    expect(worktreeBaseBranch(session.run)).toBeNull()
  })

  test('a materialized origin branch moves as an exact target worktree', () => {
    const releasePath = '/srv/projects/solus/.git/solus/worktrees/release'
    const { session } = workspaceWith(folderLocation(HOME, { git: MAIN, newWorktree: { baseBranch: 'release' } }))
    const clone = chooseStart(
      dispatchTo(session.run.location, 'studio', 'github.com/solus-sh/solus'),
      { kind: 'new-worktree', baseBranch: 'release' },
    )
    session.run.location = landClone(clone, releasePath)

    // WHY: host preparation has already materialized origin/release as the
    // release worktree. Session start must use it rather than branch again.
    expect(workingPlace(session.run)).toEqual({ serverId: 'studio', path: releasePath })
    expect(startsWorktree(session.run)).toBe(false)
    expect(checkoutGit(session.run)).toEqual({
      repoRoot: '/srv/projects/solus',
      branch: 'release',
      targetBranch: 'release',
      worktreePath: releasePath,
    })
  })

  test('an existing remote worktree stays an exact worktree after the host move', () => {
    const selectedPath = '/srv/projects/solus/.git/solus/worktrees/release'
    const { session } = workspaceWith(folderLocation(HOME, { git: MAIN }))
    const clone = chooseStart(
      dispatchTo(session.run.location, 'studio', 'github.com/solus-sh/solus'),
      { kind: 'worktree', path: selectedPath, branch: 'release' },
    )
    session.run.location = landClone(clone, selectedPath)

    // WHY: reusing an existing worktree must not create another one, and the Git
    // environment must retain the selected target-host worktree path.
    expect(workingPlace(session.run)).toEqual({ serverId: 'studio', path: selectedPath })
    expect(startsWorktree(session.run)).toBe(false)
    expect(checkoutPlace(session.run).path).toBe(selectedPath)
    expect(checkoutGit(session.run)?.worktreePath).toBe(selectedPath)
  })

  test('staying on the same host is not a dispatch', () => {
    // WHY: choosing the host you are already using must not force a worktree or
    // discard the checkout the session is sitting in.
    const { workspace, session, refreshRequests } = workspaceWith(
      folderLocation({ serverId: 'studio', path: '/srv/projects/solus' }, {
        git: { branch: 'main', targetBranch: 'main', repoRoot: '/srv/projects/solus' },
      }),
    )
    const result = moveTabToHost({ workspace, tabId: 'tab-1', location: session.run.location })

    expect(result).toEqual({ ok: true })
    expect(checkoutGit(session.run)).not.toBeNull()
    expect(isDispatch(session.run)).toBe(false)
    expect(startsWorktree(session.run)).toBe(false)
    expect(refreshRequests).toEqual([])
  })

  test('the old host is released only after its last tab moves away', () => {
    // WHY: a shared host socket belongs to all tabs on it. Releasing it while a
    // sibling remains would sever that session when another tab changes hosts.
    const first = workspaceWith()
    const second = { ...first.session, run: { location: folderLocation(HOME) } } as Session
    const workspace = {
      ...first.workspace,
      tabOrder: ['tab-1', 'tab-2'],
      sessionFor: (tabId: string) => tabId === 'tab-1' ? first.session : second,
    }

    moveTabToHost({
      workspace,
      tabId: 'tab-1',
      location: openFolder(first.session.run.location, { serverId: 'studio', path: '/srv/projects/solus' }, { keepProject: true }),
    })

    expect(connectionCalls).not.toContain('release:local')
    second.run.location = folderLocation({ serverId: 'other', path: '/home/dev/solus' })
    moveTabToHost({
      workspace,
      tabId: 'tab-1',
      location: openFolder(first.session.run.location, HOME, { keepProject: true }),
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
