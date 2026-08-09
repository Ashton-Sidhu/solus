import { afterEach, describe, expect, test } from 'bun:test'
import type { RunConfig, Session, Tab } from '../../src/shared/types'

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
      // The analytics client wires listeners onto `window` the moment the
      // workspace context is imported. Without these the whole file passes or
      // fails on whether some *earlier* test file happened to import it first,
      // which makes a red here mean nothing.
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
      solus: { watchSession: async () => ({ sessionId: 'new-session' }) },
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

describe('WorkspaceContext tab clearing', () => {
  test('removes provider handoff lineage from the cleared session', async () => {
    installRendererGlobals()

    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
    const session = {
      agentSessionId: null,
      run: {
        provider: 'claude-code',
        worktree: null,
        gitContext: null,
        workingDirectory: '/repo',
      } as Session['run'],
      handoffFrom: { provider: 'codex', sessionId: 'previous-session' },
      messages: [],
      sessionChangedFiles: [],
      lastResult: null,
      sessionUsage: null,
      isStreamingText: false,
      isReconnecting: false,
      permissionQueue: [],
      questionQueue: [],
      permissionDenied: null,
      outboundPrompts: [],
      status: 'idle',
      progress: null,
      readOnlyReason: null,
    } as unknown as Session
    const workspace = Object.create(WorkspaceContext.prototype) as any
    workspace.registry = {
      tabs: { 'tab-a': { id: 'tab-a', sessionId: 'session-a', title: 'Handoff' } },
      sessions: { 'session-a': session },
      tabOrder: ['tab-a'],
      activeTabId: 'tab-a',
    }
    workspace.apiFor = () => ({ resetSession: async () => {} })
    workspace.ctxFor = () => ({ session: { sessionId: 'tab-a' } })
    workspace.eventReducer = { streaming: { text: {} }, clearStreamingText: () => {} }
    workspace.environment = { refreshEnvironment: async () => {} }
    // A class field, so an Object.create'd instance never gets one.
    workspace.metadataFinalizedTabs = new Set<string>()

    workspace.clearTab('tab-a')

    expect(session.handoffFrom).toBeUndefined()
  })
})

describe('WorkspaceContext new-tab Git initialization', () => {
  test('seeds the first prompt tab from the cached Git environment', async () => {
    installRendererGlobals()

    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
    const { serverConnections } = await import('../../src/client-core/server-connections')
    const originalConnectionFor = serverConnections.connectionFor.bind(serverConnections)
    serverConnections.connectionFor = (() => ({
      serverId: 'remote-server',
      target: { local: false },
    })) as typeof serverConnections.connectionFor
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
      refreshEnvironment: (currentWorkspace: any, options: { sourceId: string }) => {
        const tab = currentWorkspace.tabs[options.sourceId]
        expect(currentWorkspace.sessions[tab.sessionId].run.gitContext?.branch).toBe('feature')
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
      applyGlobalStartTarget(target: { gitContext: RunConfig['gitContext']; worktreeBaseBranch: string | null }) {
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

    let created: Session
    try {
      const tabId = workspace.createTabFromDefaults()
      created = registry.sessions[registry.tabs[tabId].sessionId]
    } finally {
      serverConnections.connectionFor = originalConnectionFor
    }

    expect(created.run.gitContext).toEqual({
      repoRoot: '/repo',
      branch: 'feature',
      targetBranch: 'main',
    })
    expect(created.run.serverId).toBe('remote-server')
  })

  test('uses the saved worktree default for a fresh session even when its source session is direct', async () => {
    installRendererGlobals()

    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
    const sourceSession = {
      id: 'source-session',
      run: {
        workingDirectory: '/repo',
        gitContext: { repoRoot: '/repo', branch: 'main', targetBranch: 'main' },
        worktree: null,
        modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
        provider: 'codex',
        sessionSkills: [],
      } as Session['run'],
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
      refreshEnvironment: (_workspace: unknown, options: { worktreeRequested?: boolean }) => {
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

    expect(created.run.gitContext?.repoRoot).toBe('/repo')
    expect(created.run.worktree).toEqual({ baseBranch: 'main' })
    expect(refreshOptions?.worktreeRequested).toBe(true)
  })

  test('waits for the shared Git environment boundary', async () => {
    installRendererGlobals()

    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
    const sourceSession = {
      id: 'source-session',
      run: {
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
      } as Session['run'],
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
      refreshEnvironment: (_workspace: unknown, opts: { sourceId?: string; cwd?: string }) => {
        // The tab id is minted locally now; what matters is that the new tab's
        // Git refresh is the one being awaited.
        expect(opts.sourceId).toBe(registry.activeTabId)
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
      run: {
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
      } as Session['run'],
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
    let handedOffGitContext: unknown
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
      // The store is the single funnel: it resolves the start target for the
      // session's own cwd and applies it. Mirror that here so the test sees both
      // what createTab hands over and what the session ends up with.
      refreshEnvironment: async (currentWorkspace: any, options: { sourceId: string }) => {
        initializedSession = currentWorkspace.sessionFor(options.sourceId)
        handedOffGitContext = initializedSession?.run.gitContext
        const target = await workspace.environment.resolveSessionStartTarget(
          initializedSession!.run.workingDirectory,
          { worktreeRequested: false },
        )
        initializedSession!.run.gitContext = target.gitContext
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

    expect(initializedSession?.run.workingDirectory).toBe('/new-project')
    // The tab paints before any Git work, so it must start with no checkout at
    // all rather than the active session's worktree.
    expect(handedOffGitContext).toBeNull()
    expect(initializedSession?.run.gitContext).toEqual({
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
      run: {
        workingDirectory: '/repo',
        gitContext: { branch: 'main', targetBranch: 'main', repoRoot: '/repo' },
        modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
        provider: 'codex',
        sessionSkills: [],
      } as Session['run'],
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
    let refreshGitContext: RunConfig['gitContext'] = null
    const workspace = Object.create(WorkspaceContext.prototype) as any
    workspace.registry = registry
    workspace.lifecycle = {
      staticInfo: { workspacePath: '/repo' },
      pluginCommands: { global: [], project: [] },
    }
    workspace.environment = {
      refreshEnvironment: (currentWorkspace: any, opts: { sourceId: string }) => {
        const tab = currentWorkspace.tabs[opts.sourceId]
        refreshGitContext = currentWorkspace.sessions[tab.sessionId].run.gitContext
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

describe('WorkspaceContext task-bound tab creation', () => {
  test('passes the subtask id into tab creation', async () => {
    installRendererGlobals()

    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
    const workspace = Object.create(WorkspaceContext.prototype) as any
    let createOptions: Record<string, unknown> | undefined
    workspace.createTab = async (cwd: string, options: Record<string, unknown>) => {
      expect(cwd).toBe('/repo')
      createOptions = options
      return 'subtask-tab'
    }
    workspace.router = { closeGroup: () => {} }

    await workspace.openTaskSession({ id: 'subtask-1', projectKey: '/repo' })

    expect(createOptions).toEqual({ taskId: 'subtask-1' })
  })

  test('publishes the task relationship with the new tab', async () => {
    installRendererGlobals()

    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
    const sourceSession = {
      id: 'source-session',
      run: {
        serverId: 'local',
        workingDirectory: '/repo',
        gitContext: null,
        modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
        provider: 'codex',
        sessionSkills: [],
      } as Session['run'],
    } as unknown as Session
    const registry = {
      tabs: {} as Record<string, Tab>,
      sessions: {} as Record<string, Session>,
      tabOrder: [] as string[],
      activeTabId: 'source-tab',
      get activeSession() { return sourceSession },
    }
    const workspace = Object.create(WorkspaceContext.prototype) as any
    workspace.registry = registry
    workspace.lifecycle = {
      staticInfo: { workspacePath: '/repo' },
      pluginCommands: { global: [], project: [] },
    }
    workspace.config = {
      globalDefaults: {
        permissionMode: 'auto',
        workingDirectory: '/repo',
        gitContext: null,
        worktreeBaseBranch: null,
        modelConfig: sourceSession.run.modelConfig,
      },
      defaultReasoningEffortFor: () => 'high',
    }
    workspace.settings = {
      activeAgent: 'codex',
      rateLimitBehavior: 'ask',
      worktreeEnabled: false,
    }
    workspace.addTabToOrder = (tabId: string) => { registry.tabOrder.push(tabId) }
    workspace.setActiveTab = (tabId: string) => { registry.activeTabId = tabId }
    workspace.resetOverlays = () => {}
    workspace.refreshPluginCommands = () => Promise.resolve()
    workspace.environment = {
      refreshEnvironment: (currentWorkspace: any, options: { sourceId: string }) => {
        const tab = currentWorkspace.tabs[options.sourceId]
        // WHY: adding the tab to tabOrder makes it visible to the sidebar. A
        // subtask id assigned only after this async boundary flashes as a loose
        // top-level task until initialization finishes.
        expect(currentWorkspace.sessions[tab.sessionId].task).toEqual({ kind: 'existing', taskId: 'subtask-1' })
        return Promise.resolve()
      },
    }

    const tabId = await workspace.createTab('/repo', { taskId: 'subtask-1' })

    expect(workspace.sessionFor(tabId)?.task).toEqual({ kind: 'existing', taskId: 'subtask-1' })
  })
})

describe('WorkspaceContext resumed-session tab creation', () => {
  test('uses the normal tab lifecycle instead of constructing an orphan tab', async () => {
    installRendererGlobals()
    ;(window.solus as any).loadSession = async () => []
    ;(window.solus as any).worktreeRestore = async () => null

    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
    const sourceSession = {
      id: 'source-session',
      agentSessionId: 'source-agent-session',
      run: {
        provider: 'codex',
        workingDirectory: '/repo',
      } as Session['run'],
      status: 'idle',
      messages: [{}],
    } as unknown as Session
    const registry = {
      tabs: {
        'source-tab': { id: 'source-tab', sessionId: 'source-session' },
      } as Record<string, Tab>,
      sessions: { 'source-session': sourceSession } as Record<string, Session>,
      tabOrder: ['source-tab'],
      activeTabId: 'source-tab',
      get activeTab() {
        return this.tabs[this.activeTabId]
      },
      get activeSession() {
        return this.sessionFor(this.activeTabId)
      },
      sessionFor(tabId: string) {
        const tab = this.tabs[tabId]
        return tab ? this.sessions[tab.sessionId] : undefined
      },
    }
    let createOptions: Record<string, unknown> | undefined
    const workspace = Object.create(WorkspaceContext.prototype) as any
    workspace.registry = registry
    workspace.config = {
      globalDefaults: {
        permissionMode: 'auto',
        workingDirectory: '/repo',
        gitContext: null,
        modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
      },
    }
    workspace.settings = {
      activeAgent: 'codex',
      update: () => {},
    }
    workspace.ui = { isExpanded: false }
    workspace.createTab = async (cwd: string, options: Record<string, unknown>) => {
      expect(cwd).toBe('/repo')
      createOptions = options
      const resumedSession = {
        id: 'resumed-session',
        agentSessionId: null,
        run: {
          provider: null,
          workingDirectory: cwd,
        } as Session['run'],
        status: 'idle',
        messages: [],
      } as unknown as Session
      registry.sessions['resumed-session'] = resumedSession
      registry.tabs['resumed-tab'] = {
        id: 'resumed-tab',
        sessionId: 'resumed-session',
        title: 'New Tab',
      } as Tab
      registry.tabOrder.push('resumed-tab')
      registry.activeTabId = 'resumed-tab'
      return 'resumed-tab'
    }
    workspace.ctxFor = () => ({ session: {} })
    // Resuming a thread read off disk asks the host who owns it; here the host
    // has never seen it, so it accepts the id this client minted.
    workspace.apiFor = () => ({
      watchSession: async ({ sessionId }: { sessionId?: string }) => ({ sessionId: sessionId ?? 'resumed-session' }),
    })
    workspace.attachRuntimeSession = async () => {}
    workspace.eventReducer = { rebuildAgentConversations: () => {} }
    workspace.environment = { refreshEnvironment: async () => null }
    workspace.recomputeChangedFiles = () => {}
    workspace.refreshPluginCommands = async () => {}
    workspace.planStore = { hydrateAnnotations: async () => {} }
    let hydratedTaskSessionId: string | null = null
    workspace.tasksStore = {
      ensureSessionBinding: async (sessionId: string) => {
        hydratedTaskSessionId = sessionId
        return null
      },
    }
    workspace.resetOverlays = () => {}
    // A class field, so an Object.create'd instance never gets one. `runFor`
    // reads it to answer "a draft's run" before falling back to a tab's.
    workspace.sessionDrafts = new Map()

    const tabId = await workspace.resumeSession({
      provider: 'codex',
      sessionId: 'resumed-agent-session',
      slug: null,
      firstMessage: 'Resumed work',
      lastTimestamp: '',
      size: 0,
      cwd: '/repo',
      projectPath: '/repo',
    })

    expect(tabId).toBe('resumed-tab')
    expect(createOptions).toEqual({
      activate: true,
      gitContext: null,
      gitInitialization: 'background',
      worktreeRequested: false,
    })
    expect(registry.sessions['resumed-session'].agentSessionId).toBe('resumed-agent-session')
    expect(registry.sessions['resumed-session'].title).toBe('Resumed work')
    expect(hydratedTaskSessionId).toBe('resumed-agent-session')
  })

  test('adopts the host\'s id when another client already opened the thread', async () => {
    // WHY: this client read the provider thread off disk and minted a local id
    // for it. If a second client is already on that thread, the host answers
    // with the id it gave the first one, and this client must re-key onto it —
    // otherwise the two hold different addresses for one session and every
    // publish reaches only one of them.
    installRendererGlobals()
    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
    const workspace = Object.create(WorkspaceContext.prototype) as any
    const session = { id: 'local-uuid', agentSessionId: null } as unknown as Session
    workspace.registry = {
      sessions: { 'local-uuid': session },
      tabs: { 'tab-1': { id: 'tab-1', sessionId: 'local-uuid' } as Tab },
    }

    ;(workspace as { adoptSessionId(tabId: string, sessionId: string): void })
      .adoptSessionId('tab-1', 'host-owned-id')

    expect(workspace.registry.sessions['host-owned-id']).toBe(session)
    expect(workspace.registry.sessions['local-uuid']).toBeUndefined()
    expect(session.id).toBe('host-owned-id')
    expect(workspace.registry.tabs['tab-1'].sessionId).toBe('host-owned-id')
  })
})

describe('Session bootstrap Git ordering', () => {
  test('starts the Git environment refresh without waiting on the runtime bind', async () => {
    installRendererGlobals()

    const order: string[] = []
    let releaseBind!: () => void
    const bindPending = new Promise<void>((resolve) => { releaseBind = resolve })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          watchSession: async () => ({ sessionId: 'session-1' }),
          bindRuntimeSession: async () => {
            order.push('bind:start')
            await bindPending
            order.push('bind:end')
            return null
          },
        },
      },
    })

    const { resyncRuntime } = await import('../../src/renderer/contexts/workspace/session-bootstrap')
    const session = {
      agentSessionId: 'agent-1',
      run: {
        workingDirectory: '/repo',
      } as Session['run'],
      status: 'running',
      rateLimitInfo: {},
    } as unknown as Session
    const ctx = {
      tabOrder: ['tab-1'],
      tabs: { 'tab-1': { id: 'tab-1', sessionId: 'session-1' } },
      tabIdsForSession: (sessionId: string) => (sessionId === 'session-1' ? ['tab-1'] : []),
      sessions: { 'session-1': session },
      streaming: { text: {} },
      turnSnapshots: {},
      runtimeSyncing: false,
      ctxFor: () => ({ session: {} }),
      reconcileQueuedPrompts: () => {},
      refreshThreadGoal: async () => {},
      environment: {
        refreshEnvironment: async () => {
          order.push('git:start')
          return null
        },
      },
    } as any

    const resync = resyncRuntime(ctx)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    // The sidebar, home, and Git panel all read the environment. Queueing it
    // behind a runtime round-trip leaves them blank for the whole bind, so Git
    // must already be in flight while the bind is still outstanding.
    expect(order).toEqual(['git:start', 'bind:start'])

    releaseBind()
    await resync
    expect(order).toEqual(['git:start', 'bind:start', 'bind:end'])
    expect(ctx.runtimeSyncing).toBe(false)
  })
})
