import { afterEach, describe, expect, test } from 'bun:test'
import type { Session, Tab } from '../../src/shared/types'

const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state
const previousAudio = globalThis.Audio

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
      solus: { createTab: async () => ({ tabId: 'new-tab' }) },
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

describe('WorkspaceContext new-tab Git initialization', () => {
  test('seeds the first prompt tab from the cached Git environment', async () => {
    installRendererGlobals()

    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
    const registry = {
      tabs: {} as Record<string, Tab>,
      sessions: {} as Record<string, Session>,
      tabOrder: [] as string[],
      activeTabId: '',
    }
    const workspace = Object.create(WorkspaceContext.prototype) as any
    workspace.registry = registry
    workspace.lifecycle = { pluginCommands: { global: [], project: [] } }
    workspace.environment = {
      statusFor: (cwd: string) => {
        expect(cwd).toBe('/repo')
        return {
          repoRoot: '/repo',
          headSha: 'abc123',
          branch: 'feature',
          targetBranch: 'main',
          uncommittedChanges: {
            files: [],
            hasMoreFiles: false,
            insertions: 0,
            deletions: 0,
            mergeInProgress: false,
          },
        }
      },
      refreshTab: (currentWorkspace: any, options: { tabId: string }) => {
        const tab = currentWorkspace.tabs[options.tabId]
        expect(currentWorkspace.sessions[tab.sessionId].gitContext?.branch).toBe('feature')
        return Promise.resolve()
      },
    }
    workspace.config = {
      globalDefaults: {
        permissionMode: 'auto',
        workingDirectory: '/repo',
        gitContext: { repoRoot: '/repo', branch: 'stale', targetBranch: 'main' },
        worktreeBaseBranch: null,
        modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
      },
      applyGlobalStartTarget(target: { gitContext: Session['gitContext']; worktreeBaseBranch: string | null }) {
        this.globalDefaults.gitContext = target.gitContext
        this.globalDefaults.worktreeBaseBranch = target.worktreeBaseBranch
      },
    }
    workspace.settings = { activeAgent: 'codex', rateLimitBehavior: 'ask', worktreeEnabled: false }
    workspace.activeInput = { text: 'first prompt', attachments: [], planRefs: [], workRefs: [] }
    workspace.addTabToOrder = (tabId: string) => { registry.tabOrder.push(tabId) }
    workspace.setActiveTab = (tabId: string) => { registry.activeTabId = tabId }
    workspace.resetOverlays = () => {}
    workspace.refreshPluginCommands = () => Promise.resolve()

    const tabId = workspace.createTabFromDefaults()
    const created = registry.sessions[registry.tabs[tabId].sessionId]

    expect(created.gitContext).toEqual({
      repoRoot: '/repo',
      branch: 'feature',
      targetBranch: 'main',
    })
  })

  test('uses the saved worktree default for a fresh session even when its source session is direct', async () => {
    installRendererGlobals()

    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
    const sourceSession = {
      id: 'source-session',
      workingDirectory: '/repo',
      gitContext: { repoRoot: '/repo', branch: 'main', targetBranch: 'main' },
      worktreeBaseBranch: null,
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
    let refreshOptions: { worktreeRequested?: boolean } | null = null
    const workspace = Object.create(WorkspaceContext.prototype) as any
    workspace.registry = registry
    workspace.lifecycle = {
      staticInfo: { workspacePath: '/repo' },
      pluginCommands: { global: [], project: [] },
    }
    workspace.environment = {
      refreshTab: (_workspace: unknown, options: { worktreeRequested?: boolean }) => {
        refreshOptions = options
        return Promise.resolve()
      },
    }
    workspace.config = {
      globalDefaults: {
        permissionMode: 'auto',
        workingDirectory: '/repo',
        gitContext: null,
        worktreeBaseBranch: null,
        modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
      },
      defaultReasoningEffortFor: () => 'high',
    }
    workspace.settings = {
      activeAgent: 'codex',
      rateLimitBehavior: 'ask',
      worktreeEnabled: true,
    }
    workspace.setActiveTab = (tabId: string) => { registry.activeTabId = tabId }
    workspace.addTabToOrder = (tabId: string) => { registry.tabOrder.push(tabId) }
    workspace.resetOverlays = () => {}
    workspace.refreshPluginCommands = () => Promise.resolve()

    const tabId = await workspace.createTab()
    const created = registry.sessions[registry.tabs[tabId].sessionId]

    expect(created.gitContext?.repoRoot).toBe('/repo')
    expect(created.worktreeBaseBranch).toBe('main')
    expect(refreshOptions?.worktreeRequested).toBe(true)
  })

  test('waits for the shared Git environment boundary', async () => {
    installRendererGlobals()

    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
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
    workspace.lifecycle = {
      staticInfo: { workspacePath: '/repo' },
      pluginCommands: { global: [], project: [] },
    }
    workspace.environment = {
      refreshTab: (_workspace: unknown, opts: { tabId?: string; cwd?: string }) => {
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

  test('resolves an explicitly selected project without inheriting the active worktree', async () => {
    installRendererGlobals()

    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
    const sourceSession = {
      id: 'source-session',
      workingDirectory: '/old-project',
      gitContext: {
        repoRoot: '/old-project',
        branch: 'feature',
        targetBranch: 'main',
        worktreePath: '/old-project/.solus-worktrees/feature',
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
    let initializedSession: Session | undefined
    const workspace = Object.create(WorkspaceContext.prototype) as any
    workspace.registry = registry
    workspace.lifecycle = {
      staticInfo: { workspacePath: '/workspace' },
      pluginCommands: { global: [], project: [] },
    }
    workspace.environment = {
      resolveSessionStartTarget: (cwd: string) => {
        expect(cwd).toBe('/new-project')
        return Promise.resolve({
          workingDirectory: cwd,
          gitContext: { repoRoot: cwd, branch: 'develop', targetBranch: 'main' },
          worktreeBaseBranch: null,
        })
      },
      refreshTab: (currentWorkspace: any, options: { tabId: string }) => {
        initializedSession = currentWorkspace.sessionFor(options.tabId)
        return Promise.resolve()
      },
    }
    workspace.config = {
      globalDefaults: {
        permissionMode: 'auto',
        workingDirectory: '/old-project',
        gitContext: null,
        worktreeBaseBranch: null,
        modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
      },
      defaultReasoningEffortFor: () => 'high',
    }
    workspace.settings = { activeAgent: 'codex', rateLimitBehavior: 'ask', worktreeEnabled: false }
    workspace.sessionFor = (tabId: string) => {
      const tab = registry.tabs[tabId]
      return tab ? registry.sessions[tab.sessionId] : undefined
    }
    workspace.setActiveTab = (tabId: string) => { registry.activeTabId = tabId }
    workspace.addTabToOrder = (tabId: string) => { registry.tabOrder.push(tabId) }
    workspace.resetOverlays = () => {}
    workspace.refreshPluginCommands = () => Promise.resolve()

    await workspace.createTab('/new-project')

    expect(initializedSession?.workingDirectory).toBe('/new-project')
    expect(initializedSession?.gitContext).toEqual({
      repoRoot: '/new-project',
      branch: 'develop',
      targetBranch: 'main',
    })
  })

  test('reveals an attached PR chat without waiting for Git initialization', async () => {
    installRendererGlobals()

    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
    const sourceSession = {
      id: 'source-session',
      workingDirectory: '/repo',
      gitContext: { branch: 'main', targetBranch: 'main', repoRoot: '/repo' },
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
    const reviewGitContext = {
      branch: 'solus/pr-9',
      targetBranch: 'main',
      worktreePath: '/repo/.solus-worktrees/pr-9',
    }
    let resolveGit!: () => void
    const gitReady = new Promise<void>((resolve) => { resolveGit = resolve })
    let refreshGitContext: Session['gitContext'] = null
    const workspace = Object.create(WorkspaceContext.prototype) as any
    workspace.registry = registry
    workspace.lifecycle = {
      staticInfo: { workspacePath: '/repo' },
      pluginCommands: { global: [], project: [] },
    }
    workspace.environment = {
      refreshTab: (currentWorkspace: any, opts: { tabId: string }) => {
        const tab = currentWorkspace.tabs[opts.tabId]
        refreshGitContext = currentWorkspace.sessions[tab.sessionId].gitContext
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
    const creation = workspace.createTab(reviewGitContext.worktreePath, {
      activate: false,
      gitContext: reviewGitContext,
      gitInitialization: 'background',
    }).then(() => { completed = true })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(completed).toBe(true)
    expect(refreshGitContext).toEqual(reviewGitContext)

    resolveGit()
    await creation
  })
})
