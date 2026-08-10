import { afterEach, describe, expect, test } from 'bun:test'
import type { PluginCommandsResult, Session } from '../../src/shared/types'

const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state
const previousAudio = globalThis.Audio

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

function commands(name: string): PluginCommandsResult {
  return { global: [{ name, description: '' }], project: [] }
}

function installRendererGlobals(): void {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
  globalThis.Audio = class {
    currentTime = 0
    play() { return Promise.resolve() }
  } as unknown as typeof Audio
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      dispatchEvent: () => true,
      matchMedia: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
      solus: {},
    },
  })
}

afterEach(() => {
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
  if (previousAudio === undefined) delete (globalThis as unknown as { Audio?: typeof Audio }).Audio
  else globalThis.Audio = previousAudio
})

describe('workspace plugin command demand', () => {
  test('keeps a previous tab response from replacing the active slash menu', async () => {
    installRendererGlobals()
    const { WorkspaceLifecycleStore } = await import('../../src/renderer/contexts/workspace/workspace-lifecycle.store.svelte')
    const sessionA = {
      id: 'session-a',
      run: {
        provider: 'claude-code',
        workingDirectory: '/repo-a',
      } as Session['run'],
      pluginCommands: { global: [], project: [] },
    } as unknown as Session
    const sessionB = {
      id: 'session-b',
      run: {
        provider: 'claude-code',
        workingDirectory: '/repo-b',
      } as Session['run'],
      pluginCommands: { global: [], project: [] },
    } as unknown as Session
    const registry = {
      activeTabId: 'tab-a',
      activeSession: sessionA,
      tabOrder: ['tab-a', 'tab-b'],
      sessionFor: (tabId: string) => tabId === 'tab-a' ? sessionA : sessionB,
    }
    const requestA = deferred<PluginCommandsResult>()
    const requestB = deferred<PluginCommandsResult>()
    const store = new WorkspaceLifecycleStore({
      registry: registry as any,
      settings: { activeAgent: 'claude-code' } as any,
      config: { globalDefaults: { workingDirectory: '/repo-a' } } as any,
      planStore: {} as any,
      refreshGitState: async () => ({}) as any,
      ctxFor: (tabId) => ({
        session: {
          tabId,
          provider: 'claude-code',
          workingDirectory: registry.sessionFor(tabId).run.workingDirectory,
          contextWindow: null,
        },
        statusBar: { model: 'opus' },
      }) as any,
      apiFor: (tabId) => ({
        getPluginCommands: async () => tabId === 'tab-a' ? requestA.promise : requestB.promise,
      }) as any,
      loadTranscript: async () => ({ messages: [], progress: null, planIds: [] }),
      rebuildAgentConversations: () => {},
    })

    const loadingA = store.refreshPluginCommands('/repo-a', 'tab-a')
    registry.activeTabId = 'tab-b'
    registry.activeSession = sessionB
    const loadingB = store.refreshPluginCommands('/repo-b', 'tab-b')
    requestB.resolve(commands('b'))
    await loadingB
    requestA.resolve(commands('a'))
    await loadingA

    expect(store.pluginCommands).toEqual(commands('b'))
    expect(sessionA.pluginCommands).toEqual(commands('a'))
    expect(sessionB.pluginCommands).toEqual(commands('b'))
  })

  test('tab selection requests commands only for the selected session', async () => {
    installRendererGlobals()
    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
    const selectedSession = {
      id: 'session-b',
      run: {
        provider: 'claude-code',
        workingDirectory: '/repo-b',
      } as Session['run'],
    } as unknown as Session
    const requested: Array<{ cwd: string; tabId: string }> = []
    const workspace = Object.create(WorkspaceContext.prototype) as any
    workspace.registry = {
      tabs: {
        'tab-a': { id: 'tab-a', sessionId: 'session-a' },
        'tab-b': { id: 'tab-b', sessionId: 'session-b', hasUnread: true },
      },
      sessions: {
        'session-a': { id: 'session-a', provider: 'codex', workingDirectory: '/repo-a' },
        'session-b': selectedSession,
      },
      activeTabId: 'tab-a',
      sessionFor(tabId: string) {
        const tab = this.tabs[tabId]
        return tab ? this.sessions[tab.sessionId] : undefined
      },
      setActiveTab(tabId: string) { this.activeTabId = tabId },
    }
    workspace.ui = { isExpanded: true }
    workspace.router = { asidePanes: [], chatSessionIn: () => null, showsChat: () => false, close: () => {} }
    workspace.settings = {
      activeAgent: 'codex',
      update(patch: { activeAgent: string }) { this.activeAgent = patch.activeAgent },
    }
    workspace.config = {
      followActiveSessionAgent(agentId: string) {
        workspace.settings.update({ activeAgent: agentId })
      },
    }
    workspace.resetOverlays = () => {}
    workspace.refreshPluginCommands = (cwd: string, tabId: string) => {
      requested.push({ cwd, tabId })
      return Promise.resolve()
    }

    workspace.selectTab('tab-b')

    expect(workspace.activeTabId).toBe('tab-b')
    expect(workspace.settings.activeAgent).toBe('claude-code')
    expect(requested).toEqual([{ cwd: '/repo-b', tabId: 'tab-b' }])
  })
})
