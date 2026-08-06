import { afterEach, describe, expect, test } from 'bun:test'
import type { IpcContext, Session } from '../../src/shared/types'

const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

describe('SessionConfigController provider switching', () => {
  test('adds a divider after handing the session to another agent', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const messages = [{ id: 'answer-1', role: 'assistant', content: 'Done', timestamp: 1 }]
    const session = {
      run: {
        provider: 'codex',
        modelConfig: {},
        workingDirectory: '/repo',
      } as Session['run'],
      status: 'idle',
      agentSessionId: 'codex-session',
      messages,
      pluginCommands: { global: [], project: [] },
    } as unknown as Session
    const settings = {
      activeAgent: 'codex',
      tabGroupMode: 'flat',
      update(patch: { activeAgent?: string }) {
        if (patch.activeAgent) this.activeAgent = patch.activeAgent
      },
    }

    let switchCount = 0
    const { SessionConfigController } = await import('../../src/renderer/contexts/workspace/session-config.svelte')
    const controller = new SessionConfigController({
      settings: settings as any,
      registry: {
        activeTabId: 'tab-1',
        activeSession: session,
        sessionFor: () => session,
      } as any,
      statusBar: { ctx: { workingDirectory: '/repo' } } as any,
      setPluginCommands: () => {},
      createDraftTab: async () => 'tab-1',
      ctx: () => ({ session: { tabId: 'tab-1' } }) as IpcContext,
      ctxForDirectory: () => ({ session: { tabId: 'tab-1' } }) as IpcContext,
      apiFor: () => ({
        switchSessionAgent: async () => {
          switchCount++
          return switchCount === 1
            ? { fromProvider: 'codex', fromSessionId: 'codex-session' }
            : {
                fromProvider: 'claude-code',
                fromSessionId: 'codex-session',
                restoredSessionId: 'codex-session',
              }
        },
      }) as any,
      refreshPluginCommands: () => {},
      refreshGitRefs: () => {},
      refreshGitState: async () => ({ status: true, details: true, refs: true, registration: true, ok: true }),
    })

    await controller.switchActiveAgent('claude-code')

    // WHY: the agent handoff changes who answers from this point onward, so the
    // transcript must mark the boundary before the next prompt is sent.
    expect(session.messages).toBe(messages)
    expect(session.messages.at(-1)).toMatchObject({
      role: 'system',
      content: 'Switched to Claude Code',
      agentChangedTo: 'Claude Code',
    })
    expect(session.handoffFrom).toEqual({ provider: 'codex', sessionId: 'codex-session' })

    await controller.switchActiveAgent('codex')

    expect(switchCount).toBe(2)
    expect(session.run.provider).toBe('codex')
    expect(session.agentSessionId).toBe('codex-session')
    expect(session.handoffFrom).toBeUndefined()
    expect(session.messages).toBe(messages)
    expect(session.messages.at(-1)).toMatchObject({
      role: 'system',
      content: 'Switched to Codex',
      agentChangedTo: 'Codex',
    })
  })
})

describe('SessionConfigController worktree selection', () => {
  test('retargets an unstarted worktree draft to a sibling based on main', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const session = {
      run: {
        workingDirectory: '/repo/.solus-worktrees/current',
        gitContext: {
          repoRoot: '/repo',
          branch: 'solus/current-12345',
          targetBranch: 'main',
          worktreePath: '/repo/.solus-worktrees/current',
        },
        worktreeBaseBranch: null,
      } as Session['run'],
      agentSessionId: null,
      pluginCommands: { global: [], project: [] },
    } as unknown as Session
    const refreshedPluginDirectories: string[] = []
    const { SessionConfigController } = await import('../../src/renderer/contexts/workspace/session-config.svelte')
    const controller = new SessionConfigController({
      settings: { activeAgent: 'codex', tabGroupMode: 'flat', worktreeEnabled: false } as any,
      registry: {
        activeTabId: 'draft-tab',
        activeSession: session,
        sessionFor: () => session,
      } as any,
      statusBar: { ctx: { workingDirectory: session.run.workingDirectory } } as any,
      setPluginCommands: () => {},
      createDraftTab: async () => 'draft-tab',
      ctx: () => ({ session: { tabId: 'draft-tab' } }) as IpcContext,
      ctxForDirectory: () => ({ session: { tabId: 'draft-tab' } }) as IpcContext,
      refreshPluginCommands: (cwd) => refreshedPluginDirectories.push(cwd),
      refreshGitRefs: () => {},
      refreshGitState: async () => ({ status: true, details: true, refs: true, registration: true, ok: true }),
    })

    controller.toggleWorktreeMode('draft-tab')

    // WHY: creating a sibling from within a worktree only adapts the unstarted
    // draft into the project-root shape expected by the existing creation path.
    expect(session.run.workingDirectory).toBe('/repo')
    expect(session.run.gitContext).toEqual({ repoRoot: '/repo', branch: 'main', targetBranch: 'main' })
    expect(session.run.worktreeBaseBranch).toBe('main')
    expect(refreshedPluginDirectories).toEqual(['/repo'])
  })

  test('does not retarget a session that has already started', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const session = {
      run: {
        workingDirectory: '/repo/.solus-worktrees/current',
        gitContext: {
          repoRoot: '/repo',
          branch: 'solus/current-12345',
          targetBranch: 'main',
          worktreePath: '/repo/.solus-worktrees/current',
        },
        worktreeBaseBranch: null,
      } as Session['run'],
      agentSessionId: 'live-session',
    } as unknown as Session
    const { SessionConfigController } = await import('../../src/renderer/contexts/workspace/session-config.svelte')
    const controller = new SessionConfigController({
      settings: { activeAgent: 'codex', tabGroupMode: 'flat', worktreeEnabled: false } as any,
      registry: { activeTabId: 'live-tab', activeSession: session, sessionFor: () => session } as any,
      statusBar: { ctx: { workingDirectory: session.run.workingDirectory } } as any,
      setPluginCommands: () => {},
      createDraftTab: async () => 'live-tab',
      ctx: () => ({ session: { tabId: 'live-tab' } }) as IpcContext,
      ctxForDirectory: () => ({ session: { tabId: 'live-tab' } }) as IpcContext,
      refreshPluginCommands: () => {},
      refreshGitRefs: () => {},
      refreshGitState: async () => ({ status: true, details: true, refs: true, registration: true, ok: true }),
    })

    controller.toggleWorktreeMode('live-tab')

    expect(session.run.workingDirectory).toBe('/repo/.solus-worktrees/current')
    expect(session.run.gitContext?.worktreePath).toBe('/repo/.solus-worktrees/current')
    expect(session.run.worktreeBaseBranch).toBeNull()
  })
})

describe('SessionConfigController branch switching', () => {
  test('preserves a started session and switches the new active tab to the selected worktree', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const originalSession = {
      run: {
        workingDirectory: '/repo',
        gitContext: { repoRoot: '/repo', branch: 'main', targetBranch: 'main' },
        worktreeBaseBranch: null,
      } as Session['run'],
      agentSessionId: 'session-1',
      pluginCommands: { global: [], project: [] },
    } as unknown as Session
    const destinationSession = {
      run: {
        workingDirectory: '/repo',
        gitContext: { repoRoot: '/repo', branch: 'main', targetBranch: 'main' },
        worktreeBaseBranch: null,
      } as Session['run'],
      agentSessionId: null,
      pluginCommands: { global: [], project: [] },
    } as unknown as Session
    const registry = {
      activeTabId: 'tab-1',
      activeSession: originalSession,
      sessionFor(tabId: string) {
        return tabId === 'tab-1' ? originalSession : destinationSession
      },
    }
    const resetTabIds: string[] = []
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        dispatchEvent: () => true,
        solus: {
          resetTabSession: async (ctx: IpcContext) => {
            resetTabIds.push(ctx.session.tabId)
          },
          worktreeRestore: async () => ({
            repoRoot: '/repo',
            branch: 'feature',
            targetBranch: 'main',
            worktreePath: '/repo/.solus-worktrees/feature',
          }),
        },
      },
    })

    const { SessionConfigController } = await import('../../src/renderer/contexts/workspace/session-config.svelte')
    const controller = new SessionConfigController({
      settings: { activeAgent: 'codex', tabGroupMode: 'flat' } as any,
      registry: registry as any,
      statusBar: { ctx: { workingDirectory: '/repo' } } as any,
      setPluginCommands: () => {},
      createDraftTab: async () => {
        registry.activeTabId = 'tab-2'
        registry.activeSession = destinationSession
        return 'tab-2'
      },
      ctx: (tabId) => ({
        session: {
          tabId: tabId ?? registry.activeTabId,
          workingDirectory: registry.activeSession.run.workingDirectory,
          gitContext: registry.activeSession.run.gitContext,
        },
      }) as IpcContext,
      ctxForDirectory: () => ({ session: { tabId: registry.activeTabId } }) as IpcContext,
      refreshPluginCommands: () => {},
      refreshGitRefs: () => {},
      refreshGitState: async () => ({ status: true, details: true, refs: true, registration: true, ok: true }),
    })

    await controller.switchToWorktree('/repo/.solus-worktrees/feature')

    expect(registry.activeTabId).toBe('tab-2')
    expect(originalSession.agentSessionId).toBe('session-1')
    expect(originalSession.run.gitContext?.branch).toBe('main')
    expect(destinationSession.run.gitContext).toEqual({
      repoRoot: '/repo',
      branch: 'feature',
      targetBranch: 'main',
      worktreePath: '/repo/.solus-worktrees/feature',
    })
    expect(resetTabIds).toEqual(['tab-2'])
  })

  test('toasts a rejected checkout and does not reset the tab first', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    let resetCalls = 0
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        dispatchEvent: () => true,
        solus: {
          gitCheckoutBranch: async () => { throw new Error('transport disconnected') },
          resetTabSession: async () => { resetCalls++ },
        },
      },
    })

    const { SessionConfigController } = await import('../../src/renderer/contexts/workspace/session-config.svelte')
    const { toasts } = await import('../../src/renderer/lib/toasts')
    const messages: string[] = []
    const originalError = toasts.error
    toasts.error = (message: string) => { messages.push(message) }
    try {
      const session = {
        run: {
          workingDirectory: '/repo',
          gitContext: { repoRoot: '/repo', branch: 'main', targetBranch: 'main' },
        } as Session['run'],
        agentSessionId: null,
        sessionChangedFiles: [],
      } as unknown as Session
      const ctx = () => ({ session: { tabId: 'tab-1', workingDirectory: session.run.workingDirectory, gitContext: session.run.gitContext } }) as IpcContext
      const controller = new SessionConfigController({
        settings: { activeAgent: 'codex', tabGroupMode: 'flat' } as any,
        registry: { activeSession: session, activeTabId: 'tab-1' } as any,
        statusBar: { ctx: { workingDirectory: '/repo' } } as any,
        setPluginCommands: () => {},
        createDraftTab: async () => 'tab-1',
        ctx,
        ctxForDirectory: ctx,
        refreshPluginCommands: () => {},
        refreshGitRefs: () => {},
        refreshGitState: async () => ({ status: true, details: true, refs: true, registration: true, ok: true }),
      })

      expect(await controller.switchToBranch('feature')).toBe(false)
      expect(resetCalls).toBe(0)
      expect(messages).toEqual(["Couldn't switch branch: transport disconnected"])
    } finally {
      toasts.error = originalError
    }
  })
})

describe('SessionConfigController session start target', () => {
  test('opens a draft composer with the selected worktree context from the tab-less home', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const restored = {
      repoRoot: '/repo',
      branch: 'feature',
      targetBranch: 'main',
      worktreePath: '/repo/.solus-worktrees/feature',
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        dispatchEvent: () => true,
        solus: {
          resetTabSession: async () => {},
          worktreeRestore: async () => restored,
        },
      },
    })

    const { SessionConfigController } = await import('../../src/renderer/contexts/workspace/session-config.svelte')
    const session = {
      run: {
        workingDirectory: '/repo',
        gitContext: null,
        worktreeBaseBranch: null,
      } as Session['run'],
      agentSessionId: null,
      pluginCommands: { global: [], project: [] },
    } as unknown as Session
    const registry = {
      activeSession: undefined as Session | undefined,
      activeTabId: '',
      tabOrder: [] as string[],
      sessionFor: () => registry.activeSession,
    }
    let createdCwd: string | undefined
    const controller = new SessionConfigController({
      settings: { activeAgent: 'codex', tabGroupMode: 'flat', worktreeEnabled: false } as any,
      registry: registry as any,
      statusBar: { ctx: { workingDirectory: '/repo' } } as any,
      setPluginCommands: () => {},
      createDraftTab: async (cwd) => {
        createdCwd = cwd
        registry.activeSession = session
        registry.activeTabId = 'new-tab'
        return 'new-tab'
      },
      ctx: () => ({ session: { tabId: registry.activeTabId } }) as IpcContext,
      ctxForDirectory: () => ({ session: { tabId: registry.activeTabId } }) as IpcContext,
      refreshPluginCommands: () => {},
      refreshGitRefs: () => {},
      refreshGitState: async () => ({ status: true, details: true, refs: true, registration: true, ok: true }),
    })

    await controller.switchToWorktree(restored.worktreePath)

    // WHY: Pill mode can show the home without any tabs. Choosing an existing
    // worktree must establish a real composer context rather than leaving the
    // user on the generic "new session" home with only global defaults changed.
    expect(createdCwd).toBe('/repo')
    expect(registry.activeTabId).toBe('new-tab')
    expect(session.run.workingDirectory).toBe('/repo')
    expect(session.run.gitContext).toEqual(restored)
    expect(session.run.worktreeBaseBranch).toBeNull()
  })

  test('opens a draft composer when a project is selected from the tab-less home', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        dispatchEvent: () => true,
        solus: { trackRecentProject: async () => {} },
      },
    })

    const { SessionConfigController } = await import('../../src/renderer/contexts/workspace/session-config.svelte')
    let createdCwd: string | undefined
    const controller = new SessionConfigController({
      settings: { activeAgent: 'codex', tabGroupMode: 'flat', worktreeEnabled: false } as any,
      registry: { activeSession: undefined, activeTabId: '', tabOrder: [], sessionFor: () => undefined } as any,
      statusBar: { ctx: { workingDirectory: '/workspace' } } as any,
      setPluginCommands: () => {},
      createDraftTab: async (cwd) => {
        createdCwd = cwd
        return 'new-tab'
      },
      ctx: () => ({ session: { tabId: '' } }) as IpcContext,
      ctxForDirectory: () => ({ session: { tabId: '' } }) as IpcContext,
      refreshPluginCommands: () => {},
      refreshGitRefs: () => {},
      refreshGitState: async () => {
        throw new Error('tab creation owns Git initialization')
      },
    })

    await controller.setBaseDirectory('/new-project')

    expect(createdCwd).toBe('/new-project')
  })

  test('keeps project selection pending until Git and worktree intent resolve together', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        dispatchEvent: () => true,
        solus: {
          resetTabSession: async () => {},
          trackRecentProject: async () => {},
        },
      },
    })

    const { SessionConfigController } = await import('../../src/renderer/contexts/workspace/session-config.svelte')
    const session = {
      run: {
        workingDirectory: '/old-project',
        gitContext: { repoRoot: '/old-project', branch: 'main', targetBranch: 'main' },
        worktreeBaseBranch: null,
        provider: null,
      } as Session['run'],
      agentSessionId: null,
      additionalDirs: [],
      sessionChangedFiles: [],
      pluginCommands: { global: [], project: [] },
      readOnlyReason: null,
    } as unknown as Session
    let resolveRefresh!: () => void
    const refresh = new Promise<void>((resolve) => { resolveRefresh = resolve })
    const controller = new SessionConfigController({
      settings: { activeAgent: 'codex', tabGroupMode: 'flat', worktreeEnabled: true } as any,
      registry: {
        activeSession: session,
        activeTabId: 'tab-1',
        tabOrder: ['tab-1'],
        sessionFor: () => session,
      } as any,
      statusBar: { ctx: { workingDirectory: '/old-project' } } as any,
      setPluginCommands: () => {},
      createDraftTab: async () => 'tab-1',
      ctx: () => ({ session: { tabId: 'tab-1' } }) as IpcContext,
      ctxForDirectory: () => ({ session: { tabId: 'tab-1' } }) as IpcContext,
      refreshPluginCommands: () => {},
      refreshGitRefs: () => {},
      refreshGitState: async (options) => {
        expect(options).toEqual({ tabId: 'tab-1', cwd: '/new-project', worktreeRequested: true })
        await refresh
        session.run.gitContext = { repoRoot: '/new-project', branch: 'main', targetBranch: 'main' }
        session.run.worktreeBaseBranch = 'main'
        return { status: true, details: true, refs: true, registration: true, ok: true }
      },
    })

    let completed = false
    const selection = controller.setBaseDirectory('/new-project', 'tab-1').then(() => { completed = true })
    await Promise.resolve()

    expect(completed).toBe(false)
    expect(controller.pendingSessionStartTarget('tab-1')).not.toBeNull()
    expect(session.run.workingDirectory).toBe('/new-project')
    expect(session.run.gitContext).toBeNull()

    resolveRefresh()
    await selection

    expect(controller.pendingSessionStartTarget('tab-1')).toBeNull()
    expect(session.run.gitContext?.repoRoot).toBe('/new-project')
    expect(session.run.worktreeBaseBranch).toBe('main')
  })
})
