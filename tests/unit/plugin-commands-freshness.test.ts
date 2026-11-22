import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { IpcContext, PluginCommandsResult, Session } from '@solus/contracts/types'
import { folderLocation } from '@solus/workspace-ui/contexts/workspace/run-location'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  mock.restore()
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

describe('plugin command freshness', () => {
  test('a tab switch reuses commands already read for the same provider and directory', async () => {
    // WHY: selecting a tab used to re-read its slash commands every time. The
    // list only changes with the directory, the provider, or a skill edit, and
    // each of those refreshes without the freshness flag.
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const session = {
      run: { provider: 'claude-code', location: folderLocation({ serverId: 'host-a', path: '/repo' }) },
      pluginCommands: { global: [], project: [] },
    } as unknown as Session
    const reads: string[] = []
    const loaded: PluginCommandsResult = { global: [{ name: 'review', description: 'Review', source: 'global' }], project: [] } as unknown as PluginCommandsResult
    const ctx = { session: { sessionId: 'session-one', provider: null } } as unknown as IpcContext
    const { WorkspaceLifecycleStore } = await import('@solus/workspace-ui/contexts/workspace/workspace-lifecycle.store.svelte')
    // Slash commands are read only from a machine.
    const { hosts } = await import('@solus/workspace-ui/contexts/hosts/hosts.svelte')
    spyOn(hosts, 'hasExecution').mockImplementation((serverId) => serverId === 'host-a')
    const store = new WorkspaceLifecycleStore({
      registry: {
        activeTabId: 'tab-one',
        tabOrder: ['tab-one'],
        sessions: {},
        tabIdsBySession: new Map(),
        activeSession: session,
        sessionFor: (tabId: string) => (tabId === 'tab-one' ? session : undefined),
      } as never,
      settings: { activeAgent: 'claude-code' } as never,
      config: {} as never,
      planStore: {} as never,
      unstartedRuns: () => [],
      refreshGitState: async () => ({ status: true, details: true, refs: true, registration: true, ok: true }),
      ctxFor: () => ctx,
      apiFor: () => ({
        getPluginCommands: async (directory: string, requestCtx: IpcContext) => {
          reads.push(`${requestCtx.session.provider}:${directory}`)
          return loaded
        },
      }) as never,
      serverIdFor: () => 'host-a',
      loadTranscript: async () => ({ messages: [], progress: null, planIds: [] }),
      rebuildAgentConversations: () => {},
    })

    await store.refreshPluginCommands('/repo', 'tab-one')
    await store.refreshPluginCommands('/repo', 'tab-one', { onlyIfStale: true })
    expect(reads).toEqual(['claude-code:/repo'])
    expect(store.pluginCommands).toBe(loaded)

    // A skill edit asks without the flag and must always read again.
    await store.refreshPluginCommands('/repo', 'tab-one', { onlyIfStale: false })
    expect(reads).toHaveLength(2)

    // A provider change is a new source even for the same directory.
    session.run.provider = 'codex'
    await store.refreshPluginCommands('/repo', 'tab-one', { onlyIfStale: true })
    expect(reads).toEqual(['claude-code:/repo', 'claude-code:/repo', 'codex:/repo'])

    // Boot asks from several places within one frame. Identical reads still
    // on the wire are joined, not repeated; a different directory is not.
    await Promise.all([
      store.refreshPluginCommands('/repo', 'tab-one', { onlyIfStale: false }),
      store.refreshPluginCommands('/repo', 'tab-one', { onlyIfStale: false }),
      store.refreshPluginCommands('/repo', 'tab-one', { onlyIfStale: true }),
      store.refreshPluginCommands('/other', 'tab-one'),
    ])
    expect(reads.slice(3)).toEqual(['codex:/repo', 'codex:/other'])
  })
  test('an empty composer reads once per host, provider, and directory, with an explicit skill refresh', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const { WorkspaceLifecycleStore } = await import('@solus/workspace-ui/contexts/workspace/workspace-lifecycle.store.svelte')
    const { hosts } = await import('@solus/workspace-ui/contexts/hosts/hosts.svelte')
    spyOn(hosts, 'hasExecution').mockReturnValue(true)
    let serverId = 'host-a'
    let directory = '/repo'
    const settings = { activeAgent: 'claude-code' }
    const reads: string[] = []
    let fail = false
    const store = new WorkspaceLifecycleStore({
      registry: {
        activeTabId: 'composer', activeSession: undefined,
        sessionFor: () => undefined,
      } as never,
      settings: settings as never,
      defaultRunConfig: () => ({ location: folderLocation({ serverId, path: directory }) }) as never,
      serverIdFor: () => serverId,
      ctxFor: () => ({ session: { provider: settings.activeAgent } }) as IpcContext,
      apiFor: () => ({ getPluginCommands: async (cwd: string) => {
        reads.push(`${serverId}:${settings.activeAgent}:${cwd}`)
        if (fail) throw new Error('offline')
        return { global: [], project: [] }
      } }) as never,
    } as never)

    await Promise.all([store.refreshPluginCommands(directory), store.refreshPluginCommands(directory)])
    store.pluginCommands = { global: [], project: [] }
    await store.refreshPluginCommands(directory)
    expect(reads).toHaveLength(1)
    settings.activeAgent = 'codex'
    await store.refreshPluginCommands(directory)
    await store.refreshPluginCommands(directory)
    expect(reads).toHaveLength(2)
    serverId = 'host-b'
    await store.refreshPluginCommands(directory)
    expect(reads).toHaveLength(3)
    directory = '/other'
    fail = true
    await expect(store.refreshPluginCommands(directory)).rejects.toThrow('offline')
    fail = false
    await store.refreshPluginCommands(directory)
    await store.refreshPluginCommands(directory)
    expect(reads).toHaveLength(5)
    await store.refreshPluginCommands(directory, undefined, { onlyIfStale: false })
    expect(reads).toHaveLength(6)
    fail = true
    await expect(store.refreshPluginCommands(directory, undefined, { onlyIfStale: false })).rejects.toThrow('offline')
    fail = false
    await store.refreshPluginCommands(directory)
    expect(reads).toHaveLength(8)
  })

  test('a session opened on a source another session read takes its commands without a read', async () => {
    // WHY: a reopened session is a new session object, and each one read the
    // commands again although the host, the provider, and the folder are the same.
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const sessionFor = (path: string) => ({
      run: { provider: 'claude-code', location: folderLocation({ serverId: 'host-a', path }) },
      pluginCommands: { global: [], project: [] },
    }) as unknown as Session
    const sessions: Record<string, Session> = { first: sessionFor('/repo'), reopened: sessionFor('/repo') }
    const loaded = { global: [{ name: 'review', description: 'Review', source: 'global' }], project: [] } as unknown as PluginCommandsResult
    const reads: string[] = []
    const { WorkspaceLifecycleStore } = await import('@solus/workspace-ui/contexts/workspace/workspace-lifecycle.store.svelte')
    const { hosts } = await import('@solus/workspace-ui/contexts/hosts/hosts.svelte')
    spyOn(hosts, 'hasExecution').mockReturnValue(true)
    const store = new WorkspaceLifecycleStore({
      registry: { activeTabId: 'first', sessionFor: (tabId: string) => sessions[tabId] } as never,
      settings: { activeAgent: 'claude-code' } as never,
      serverIdFor: () => 'host-a',
      ctxFor: () => ({ session: { provider: 'claude-code' } }) as IpcContext,
      apiFor: () => ({ getPluginCommands: async (directory: string) => { reads.push(directory); return loaded } }) as never,
    } as never)

    await store.refreshPluginCommands('/repo', 'first')
    await store.refreshPluginCommands('/repo', 'reopened', { onlyIfStale: true })
    expect(reads).toEqual(['/repo'])
    expect(sessions.reopened.pluginCommands).toBe(loaded)
    // A skill edit still reads again.
    await store.refreshPluginCommands('/repo', 'reopened', { onlyIfStale: false })
    expect(reads).toEqual(['/repo', '/repo'])
  })

})
