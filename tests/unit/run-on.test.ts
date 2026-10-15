import { describe, expect, test } from 'bun:test'
import type { Session } from '@solus/contracts/types'
import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry'
import {
  isRunOnHostLocked,
  repoKeyForPath,
  shouldShowRunOnPicker,
} from '@solus/workspace-ui/components/servers/run-on'
import type { RunConfig, RunLocation } from '@solus/contracts/types'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import { listRunOnHosts, runHasProject, runOnHostAction } from '@solus/workspace-ui/components/servers/lib/run-on-hosts'
import { projectChipOptions } from '@solus/workspace-ui/components/input/lib/project-chip-options'
import { canRunOnHost, managedHostStateLabel } from '@solus/workspace-ui/components/servers/lib/managed-host'
import { hostRowLabel } from '@solus/workspace-ui/contexts/connections/host-label'
import {
  checkoutPlace,
  chooseStart,
  cloneBaseBranch,
  dispatchTo,
  folderLocation,
  isDispatch,
  openFolder,
  pendingClone,
  projectHome,
  projectRoot,
  runHost,
  startsWorktree,
  worktreeBaseBranch,
} from '@solus/workspace-ui/contexts/workspace/run-location'

const located = (location: RunLocation) => ({ location }) as RunConfig

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
  const run = located(folderLocation({ serverId: 'local', path: '/home/dev/solus' }))
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
    const dispatched = located(folderLocation(
      { serverId: 'mini', path: '/srv/projects/solus' },
      { project: { serverId: 'home', path: '/Users/me/solus' } },
    ))
    expect(runOnHostAction({ hostId: 'home', selectedHostId: 'mini', run: dispatched, checkouts: [], cloneRepoKey: 'k' }))
      .toEqual({ kind: 'checkout', path: '/Users/me/solus' })
  })

  test('hosts list as current, then hosts with a checkout, then the rest', () => {
    const hosts = ['mini', 'studio', 'local']
    expect(listRunOnHosts(hosts, (hostId) => action(hostId), true)).toEqual(['local', 'studio', 'mini'])
  })

  test('a chosen project lists only hosts that hold it or can copy it', () => {
    // WHY: a host that would need a folder picked cannot run this project, so
    // offering it beside the project invites a choice that leads nowhere.
    const hosts = ['mini', 'studio', 'local']
    expect(listRunOnHosts(hosts, (hostId) => action(hostId, { cloneRepoKey: null }), true)).toEqual(['local', 'studio'])
  })

  test('with no project chosen, every host is listed', () => {
    // WHY: the host is chosen first, and the project chip then picks a folder there.
    const hosts = ['mini', 'studio', 'local']
    expect(listRunOnHosts(hosts, (hostId) => action(hostId, { cloneRepoKey: null }), false)).toEqual(['local', 'studio', 'mini'])
  })

  test('a folder on the workspace service is no project, so it hides no host', () => {
    // WHY: the workspace service runs no sessions and holds no folder. A draft saved
    // before its host was replaced can still name one; counting it as a project hid
    // every host, and the picker offered only "Add a host".
    expect(runHasProject('/data/home/solus', false)).toBe(false)
    expect(runHasProject('/home/dev/solus', true)).toBe(true)
    expect(runHasProject('~', true)).toBe(false)
  })

  test('a chat is no project: every host can run it, in a new chat there', () => {
    // WHY: a chat has no checkout to find or copy. Asking for a folder, or hiding
    // hosts, would turn a plain chat back into a project choice.
    const chat = located(folderLocation({ serverId: 'local', path: '/home/dev/projects/.solus-chats/abc' }))
    expect(runHasProject(checkoutPlace(chat).path, true)).toBe(false)
    expect(runHasProject(NEW_CHAT_DIRECTORY, true)).toBe(false)
    expect(action('studio', { run: chat })).toEqual({ kind: 'chat' })
    expect(action('local', { run: chat })).toEqual({ kind: 'current' })
  })
})

describe('moving a run into an existing checkout', () => {
  const home = folderLocation({ serverId: 'local', path: '/home/dev/solus' })
  const queuedClone = dispatchTo(home, 'studio', 'github.com/openai/solus')

  test('another host takes the run at once, into the checkout there', () => {
    // WHY: the folder exists on that host, so the path and its host are written
    // together; nothing waits for Send except connecting. The checkout path is
    // the host's own, and the folder becomes the project, so no clone is queued.
    const next = located(openFolder(queuedClone, { serverId: 'studio', path: '/srv/solus' }))
    expect(runHost(next)).toBe('studio')
    expect(checkoutPlace(next)).toEqual({ serverId: 'studio', path: '/srv/solus' })
    expect(projectHome(next)).toEqual({ serverId: 'studio', path: '/srv/solus' })
    expect(pendingClone(next)).toBeNull()
  })

  test('your own machine switches at once and drops a queued clone', () => {
    const next = located(openFolder(queuedClone, { serverId: 'local', path: '/home/dev/solus' }))
    expect(runHost(next)).toBe('local')
    expect(pendingClone(next)).toBeNull()
    expect(isDispatch(next)).toBe(false)
    expect(checkoutPlace(next).path).toBe('/home/dev/solus')
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

  test('a project whose hosts are all offline is not listed', () => {
    // WHY: the web client remembers every host it has reached. A laptop that is
    // asleep must not fill a cloud workspace's project list with rows that
    // cannot open.
    const options = projectChipOptions(
      [project('k', [{ serverId: 'offline', projectRoot: '/a' }]), project('j', [{ serverId: 'local', projectRoot: '/b' }])],
      'local', online, label,
    )
    expect(options.map((option) => option.key)).toEqual(['j'])
  })

  test('a project is named by its plain name, never by its owner or host', () => {
    // WHY: the chip names projects as the Tasks, Pull requests, Automations and
    // Works pages do; the host shows apart from the name, in hostLabel.
    const options = projectChipOptions(
      [
        project('github.com/acme/web', [{ serverId: 'local', projectRoot: '/acme/web' }]),
        project('github.com/other/web', [{ serverId: 'local', projectRoot: '/other/web' }]),
        project('local:/scratch/web', [{ serverId: 'local', projectRoot: '/scratch/web' }]),
      ],
      'local', online, label,
    )
    expect(options.map((option) => option.label)).toEqual(['web', 'web', 'web'])
  })

  test('the folder the composer is in leads the list', () => {
    const options = projectChipOptions(
      [project('github.com/acme/web', [{ serverId: 'local', projectRoot: '/acme/web' }])],
      'local', online, label,
      { key: 'studio:/srv/web', label: 'web', checkout: { serverId: 'studio', projectRoot: '/srv/web' }, hostLabel: null },
    )
    expect(options.map((option) => [option.key, option.label])).toEqual([
      ['studio:/srv/web', 'web'],
      ['github.com/acme/web', 'web'],
    ])
  })
})

describe('returning a dispatched run to its project home', () => {
  const dispatched = (project: { serverId: string; path: string } = { serverId: 'local', path: '/home/dev/solus' }) =>
    located(folderLocation({ serverId: 'studio', path: '/srv/projects/solus' }, { project }))
  const action = (run: RunConfig, hostId: string) =>
    runOnHostAction({ hostId, selectedHostId: runHost(run), run, checkouts: [], cloneRepoKey: 'github.com/openai/solus' })

  test('picking the host the project lives on is a return home, not a dispatch', () => {
    // WHY: the whole bug. A dispatch runs on `studio` while the project home
    // stays on `local`; choosing `local` again must re-home the run into its
    // checkout, never drill into a "which project on local" chooser, and never
    // copy a repository that is already there.
    const run = dispatched()
    expect(action(run, 'local')).toEqual({ kind: 'checkout', path: '/home/dev/solus' })
    const back = located(openFolder(run.location, { serverId: 'local', path: '/home/dev/solus' }))
    expect(runHost(back)).toBe('local')
    expect(isDispatch(back)).toBe(false)
  })

  test('picking a different remote is a real move, not a return home', () => {
    // WHY: another host has no copy of the project, so selecting it is a genuine
    // clone — the home shortcut must not swallow it.
    expect(action(dispatched(), 'other')).toEqual({ kind: 'clone' })
  })

  test('a run already on its own home host has nowhere to return to', () => {
    // WHY: not a dispatch. The run host is the current row, never a spurious
    // re-home of a run that never left.
    const run = located(folderLocation({ serverId: 'local', path: '/home/dev/solus' }))
    expect(action(run, 'local')).toEqual({ kind: 'current' })
  })

  test('without a remembered home path there is no checkout to return to', () => {
    // WHY: the re-home opens the project home's folder. With none — a remote
    // project never cloned from here — the row must fall back to a clone rather
    // than re-home onto nothing.
    expect(action(dispatched({ serverId: 'local', path: '~' }), 'local')).toEqual({ kind: 'clone' })
  })
})

describe('choosing a remote host', () => {
  const checkout = folderLocation(
    { serverId: 'local', path: '/home/dev/solus' },
    { git: { repoRoot: '/home/dev/solus', branch: 'main', targetBranch: 'main' } },
  )

  test('puts a checkout run on the default branch, not in a new worktree', () => {
    // WHY: choosing a cloud host is a choice of where to run, not of
    // isolation. The target host's clone may hold any branch, so the run
    // names the default branch: the chip shows it, and the host works on it
    // in its checkout instead of a new worktree.
    const next = located(dispatchTo(checkout, 'studio', 'github.com/openai/solus'))

    expect(runHost(next)).toBe('studio')
    expect(pendingClone(next)).toMatchObject({ repoKey: 'github.com/openai/solus', start: { kind: 'default-branch' } })
    expect(cloneBaseBranch(next)).toBe('main')
    expect(startsWorktree(next)).toBe(false)
  })

  test('keeps a worktree request but drops the old host\'s base branch', () => {
    // WHY: the user asked for isolation, so the move must not undo it. The
    // base branch named a branch on the old host and means nothing there.
    const next = located(dispatchTo(chooseStart(checkout, { kind: 'new-worktree', baseBranch: 'feature' }), 'studio', 'github.com/openai/solus'))

    expect(startsWorktree(next)).toBe(true)
    expect(worktreeBaseBranch(next)).toBeNull()
  })

  test('records an exact remote worktree without changing the local checkout', () => {
    const clone = dispatchTo(chooseStart(checkout, { kind: 'new-worktree', baseBranch: 'main' }), 'studio', 'github.com/openai/solus')

    const next = located(chooseStart(clone, {
      kind: 'worktree',
      path: '/srv/projects/solus/.git/solus/worktrees/release',
      branch: 'release',
    }))

    // WHY: a target worktree path belongs to the target host. The project home
    // checkout must not move before the clone is sent.
    expect(projectHome(next)).toEqual(checkout.project)
    expect(checkoutPlace(next)).toEqual(checkout.project)
    expect(startsWorktree(next)).toBe(false)
    expect(pendingClone(next)).toMatchObject({
      serverId: 'studio',
      repoKey: 'github.com/openai/solus',
      start: { kind: 'worktree', path: '/srv/projects/solus/.git/solus/worktrees/release', branch: 'release' },
    })
    const cleared = located(chooseStart(next.location, { kind: 'new-worktree' }))
    expect(startsWorktree(cleared)).toBe(true)
    expect(worktreeBaseBranch(cleared)).toBeNull()
  })

  test('records an origin branch as a new target worktree without switching locally', () => {
    const clone = dispatchTo(chooseStart(checkout, { kind: 'new-worktree' }), 'studio', 'github.com/openai/solus')

    const next = located(chooseStart(clone, { kind: 'new-worktree', baseBranch: 'release' }))

    // WHY: an origin branch is only the start point for an isolated target-host
    // worktree. The project home checkout must remain on its current branch.
    expect(projectHome(next)).toEqual(checkout.project)
    expect(startsWorktree(next)).toBe(true)
    expect(worktreeBaseBranch(next)).toBe('release')
    expect(cloneBaseBranch(next)).toBe('release')
    expect(pendingClone(next)).toMatchObject({ serverId: 'studio', repoKey: 'github.com/openai/solus' })
  })
})

describe('which host the project chip lists', () => {
  // The chip lists the project home's host while the run names a project, and
  // the run host while it names none.
  const local = folderLocation({ serverId: 'local', path: '/Users/me/solus' })

  test('a plain local run lists its own machine', () => {
    const run = located(local)
    expect(projectRoot(run)).toBe('/Users/me/solus')
    expect(projectHome(run).serverId).toBe('local')
  })

  test('a dispatch lists the project’s home, not where the agent runs', () => {
    // WHY: a dispatch runs on `studio` but the project (and the checkout the chip
    // offers) stays home. Listing studio's projects would offer folders that
    // have nothing to do with the work being dispatched.
    const run = located(dispatchTo(local, 'studio', 'k'))
    expect(runHost(run)).toBe('studio')
    expect(projectRoot(run)).toBe('/Users/me/solus')
    expect(projectHome(run).serverId).toBe('local')
  })

  test('a dispatch with no checkout at home lists the host that will clone it', () => {
    // WHY: a repository opened from the cloud (onboarding's project, a cloud
    // task) starts at `~` and is cloned on the target. There is no home checkout
    // to keep offering, so listing the home machine shows unrelated projects
    // while Run on names the cloud host.
    const run = located(dispatchTo(folderLocation({ serverId: 'local', path: '~' }), 'cloud', 'github.com/me/solus'))
    expect(projectRoot(run)).toBeNull()
    expect(runHost(run)).toBe('cloud')
  })

  test('opening a project elsewhere lists that host at once', () => {
    // WHY: a checkout chosen on another host moves the run there at once, so
    // the project home and the run host name that host before Send.
    const run = located(openFolder(local, { serverId: 'studio', path: '/srv/solus' }))
    expect(projectHome(run).serverId).toBe('studio')
    expect(runHost(run)).toBe('studio')
  })

  test('a project that already lives on a remote lists that remote', () => {
    expect(projectHome(located(folderLocation({ serverId: 'studio', path: '/srv/solus' }))).serverId).toBe('studio')
  })
})
