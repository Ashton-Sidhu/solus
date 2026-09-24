import { describe, expect, test } from 'bun:test'
import type { Session } from '@solus/contracts/types'
import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry'
import {
  isRunOnHostLocked,
  projectHostId,
  repoKeyForPath,
  returnsToProjectHome,
  shouldShowRunOnPicker,
  withCheckoutOnHost,
  withRemoteDispatch,
} from '@solus/workspace-ui/components/servers/run-on'
import type { RunConfig } from '@solus/contracts/types'
import { orderRunOnHosts, runOnHostAction } from '@solus/workspace-ui/components/servers/lib/run-on-hosts'
import { projectChipOptions } from '@solus/workspace-ui/components/input/lib/project-chip-options'
import { canRunOnHost, managedHostStateLabel } from '@solus/workspace-ui/components/servers/lib/managed-host'
import { hostRowLabel } from '@solus/workspace-ui/contexts/connections/host-label'
import { withDispatchBaseBranch, withDispatchWorktree } from '@solus/workspace-ui/contexts/workspace/run-config'

type VisibilityInput = Parameters<typeof shouldShowRunOnPicker>[0]

function visibility(overrides: Partial<VisibilityInput> = {}): VisibilityInput {
  return {
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
})

describe('managed hosts in the picker', () => {
  // WHY: docs/plans/managed-hosts.md — a managed host is "Cloud" and the name its
  // owner gave it, never its organization; while its compute is not ready it is
  // listed (the state is the information) but takes no work.
  const managed = { hostId: 'h', directoryUrl: 'https://app.example.test', kind: 'managed' as const }

  test('a ready managed host reads the name members gave it, never names an organization, and takes work', () => {
    expect(hostRowLabel({ label: 'Build box', uplink: { kind: 'managed' } }, '89451eb6d07536')).toBe('Build box')
    // The machine name is an identifier nobody chose: with only that, the row is "Cloud".
    expect(hostRowLabel({ label: '89451eb6d07536', uplink: { kind: 'managed' } }, '89451eb6d07536')).toBe('Cloud host')
    expect(hostRowLabel({ label: '', uplink: { kind: 'managed' } }, undefined)).toBe('Cloud host')
    expect(hostRowLabel({ label: 'Mac mini', uplink: { kind: 'personal' } }, 'Ashton’s Mac mini')).toBe('Ashton’s Mac mini')
    expect(hostRowLabel({ label: 'Studio', hasUserLabel: true, uplink: { kind: 'managed' } }, undefined)).toBe('Studio')
    expect(managedHostStateLabel({ ...managed, managedState: 'ready' })).toBeNull()
    expect(canRunOnHost({ ...managed, managedState: 'ready' })).toBe(true)
  })

  test('a managed host with no known state takes no work', () => {
    // WHY: the directory names a state for every managed host. A missing state
    // is one this client could not read, and sending work there could fail.
    expect(canRunOnHost(managed)).toBe(false)
    expect(managedHostStateLabel(managed)).toBeNull()
  })

  test('a managed host that is not ready shows its state and is disabled for dispatch', () => {
    for (const state of ['provisioning', 'starting', 'stopping', 'stopped', 'failed', 'deleting'] as const) {
      const label = `${state[0]!.toUpperCase()}${state.slice(1)}`
      expect(managedHostStateLabel({ ...managed, managedState: state })).toBe(label)
      expect(canRunOnHost({ ...managed, managedState: state })).toBe(false)
    }
  })

  test('a personal host is untouched: no managed line, always dispatchable', () => {
    expect(managedHostStateLabel({ hostId: 'h', directoryUrl: 'x', ownerName: 'Alice' })).toBeNull()
    expect(managedHostStateLabel(undefined)).toBeNull()
    expect(canRunOnHost(undefined)).toBe(true)
    expect(canRunOnHost({ hostId: 'h', directoryUrl: 'x', kind: 'personal' })).toBe(true)
  })
})

describe('run-on picker visibility', () => {
  test('one machine shows no picker, git checkout or not', () => {
    // WHY: the picker only chooses a machine. The checkout type moved to the
    // branch chip, so with nowhere else to run the chip is an empty gesture.
    expect(shouldShowRunOnPicker(visibility())).toBe(false)
  })

  test('a reachable remote reveals the picker', () => {
    expect(shouldShowRunOnPicker(visibility({ connectedRemoteCount: 1 }))).toBe(true)
  })

  test('a session already on a remote host shows the picker, even a forgotten one', () => {
    // WHY: the badge must never silently read as local. A run pointed at a
    // remote id names it whether or not that host is still in the saved list.
    expect(shouldShowRunOnPicker(visibility({ onRemoteHost: true }))).toBe(true)
    expect(shouldShowRunOnPicker(visibility({ selectedHostId: 'studio-forgotten' }))).toBe(true)
  })
})

describe('what each Run on row does for the project', () => {
  // WHY: one click on a host used to do one of four things chosen by state the
  // person could not see. Each row now says what it will do, and does it.
  const run = {
    serverId: 'local',
    taskServerId: 'local',
    projectGroupPath: null,
    workingDirectory: '/home/dev/solus',
    pendingHostDispatch: null,
  } as RunConfig
  const checkouts = [
    { serverId: 'studio', projectRoot: '/srv/solus' },
    { serverId: 'local', projectRoot: '/home/dev/solus' },
  ]
  const action = (hostId: string, overrides: { run?: RunConfig; cloneRepoKey?: string | null } = {}) =>
    runOnHostAction({
      hostId,
      selectedHostId: 'local',
      run: overrides.run ?? run,
      checkouts,
      cloneRepoKey: overrides.cloneRepoKey === undefined ? 'github.com/openai/solus' : overrides.cloneRepoKey,
    })

  test('the host the run is on is current', () => {
    expect(action('local')).toEqual({ kind: 'current' })
  })

  test('a host with a checkout of the project runs in it instead of cloning again', () => {
    expect(action('studio')).toEqual({ kind: 'checkout', path: '/srv/solus' })
  })

  test('a host without a checkout copies the repository', () => {
    expect(action('mini')).toEqual({ kind: 'clone' })
  })

  test('with no remote to copy, the person picks a folder on that host', () => {
    expect(action('mini', { cloneRepoKey: null })).toEqual({ kind: 'choose-folder' })
  })

  test('a dispatched run offers its home checkout, which the catalog does not list', () => {
    const dispatched = { ...run, serverId: 'mini', taskServerId: 'home', projectGroupPath: '/Users/me/solus' } as RunConfig
    expect(runOnHostAction({ hostId: 'home', selectedHostId: 'mini', run: dispatched, checkouts: [], cloneRepoKey: 'k' }))
      .toEqual({ kind: 'checkout', path: '/Users/me/solus' })
  })

  test('hosts list as current, then hosts with a checkout, then the rest', () => {
    const hosts = ['mini', 'studio', 'local']
    expect(orderRunOnHosts(hosts, (hostId) => action(hostId))).toEqual(['local', 'studio', 'mini'])
  })
})

describe('moving a run into an existing checkout', () => {
  const run = {
    serverId: 'local',
    taskServerId: 'local',
    projectGroupPath: '/home/dev/solus',
    workingDirectory: '/home/dev/solus',
    gitContext: null,
    worktree: null,
    pendingHostDispatch: { serverId: 'studio', intent: 'dispatch', repoKey: 'github.com/openai/solus' },
  } as RunConfig

  test('another host is recorded as intent, with the checkout to open there', () => {
    // WHY: nothing connects before Send. The checkout path is the host's own.
    const next = withCheckoutOnHost(run, 'studio', '/srv/solus', { immediate: false, isolate: false })
    expect(next.pendingHostDispatch).toEqual({ serverId: 'studio', intent: 'open-project' })
    expect(next.workingDirectory).toBe('/srv/solus')
    expect(next.serverId).toBe('local')
  })

  test('your own machine switches at once and drops a queued dispatch', () => {
    const next = withCheckoutOnHost({ ...run, serverId: 'studio' }, 'local', '/home/dev/solus', { immediate: true, isolate: false })
    expect(next.serverId).toBe('local')
    expect(next.pendingHostDispatch).toBeNull()
    expect(next.projectGroupPath).toBeNull()
    expect(next.workingDirectory).toBe('/home/dev/solus')
  })
})

describe('the project chip lists projects, not checkouts', () => {
  const project = (key: string, checkouts: { serverId: string; projectRoot: string }[]) => ({
    key,
    label: key.split('/').at(-1)!,
    cloudProject: null,
    checkouts: checkouts.map((checkout, index) => ({ ...checkout, label: 'solus', lastSeenAt: 10 - index })),
  })
  const online = (serverId: string) => serverId !== 'offline'
  const label = (serverId: string) => serverId.toUpperCase()

  test('one row for a repository with checkouts on several hosts, opened on the run host', () => {
    // WHY: the same repository on two machines is one project. The row opens
    // where the run already is, so choosing it never moves the run by surprise.
    const options = projectChipOptions(
      [project('github.com/openai/solus', [{ serverId: 'studio', projectRoot: '/srv/solus' }, { serverId: 'local', projectRoot: '/home/dev/solus' }])],
      'local', online, label,
    )
    expect(options).toEqual([{
      key: 'github.com/openai/solus',
      label: 'solus',
      checkout: { serverId: 'local', projectRoot: '/home/dev/solus' },
      hostLabel: null,
    }])
  })

  test('a project only another host holds opens there and names that host', () => {
    const [option] = projectChipOptions(
      [project('github.com/openai/solus', [{ serverId: 'offline', projectRoot: '/a' }, { serverId: 'studio', projectRoot: '/srv/solus' }])],
      'local', online, label,
    )
    expect(option!.checkout).toEqual({ serverId: 'studio', projectRoot: '/srv/solus' })
    expect(option!.hostLabel).toBe('STUDIO')
  })

  test('a project whose hosts are all offline stays listed with nothing to open', () => {
    const [option] = projectChipOptions([project('k', [{ serverId: 'offline', projectRoot: '/a' }])], 'local', online, label)
    expect(option!.checkout).toBeNull()
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
      path: '/srv/projects/solus/.git/solus/worktrees/release',
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
        path: '/srv/projects/solus/.git/solus/worktrees/release',
        branch: 'release',
      },
    })
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
      projectHostId(run({
        workingDirectory: '/Users/me/solus',
        pendingHostDispatch: { serverId: 'studio', intent: 'dispatch', repoKey: 'k' },
      })),
    ).toBe('local')
  })

  test('a dispatch with no checkout at home lists the host that will clone it', () => {
    // WHY: a repository opened from the cloud (onboarding's project, a cloud
    // task) starts at `~` and is cloned on the target. There is no home checkout
    // to keep offering, so listing the home machine shows unrelated projects
    // while Run on names the cloud host.
    expect(
      projectHostId(run({
        workingDirectory: '~',
        pendingHostDispatch: { serverId: 'cloud', intent: 'dispatch', repoKey: 'github.com/me/solus' },
      })),
    ).toBe('cloud')
  })

  test('opening a project elsewhere lists that host, before Send moves the ids', () => {
    // WHY: a checkout chosen on another host is pending until Send. The
    // pending target names that host while the run's own ids still read local.
    expect(
      projectHostId(run({ pendingHostDispatch: { serverId: 'studio', intent: 'open-project' } })),
    ).toBe('studio')
  })

  test('a project that already lives on a remote lists that remote', () => {
    expect(projectHostId(run({ serverId: 'studio', taskServerId: 'studio' }))).toBe('studio')
  })
})
