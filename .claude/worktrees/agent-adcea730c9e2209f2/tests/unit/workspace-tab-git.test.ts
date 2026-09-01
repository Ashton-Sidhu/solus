import { afterEach, describe, expect, test } from 'bun:test'
import type { Session, Tab } from '../../src/shared/types'

const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state
const previousAudio = globalThis.Audio

afterEach(() => {
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
  if (previousAudio === undefined) delete (globalThis as unknown as { Audio?: typeof Audio }).Audio
  else globalThis.Audio = previousAudio
})

describe('WorkspaceContext new-tab Git initialization', () => {
  test('waits for the shared Git environment boundary', async () => {
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
        solus: { createTab: async () => ({ tabId: 'new-tab' }) },
      },
    })

    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace.context.svelte')
    const sourceSession = {
      id: 'source-session',
      workingDirectory: '/repo',
      gitContext: {
        repoRoot: '/repo',
        branch: 'solus/feature',
        targetBranch: 'main',
        worktreePath: '/repo/.solus-worktrees/feature',
      },
      modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
      provider: 'codex',
      sessionSkills: [],
    } as unknown as Session
    const registry = {
      tabs: {} as Record<string, Tab>,
      sessions: {} as Record<string, Session>,
      tabOrder: [] as string[],
      activeTabId: 'source-tab',
      get activeSession() {
        const tab = this.tabs[this.activeTabId]
        return tab ? this.sessions[tab.sessionId] : sourceSession
      },
    }
    let resolveGit!: () => void
    const gitReady = new Promise<void>((resolve) => { resolveGit = resolve })
    let refreshCalled = false
    const workspace = Object.create(WorkspaceContext.prototype) as any
    workspace.registry = registry
    workspace.env = {
      staticInfo: { workspacePath: '/repo' },
      pluginCommands: { global: [], project: [] },
      refreshGitEnvironment: (opts: { tabId?: string; cwd?: string }) => {
        expect(opts.tabId).toBe('new-tab')
        refreshCalled = true
        return gitReady
      },
    }
    workspace.config = {
      globalDefaults: {
        permissionMode: 'auto',
        workingDirectory: '/repo',
        gitContext: null,
        modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
      },
      defaultReasoningEffortFor: () => 'high',
    }
    workspace.settings = { activeAgent: 'codex', rateLimitBehavior: 'ask' }
    workspace.setActiveTab = (tabId: string) => { registry.activeTabId = tabId }
    workspace.addTabToOrder = (tabId: string) => { registry.tabOrder.push(tabId) }
    workspace.resetOverlays = () => {}
    workspace.refreshPluginCommands = () => Promise.resolve()

    let completed = false
    const creation = workspace.createTab().then(() => { completed = true })
    await Promise.resolve()
    await Promise.resolve()

    expect(refreshCalled).toBe(true)
    expect(completed).toBe(false)

    resolveGit()
    await creation
    expect(completed).toBe(true)
  })
})
