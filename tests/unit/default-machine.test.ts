import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { chooseDefaultMachine, type SavedServer } from '@solus/client-core/server-registry'
import type { SettingsContext } from '@solus/workspace-ui/contexts/app/settings.context.svelte'

// docs/plans/workspace-and-machines.md §5.1: new work goes to a machine, never
// to the organization's workspace service, which runs nothing.

function saved(id: string, uplink?: SavedServer['uplink']): SavedServer {
  return { id, label: id, url: `https://${id}.test`, sessionToken: '', installationId: id, lastConnected: 1, uplink }
}

const workspace = saved('workspace:org-1', { hostId: 'workspace:org-1', directoryUrl: 'https://app.test', kind: 'cloud', organizationId: 'org-1', isActiveWorkspace: true })
const otherWorkspace = saved('workspace:org-2', { hostId: 'workspace:org-2', directoryUrl: 'https://app.test', kind: 'cloud', organizationId: 'org-2' })
const laptop = saved('laptop', { hostId: 'laptop', directoryUrl: 'https://app.test' })
const orgManaged = saved('managed:h1', { hostId: 'h1', directoryUrl: 'https://app.test', kind: 'managed', organizationId: 'org-1', managedState: 'ready' })
const otherManaged = saved('managed:h2', { hostId: 'h2', directoryUrl: 'https://app.test', kind: 'managed', organizationId: 'org-2', managedState: 'ready' })

describe('the default machine', () => {
  test('is never the workspace service, even when it is the primary', () => {
    // WHY: at the account origin boot makes the workspace service the primary.
    // Sending `start`, usage, or plugin commands there answered PLANE_DISABLED.
    expect(chooseDefaultMachine({
      primaryId: workspace.id,
      localId: null,
      saved: [workspace],
      isConnected: () => true,
    })).toBeNull()
  })

  test('keeps a primary that is a machine, over the desktop\'s own', () => {
    // A desktop that switched its default host to a remote machine keeps it.
    expect(chooseDefaultMachine({ primaryId: laptop.id, localId: 'local', saved: [laptop], isConnected: () => true })).toBe(laptop.id)
    expect(chooseDefaultMachine({ primaryId: null, localId: 'local', saved: [laptop], isConnected: () => true })).toBe('local')
  })

  test('prefers the active organization\'s managed host, then any connected machine', () => {
    const all = [workspace, otherWorkspace, laptop, otherManaged, orgManaged]
    expect(chooseDefaultMachine({ primaryId: workspace.id, localId: null, saved: all, isConnected: () => true })).toBe(orgManaged.id)
    expect(chooseDefaultMachine({
      primaryId: workspace.id,
      localId: null,
      saved: all,
      isConnected: (id) => id !== orgManaged.id,
    })).toBe(laptop.id)
  })

  test('skips a machine that is not connected', () => {
    // A call sent to a machine that is away waits for as long as it stays away.
    expect(chooseDefaultMachine({ primaryId: workspace.id, localId: null, saved: [workspace, laptop], isConnected: () => false })).toBeNull()
  })
})

describe('a window with no machine', () => {
  const runes = globalThis as unknown as { $state?: unknown; $derived?: unknown }
  const previousRunes = { state: runes.$state, derived: runes.$derived }

  afterEach(() => {
    mock.restore()
    runes.$state = previousRunes.state
    runes.$derived = previousRunes.derived
  })

  test('reads no usage and no machine facts, and reads them once a machine is there', async () => {
    runes.$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value })
    runes.$derived = <T>(value: T) => value
    let machine: string | null = null
    const calls: string[] = []
    spyOn(serverConnections, 'defaultMachineId').mockImplementation(() => machine)
    spyOn(serverConnections, 'apiFor').mockImplementation((serverId: string) => asHostApi({
      usageLimits: async () => {
        calls.push(`${serverId}:usageLimits`)
        return []
      },
      start: async () => {
        calls.push(`${serverId}:start`)
        return { version: '1', projectPath: '/p', homePath: '/h', workspacePath: '/w', agents: [] }
      },
    }))
    const { AgentContext } = await import('@solus/workspace-ui/contexts/app/agent.context.svelte')
    const { WorkspaceLifecycleStore } = await import('@solus/workspace-ui/contexts/workspace/workspace-lifecycle.store.svelte')
    const agent = new AgentContext({ activeAgent: 'claude-code' } as SettingsContext)
    const lifecycle = new WorkspaceLifecycleStore({
      registry: { tabOrder: [], activeTabId: '', sessionFor: () => undefined, activeSession: null },
      settings: { activeAgent: 'claude-code' },
      config: {},
      planStore: {},
      agent,
      defaultRunConfig: () => ({ workingDirectory: '/w' }),
      unstartedRuns: () => [],
      refreshGitState: async () => ({ ok: true }),
      ctxFor: () => ({ session: { sessionId: null } }),
      apiFor: () => asHostApi({ getPluginCommands: async () => ({ global: [], project: [] }) }),
      serverIdFor: () => 'machine-1',
      loadTranscript: async () => ({ messages: [], progress: null, planIds: [] }),
      rebuildAgentConversations: () => {},
    } as never)

    await agent.refreshUsage(0)
    await lifecycle.initStaticInfo()
    expect(calls).toEqual([])
    expect(lifecycle.staticInfo).toBeNull()

    machine = 'machine-1'
    await agent.refreshUsage(60_000)
    await lifecycle.initStaticInfo()
    // A second call with the same default machine is a no-op.
    await lifecycle.initStaticInfo()
    expect(calls).toEqual(['machine-1:usageLimits', 'machine-1:start'])
    expect(lifecycle.staticInfo?.workspacePath).toBe('/w')
  })
})
