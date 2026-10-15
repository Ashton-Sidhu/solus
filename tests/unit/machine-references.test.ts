import { describe, expect, test } from 'bun:test'
import type { RunConfig } from '@solus/contracts/types'
import { ProjectsStore } from '@solus/workspace-ui/contexts/projects/projects.store.svelte'
import { GONE_MACHINE_READ_ONLY_REASON, reconcileMachineReferences, type MachineReferenceOwner } from '@solus/workspace-ui/contexts/workspace/machine-references'
import { checkoutPlace, fileTasksOn, folderLocation, projectHome, runHost, worktreeBaseBranch, startsWorktree } from '@solus/workspace-ui/contexts/workspace/run-location'

// docs/plans/workspace-and-machines.md §6. WHY: the organization's managed host
// was deleted while a remembered project, a draft, and a kept project list still
// named it. Calls to it fail safely; this pass makes the workspace stop pointing at it.

function run(serverId: string, extra: Partial<RunConfig> = {}): RunConfig {
  return {
    location: folderLocation({ serverId, path: `/on/${serverId}` }),
    modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
    permissionMode: 'supervised',
    provider: null,
    sessionSkills: [],
    ...extra,
  }
}

type StartedSession = ReturnType<MachineReferenceOwner['startedSessions']>[number]

function owner(
  lastProject: MachineReferenceOwner['settings']['lastProject'],
  runs: RunConfig[],
  started: StartedSession[] = [],
  projects: MachineReferenceOwner['projects'] = new ProjectsStore([]),
): MachineReferenceOwner {
  const settings = {
    lastProject,
    setLayout(_key: 'lastProject', value: null) { settings.lastProject = value },
  }
  return {
    settings,
    unstartedRuns: () => runs.map((unstarted) => ({ run: unstarted, moveTo: (next) => { unstarted.location = next } })),
    startedSessions: () => started,
    // Once the remembered project is cleared, a new session starts on the default machine.
    get defaultRunConfig() { return run('laptop', { location: folderLocation({ serverId: 'laptop', path: '/home/me/workspace' }) }) },
    projects,
  }
}

const presenceOf = (serverId: string) => serverId === 'laptop' || serverId === 'workspace:org-1' ? 'present' as const : 'gone' as const

describe('references to a machine that is gone', () => {
  test('the remembered project is cleared and unstarted work moves to where a new session starts', () => {
    const draft = run('managed:gone', {
      location: folderLocation({ serverId: 'managed:gone', path: '/on/managed:gone' }, { newWorktree: { baseBranch: 'main' } }),
    })
    const fromTask = run('managed:gone', {
      location: fileTasksOn(folderLocation({ serverId: 'managed:gone', path: '/on/managed:gone' }), 'workspace:org-1'),
    })
    const onLaptop = run('laptop')
    const workspace = owner({ serverId: 'managed:gone', directory: '/data/projects/app' }, [draft, fromTask, onLaptop])

    reconcileMachineReferences(workspace, presenceOf, () => true)

    expect(workspace.settings.lastProject).toBeNull()
    // The folder named a path on the gone machine, so the draft takes the new one.
    // Wanting a worktree survives; the base branch named a branch over there.
    expect(runHost(draft)).toBe('laptop')
    expect(projectHome(draft).serverId).toBe('laptop')
    expect(checkoutPlace(draft).path).toBe('/home/me/workspace')
    expect(startsWorktree(draft)).toBe(true)
    expect(worktreeBaseBranch(draft)).toBeNull()
    // A draft opened from a task keeps the task's project home: only the machine was deleted.
    expect(runHost(fromTask)).toBe('laptop')
    expect(projectHome(fromTask).serverId).toBe('workspace:org-1')
    expect(checkoutPlace(onLaptop).path).toBe('/on/laptop')
  })

  test('a started session keeps its machine and becomes read-only; one on a known machine is left alone', () => {
    // Its conversation lives on the gone machine: moving it would lose it, and a
    // prompt would go nowhere.
    const onGone: StartedSession = { run: run('managed:gone'), readOnlyReason: null }
    const onLaptop: StartedSession = { run: run('laptop'), readOnlyReason: null }
    const worktreeGone: StartedSession = { run: run('managed:gone'), readOnlyReason: 'This session is read-only because its worktree no longer exists.' }

    reconcileMachineReferences(owner(null, [], [onGone, onLaptop, worktreeGone]), presenceOf, () => true)

    expect(runHost(onGone.run)).toBe('managed:gone')
    expect(onGone.readOnlyReason).toBe(GONE_MACHINE_READ_ONLY_REASON)
    expect(onLaptop.readOnlyReason).toBeNull()
    // A reason already given is not replaced.
    expect(worktreeGone.readOnlyReason).toContain('worktree')
  })

  test('with no machine to move to, unstarted work stays and the remembered project is still cleared', () => {
    const draft = run('managed:gone')
    const workspace = owner({ serverId: 'managed:gone', directory: '/data/projects/app' }, [draft])

    reconcileMachineReferences(workspace, presenceOf, () => false)

    expect(workspace.settings.lastProject).toBeNull()
    expect(runHost(draft)).toBe('managed:gone')
  })

  test('the project list kept from a gone machine is dropped, so no project reads a checkout there', () => {
    // A project's favicon reads its checkout's host; a list kept from a deleted
    // host made every project row ask `apiFor` for a host that no longer exists.
    const entry = { key: '', folderName: 'app', addedAt: '2026-01-01T00:00:00.000Z', lastUsedAt: '2026-01-01T00:00:00.000Z', repositoryKey: null }
    const projects = new ProjectsStore([
      { serverId: 'managed:gone', projects: [{ ...entry, path: '/data/projects/app' }] },
      { serverId: 'laptop', projects: [{ ...entry, path: '/home/me/app' }] },
    ])

    reconcileMachineReferences(owner(null, [], [], projects), presenceOf, () => true)

    expect(projects.entries.map((checkout) => checkout.serverId)).toEqual(['laptop'])
  })

  test('a remembered project on a machine that is still known is kept', () => {
    const workspace = owner({ serverId: 'laptop', directory: '/home/me/app' }, [])
    reconcileMachineReferences(workspace, presenceOf, () => true)
    expect(workspace.settings.lastProject).toEqual({ serverId: 'laptop', directory: '/home/me/app' })
  })
})
