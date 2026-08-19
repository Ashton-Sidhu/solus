import { describe, expect, test } from 'bun:test'
import type { Session } from '../../src/shared/types'
import { LOCAL_SERVER_ID } from '../../src/client-core/server-registry'
import {
  isRunOnHostLocked,
  isNewWorktreeStartSelected,
  projectHostId,
  repoKeyForPath,
  returnsToProjectHome,
  shouldShowRunOnPicker,
  withLocalStart,
  withRemoteDispatch,
} from '../../src/renderer/components/servers/run-on'
import type { RunConfig } from '../../src/shared/types'
import { runTarget } from '../../src/renderer/components/servers/lib/run-target'
import { withDispatchBaseBranch, withDispatchWorktree } from '../../src/renderer/contexts/workspace/run-config'

type VisibilityInput = Parameters<typeof shouldShowRunOnPicker>[0]

function visibility(overrides: Partial<VisibilityInput> = {}): VisibilityInput {
  return {
    variant: 'header',
    isGitRepo: false,
    connectedRemoteCount: 0,
    onRemoteHost: false,
    selectedHostId: LOCAL_SERVER_ID,
    ...overrides,
  }
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    agentSessionId: null,
    messages: [],
    status: 'idle',
    ...overrides,
  } as Session
}

describe('run-on host selection', () => {
  test('locks the host as soon as a session has started', () => {
    expect(isRunOnHostLocked(session())).toBe(false)
    expect(isRunOnHostLocked(session({ agentSessionId: 'session-1' }))).toBe(true)
    expect(isRunOnHostLocked(session({ messages: [{} as Session['messages'][number]] }))).toBe(true)
    expect(isRunOnHostLocked(session({ status: 'running' }))).toBe(true)
  })

  test('resolves the current path to its repository identity', () => {
    const identities = [{ path: '/work/solus', folderName: 'solus', repoKey: 'github.com/openai/solus' }]
    const repoKey = repoKeyForPath(identities, '/work/solus')

    expect(repoKey).toBe('github.com/openai/solus')
  })

  test('marks only the remote host when its default is a new worktree', () => {
    // WHY: host and checkout shape are shown in one menu. The remote host is the
    // selected destination, so its default worktree must not show a second check.
    expect(isNewWorktreeStartSelected(true, true)).toBe(false)
    expect(isNewWorktreeStartSelected(false, true)).toBe(true)
  })
})

describe('run-on picker visibility', () => {
  test('a git checkout always earns the header — it is the only worktree control', () => {
    // WHY: the header combines "where it runs" with "does it get a worktree".
    // A single-machine user with no remotes still needs the worktree choice, so
    // git alone is enough — this is the one case a bare host count would drop.
    expect(shouldShowRunOnPicker(visibility({ variant: 'header', isGitRepo: true }))).toBe(true)
  })

  test('a plain local folder with no reachable remote hides the picker', () => {
    // WHY: nothing to choose. No worktree to branch (not git) and nowhere else
    // to run (no connected remote), so the chip would be an empty gesture.
    expect(shouldShowRunOnPicker(visibility({ variant: 'header', isGitRepo: false }))).toBe(false)
    expect(shouldShowRunOnPicker(visibility({ variant: 'chip', isGitRepo: true }))).toBe(false)
  })

  test('a reachable remote reveals the picker even without a git repo', () => {
    // WHY: opening a plain folder on another machine is a first-class state —
    // the picker must name that machine and let the user pick it, git or not.
    expect(shouldShowRunOnPicker(visibility({ variant: 'header', connectedRemoteCount: 1 }))).toBe(true)
    expect(shouldShowRunOnPicker(visibility({ variant: 'chip', connectedRemoteCount: 1 }))).toBe(true)
  })

  test('a saved-but-offline remote does not count — only reachable ones do', () => {
    // WHY: the count is pre-filtered to connected hosts, so this asserts the
    // contract the picker relies on: an unreachable saved host is not a choice.
    expect(shouldShowRunOnPicker(visibility({ variant: 'chip', connectedRemoteCount: 0 }))).toBe(false)
  })

  test('a session already on a remote host shows the picker, even a forgotten one', () => {
    // WHY: the badge must never silently read as local. A run pointed at a
    // remote id names it whether or not that host is still in the saved list.
    expect(shouldShowRunOnPicker(visibility({ variant: 'chip', onRemoteHost: true }))).toBe(true)
    expect(
      shouldShowRunOnPicker(visibility({ variant: 'chip', onRemoteHost: false, selectedHostId: 'studio-forgotten' })),
    ).toBe(true)
  })
})

describe('returning a dispatched run to its project home', () => {
  function run(overrides: Partial<RunConfig> = {}): RunConfig {
    return {
      serverId: 'studio',
      taskServerId: 'local',
      projectGroupPath: '/home/dev/solus',
      workingDirectory: '/srv/projects/solus',
      ...overrides,
    } as RunConfig
  }

  test('picking the host the project lives on is a return home, not a dispatch', () => {
    // WHY: the whole bug. A dispatch runs on `studio` while the checkout stays
    // on `local`; choosing `local` again must re-home the run, never drill into
    // a "which project on local" chooser for a project that is already there.
    expect(returnsToProjectHome(run(), 'local')).toBe(true)
  })

  test('picking a different remote is a real move, not a return home', () => {
    // WHY: another host has no copy of the project, so selecting it is a genuine
    // dispatch/open — the home shortcut must not swallow it.
    expect(returnsToProjectHome(run(), 'other')).toBe(false)
  })

  test('a run already on its own home host has nowhere to return to', () => {
    // WHY: not a dispatch. `serverId === serverId` would otherwise read as a
    // spurious re-home of a run that never left.
    expect(returnsToProjectHome(run({ serverId: 'local' }), 'local')).toBe(false)
  })

  test('without a remembered home path there is no checkout to return to', () => {
    // WHY: the re-home points the run at `projectGroupPath`. With none — a
    // remote project never cloned from here — the picker must fall back to the
    // normal chooser rather than re-home onto nothing.
    expect(returnsToProjectHome(run({ projectGroupPath: null }), 'local')).toBe(false)
  })
})

describe('choosing a local checkout', () => {
  test('returning from another host applies Local on the first selection', () => {
    // WHY: moving hosts and disabling worktree mode are one picker action. If the
    // host move returns early, the retained preference selects New worktree and
    // makes the user choose Local a second time.
    const next = withLocalStart(
      {
        serverId: 'studio',
        taskServerId: 'studio',
        projectGroupPath: '/home/dev/solus',
        workingDirectory: '/srv/projects/solus',
        gitContext: null,
        worktree: { baseBranch: null },
        pendingHostDispatch: null,
      } as RunConfig,
      'local',
      '/home/dev/fallback',
      false,
    )

    expect(next.serverId).toBe('local')
    expect(next.taskServerId).toBe('local')
    expect(next.workingDirectory).toBe('/home/dev/solus')
    expect(next.worktree).toBeNull()
    expect(next.projectGroupPath).toBeNull()
  })

  test('staying local clears a queued host and applies the checkout shape together', () => {
    // WHY: two onRun calls built from the stale prop can restore either half of
    // the old selection. The picker must emit one complete next run instead.
    const next = withLocalStart(
      {
        serverId: 'local',
        taskServerId: 'local',
        projectGroupPath: null,
        workingDirectory: '/home/dev/solus',
        gitContext: { repoRoot: '/home/dev/solus', branch: 'main', targetBranch: 'main' },
        worktree: { baseBranch: 'main' },
        pendingHostDispatch: { serverId: 'studio', intent: 'dispatch', repoKey: 'github.com/openai/solus' },
      } as RunConfig,
      'local',
      '/home/dev/fallback',
      false,
    )

    expect(next.pendingHostDispatch).toBeNull()
    expect(next.worktree).toBeNull()
  })
})

describe('choosing a remote host', () => {
  test('selects a fresh worktree with the pending dispatch', () => {
    // WHY: a remote dispatch runs in an unattended clone. The host choice must
    // select isolation at the same time instead of leaving the local checkout
    // selected until Send changes hosts.
    const next = withRemoteDispatch(
      {
        serverId: 'local',
        taskServerId: 'local',
        workingDirectory: '/home/dev/solus',
        gitContext: { repoRoot: '/home/dev/solus', branch: 'main', targetBranch: 'main' },
        worktree: null,
        pendingHostDispatch: null,
      } as RunConfig,
      { serverId: 'studio', intent: 'dispatch', repoKey: 'github.com/openai/solus' },
    )

    expect(next.pendingHostDispatch).toEqual({
      serverId: 'studio',
      intent: 'dispatch',
      repoKey: 'github.com/openai/solus',
    })
    expect(next.worktree).toEqual({ baseBranch: 'main' })

    const target = runTarget({
      run: next,
      hostLabel: 'Studio',
      taskHostLabel: 'Local',
      stayLabel: 'Local',
      hostIsLocal: false,
      canBranchWorktree: true,
    })
    expect(target.kind).toBe('dispatched')
    expect(target.startsWorktree).toBeTrue()
    expect(target.worktreeForced).toBeTrue()
  })

  test('records an exact remote worktree without changing the local checkout', () => {
    const run = {
      serverId: 'local',
      taskServerId: 'local',
      workingDirectory: '/home/dev/solus',
      gitContext: { repoRoot: '/home/dev/solus', branch: 'main', targetBranch: 'main' },
      worktree: { baseBranch: 'main' },
      pendingHostDispatch: {
        serverId: 'studio',
        intent: 'dispatch',
        repoKey: 'github.com/openai/solus',
      },
    } as RunConfig

    const next = withDispatchWorktree(run, {
      path: '/srv/projects/solus/.solus-worktrees/release',
      branch: 'release',
    })

    // WHY: a target worktree path belongs to the target host. The source
    // checkout must not move before the dispatch is sent.
    expect(next.gitContext).toEqual(run.gitContext)
    expect(next.workingDirectory).toBe(run.workingDirectory)
    expect(next.worktree).toBeNull()
    expect(next.pendingHostDispatch).toEqual({
      serverId: 'studio',
      intent: 'dispatch',
      repoKey: 'github.com/openai/solus',
      worktree: {
        path: '/srv/projects/solus/.solus-worktrees/release',
        branch: 'release',
      },
    })
    const target = runTarget({
      run: next,
      hostLabel: 'Studio',
      taskHostLabel: 'Local',
      stayLabel: 'Local',
      hostIsLocal: false,
      canBranchWorktree: true,
    })
    expect(target.startsWorktree).toBeFalse()
    expect(target.worktreeForced).toBeFalse()

    expect(withDispatchWorktree(next, null).worktree).toEqual({ baseBranch: null })
  })

  test('records an origin branch as a new target worktree without switching locally', () => {
    const run = {
      serverId: 'local',
      taskServerId: 'local',
      workingDirectory: '/home/dev/solus',
      gitContext: { repoRoot: '/home/dev/solus', branch: 'main', targetBranch: 'main' },
      worktree: { baseBranch: null },
      pendingHostDispatch: {
        serverId: 'studio',
        intent: 'dispatch',
        repoKey: 'github.com/openai/solus',
      },
    } as RunConfig

    const next = withDispatchBaseBranch(run, 'release')

    // WHY: an origin branch is only the start point for an isolated target-host
    // worktree. The source checkout must remain on its current branch.
    expect(next.gitContext).toEqual(run.gitContext)
    expect(next.workingDirectory).toBe(run.workingDirectory)
    expect(next.worktree).toEqual({ baseBranch: 'release' })
    expect(next.pendingHostDispatch).toEqual({
      serverId: 'studio',
      intent: 'dispatch',
      repoKey: 'github.com/openai/solus',
      baseBranch: 'release',
    })
  })
})

describe('which host the project chip lists', () => {
  function run(overrides: Partial<RunConfig> = {}): RunConfig {
    return { serverId: 'local', taskServerId: 'local', pendingHostDispatch: null, ...overrides } as RunConfig
  }

  test('a plain local run lists its own machine', () => {
    expect(projectHostId(run())).toBe('local')
  })

  test('a dispatch lists the project’s home, not where the agent runs', () => {
    // WHY: a dispatch runs on `studio` but the project (and the checkout the chip
    // offers) stays on `taskServerId`. Listing studio's projects would offer
    // folders that have nothing to do with the work being dispatched.
    expect(
      projectHostId(run({ pendingHostDispatch: { serverId: 'studio', intent: 'dispatch', repoKey: 'k' } })),
    ).toBe('local')
  })

  test('opening a project elsewhere lists that host, before Send moves the ids', () => {
    // WHY: the whole point of the new flow — pick the host in the run-on picker,
    // then pick the project on it. The pending target names that host while the
    // run's own ids still read local.
    expect(
      projectHostId(run({ pendingHostDispatch: { serverId: 'studio', intent: 'open-project' } })),
    ).toBe('studio')
  })

  test('a project that already lives on a remote lists that remote', () => {
    expect(projectHostId(run({ serverId: 'studio', taskServerId: 'studio' }))).toBe('studio')
  })
})
