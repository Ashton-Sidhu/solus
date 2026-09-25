import { afterEach, describe, expect, test } from 'bun:test'
import type { RunConfig } from '@solus/contracts/types'
import { ServerConnections } from '@solus/client-core/server-connections'
import { reconcileMachineReferences, type MachineReferenceOwner } from '@solus/workspace-ui/contexts/workspace/machine-references'

// docs/plans/workspace-and-machines.md §6. WHY: the organization's managed host
// was deleted, a remembered project and a draft still named it, and every read
// keyed by it threw `Unknown Solus server` on each load of the account origin.

function run(serverId: string, extra: Partial<RunConfig> = {}): RunConfig {
  return {
    workingDirectory: `/on/${serverId}`,
    gitContext: null,
    worktree: null,
    modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
    permissionMode: 'ask',
    provider: null,
    serverId,
    taskServerId: serverId,
    projectGroupPath: null,
    sessionSkills: [],
    pendingHostDispatch: null,
    ...extra,
  }
}

function owner(lastProject: MachineReferenceOwner['settings']['lastProject'], runs: RunConfig[]): MachineReferenceOwner {
  const settings = {
    lastProject,
    update(patch: { lastProject: null }) { settings.lastProject = patch.lastProject },
  }
  return {
    settings,
    unstartedRuns: () => runs,
    // Once the remembered project is cleared, a new session starts on the default machine.
    get defaultRunConfig() { return run('laptop', { workingDirectory: '/home/me/workspace' }) },
  }
}

const known = (serverId: string) => serverId === 'laptop' || serverId === 'workspace:org-1'

describe('references to a machine that is gone', () => {
  test('the remembered project is cleared and unstarted work moves to where a new session starts', () => {
    const draft = run('managed:gone', { worktree: { baseBranch: 'main' } })
    const fromTask = run('managed:gone', { taskServerId: 'workspace:org-1' })
    const onLaptop = run('laptop')
    const workspace = owner({ serverId: 'managed:gone', directory: '/data/projects/app' }, [draft, fromTask, onLaptop])

    reconcileMachineReferences(workspace, known, () => true)

    expect(workspace.settings.lastProject).toBeNull()
    // The folder named a path on the gone machine, so the draft takes the new one.
    expect(draft).toMatchObject({ serverId: 'laptop', taskServerId: 'laptop', workingDirectory: '/home/me/workspace', worktree: { baseBranch: null } })
    // A draft opened from a task keeps the task's home: only the machine was deleted.
    expect(fromTask).toMatchObject({ serverId: 'laptop', taskServerId: 'workspace:org-1' })
    expect(onLaptop.workingDirectory).toBe('/on/laptop')
  })

  test('with no machine to move to, unstarted work stays and the remembered project is still cleared', () => {
    const draft = run('managed:gone')
    const workspace = owner({ serverId: 'managed:gone', directory: '/data/projects/app' }, [draft])

    reconcileMachineReferences(workspace, known, () => false)

    expect(workspace.settings.lastProject).toBeNull()
    expect(draft.serverId).toBe('managed:gone')
  })

  test('a remembered project on a machine that is still known is kept', () => {
    const workspace = owner({ serverId: 'laptop', directory: '/home/me/app' }, [])
    reconcileMachineReferences(workspace, known, () => true)
    expect(workspace.settings.lastProject).toEqual({ serverId: 'laptop', directory: '/home/me/app' })
  })
})

describe('a host this client knows', () => {
  const previousLocalStorage = globalThis.localStorage

  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: previousLocalStorage })
  })

  test('is a saved or registered host, never an id that is only remembered', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: (key: string) => key === 'solus.servers'
          ? JSON.stringify([{ id: 'laptop', label: 'Laptop', url: 'https://laptop.test', sessionToken: 't', installationId: 'laptop', lastConnected: 1 }])
          : null,
      },
    })
    const connections = new ServerConnections()
    connections.registerTarget({ id: 'local', label: 'This computer', url: 'http://127.0.0.1:1', sessionToken: '', local: true })

    expect(connections.isKnownServer('laptop')).toBe(true)
    expect(connections.isKnownServer('local')).toBe(true)
    expect(connections.isKnownServer('managed:gone')).toBe(false)
  })
})
