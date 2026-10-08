import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { HostFacts } from '@solus/client-core/host-facts'
import { serverConnections } from '@solus/client-core/server-connections'
import { chooseRunOnHost, type SavedServer } from '@solus/client-core/server-registry'
import type { SettingsContext } from '@solus/workspace-ui/contexts/app/settings.context.svelte'

// docs/plans/workspace-and-machines.md §5.1: new work goes to a machine, never
// to the organization's workspace service, which runs nothing.

function saved(id: string, uplink?: SavedServer['uplink']): SavedServer {
  return { id, label: id, url: `https://${id}.test`, sessionToken: '', installationId: id, lastConnected: 1, uplink }
}

const workspaceId = 'workspace:org-1'
const laptop = saved('laptop', { hostId: 'laptop', directoryUrl: 'https://app.test' })
const orgManaged = saved('managed:h1', { hostId: 'h1', directoryUrl: 'https://app.test', kind: 'managed', organizationIds: ['org-1'], managedState: 'ready' })
const otherManaged = saved('managed:h2', { hostId: 'h2', directoryUrl: 'https://app.test', kind: 'managed', organizationIds: ['org-2'], managedState: 'ready' })

describe('the default machine', () => {
  test('is never the workspace service, even when it is the primary', () => {
    // WHY: at the account origin boot makes the workspace service the primary.
    // Sending `start`, usage, or plugin commands there answered PLANE_DISABLED.
    expect(chooseRunOnHost({
      primaryId: workspaceId,
      localId: null,
      saved: [],
      activeOrganizationId: 'org-1',
      isConnected: () => true,
    })).toBeNull()
  })

  test('keeps a primary that is a machine, over the desktop\'s own', () => {
    // A desktop that switched its default host to a remote machine keeps it.
    expect(chooseRunOnHost({ primaryId: laptop.id, localId: 'local', saved: [laptop], activeOrganizationId: null, isConnected: () => true })).toBe(laptop.id)
    expect(chooseRunOnHost({ primaryId: null, localId: 'local', saved: [laptop], activeOrganizationId: null, isConnected: () => true })).toBe('local')
  })

  test('prefers the active organization\'s managed host, then any connected machine', () => {
    const all = [laptop, otherManaged, orgManaged]
    expect(chooseRunOnHost({ primaryId: workspaceId, localId: null, saved: all, activeOrganizationId: 'org-1', isConnected: () => true })).toBe(orgManaged.id)
    expect(chooseRunOnHost({
      primaryId: workspaceId,
      localId: null,
      saved: all,
      activeOrganizationId: 'org-1',
      isConnected: (id) => id !== orgManaged.id,
    })).toBe(laptop.id)
  })

  test('skips a machine that is not connected', () => {
    // A call sent to a machine that is away waits for as long as it stays away.
    expect(chooseRunOnHost({ primaryId: workspaceId, localId: null, saved: [laptop], activeOrganizationId: 'org-1', isConnected: () => false })).toBeNull()
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

  test('reads no machine facts, and reads them once a machine is there', async () => {
    runes.$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value })
    runes.$derived = Object.assign(<T>(value: T) => value, { by: <T>(compute: () => T) => compute() })
    let machine: string | null = null
    const calls: string[] = []
    const factsByServerId = new Map<string, HostFacts>()
    spyOn(serverConnections, 'runOnHostId').mockImplementation(() => machine)
    spyOn(serverConnections, 'factsFor').mockImplementation((serverId: string) => {
      let facts = factsByServerId.get(serverId)
      if (!facts) {
        facts = new HostFacts(serverId, {
          api: asHostApi({
            start: async () => {
              calls.push(`${serverId}:start`)
              return { version: '1', projectPath: '/p', homePath: '/h', agents: [{ id: 'codex', available: true }] }
            },
          }),
          events: new HostEventSubscriber(),
        })
        factsByServerId.set(serverId, facts)
      }
      return facts
    })
    const { AgentContext } = await import('@solus/workspace-ui/contexts/app/agent.context.svelte')
    const { WorkspaceLifecycleStore } = await import('@solus/workspace-ui/contexts/workspace/workspace-lifecycle.store.svelte')
    const agent = new AgentContext({ activeAgent: 'codex' } as SettingsContext)
    const lifecycle = new WorkspaceLifecycleStore({
      registry: { tabOrder: [], activeTabId: '', sessionFor: () => undefined, activeSession: null },
      settings: { activeAgent: 'codex' },
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

    await lifecycle.readRunOnAgents()
    expect(calls).toEqual([])
    expect(agent.agents).toEqual([])

    machine = 'machine-1'
    await lifecycle.readRunOnAgents()
    // A second call with the same Run on host is a no-op.
    await lifecycle.readRunOnAgents()
    expect(calls).toEqual(['machine-1:start'])
    expect(agent.agents.map((meta) => meta.id)).toEqual(['codex'])
  })
})

describe('the transcription host', () => {
  afterEach(() => mock.restore())

  function stubFacts() {
    spyOn(serverConnections, 'factsFor').mockImplementation((serverId: string) =>
      new HostFacts(serverId, { api: asHostApi({}), events: new HostEventSubscriber() }))
  }

  test('is the device even when the Run on host is remote', async () => {
    // WHY: only the desktop main process can transcribe. A desktop whose Run on
    // host is a remote server still records and transcribes locally, so the mic
    // must follow the device, not the Run on host (the 2026-10-08 voice bug).
    stubFacts()
    spyOn(serverConnections, 'localServerId').mockImplementation(() => 'local')
    spyOn(serverConnections, 'runOnHostId').mockImplementation(() => laptop.id)
    const { hosts } = await import('@solus/workspace-ui/contexts/hosts/hosts.svelte')
    expect(hosts.transcription?.id).toBe('local')
  })

  test('is the Run on host when the client has no device host', async () => {
    // A web client is not a machine; its transcription goes to the Run on host.
    stubFacts()
    spyOn(serverConnections, 'localServerId').mockImplementation(() => null)
    spyOn(serverConnections, 'runOnHostId').mockImplementation(() => laptop.id)
    const { hosts } = await import('@solus/workspace-ui/contexts/hosts/hosts.svelte')
    expect(hosts.transcription?.id).toBe(laptop.id)
  })
})
