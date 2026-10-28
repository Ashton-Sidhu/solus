import { describe, expect, test } from 'bun:test'
import type { RunConfig } from '@solus/contracts/types'
import { ProjectsStore } from '@solus/workspace-ui/contexts/projects/projects.store.svelte'
import { reconcileMachineReferences, type MachineReferenceOwner } from '@solus/workspace-ui/contexts/workspace/machine-references'
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

type StartedTab = ReturnType<MachineReferenceOwner['startedTabs']>[number]

function owner(
  lastProject: MachineReferenceOwner['settings']['lastProject'],
  runs: RunConfig[],
  started: StartedTab[] = [],
  projects: MachineReferenceOwner['projects'] = new ProjectsStore([]),
): MachineReferenceOwner {
  const settings = {
    lastProject,
    setLayout(_key: 'lastProject', value: null) { settings.lastProject = value },
  }
  return {
    settings,
    unstartedRuns: () => runs.map((unstarted) => ({ run: unstarted, moveTo: (next) => { unstarted.location = next } })),
    startedTabs: () => started,
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

  test('a started tab on a gone machine closes; one on a known machine stays', () => {
    // WHY: forgetting a machine left its conversations in the sidebar as
    // "Removed host" rows. Forgetting a machine takes its conversations with it.
    const closed: string[] = []
    const tab = (serverId: string): StartedTab => ({ run: run(serverId), close: () => closed.push(serverId) })

    reconcileMachineReferences(owner(null, [], [tab('managed:gone'), tab('laptop')]), presenceOf, () => false)

    expect(closed).toEqual(['managed:gone'])
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
