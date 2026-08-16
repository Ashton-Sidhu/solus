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
      defaultModels: {} as Record<string, string>,
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
      openSessionDraft: () => {},
      ctx: () => ({ session: { sessionId: 'tab-1' } }) as IpcContext,
      ctxForDirectory: () => ({ session: { sessionId: 'tab-1' } }) as IpcContext,
      apiFor: () => ({
        switchSessionAgent: async () => {
          switchCount++
          return switchCount === 1
            ? {
                fromProvider: 'codex',
                fromSessionId: 'codex-session',
                handoffId: 'tab-1',
                taskSessionMove: {
                  sourceSessionId: 'codex-session',
                  targetSessionId: 'tab-1',
                },
              }
            : {
                fromProvider: 'claude-code',
                fromSessionId: 'codex-session',
                restoredSessionId: 'codex-session',
                taskSessionMove: {
                  sourceSessionId: 'tab-1',
                  targetSessionId: 'codex-session',
                },
              }
        },
      }) as any,
      refreshPluginCommands: () => {},
      rekeyTaskSessionBinding: () => {},
      draftFor: () => undefined,
      apiForRun: () => (window as any).solus,
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
    expect(session.handoffId).toBe('tab-1')
    expect(session.handoffFrom).toBeUndefined()

    await controller.switchActiveAgent('codex')

    expect(switchCount).toBe(2)
    expect(session.run.provider).toBe('codex')
    expect(session.agentSessionId).toBe('codex-session')
    expect(session.handoffFrom).toBeUndefined()
    expect(session.messages).toBe(messages)
    expect(session.messages.at(-1)).toMatchObject({ id: 'answer-1', role: 'assistant' })
  })

  test('changing the default agent leaves the open session on its own provider', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const messages = [{ id: 'answer-1', role: 'assistant', content: 'Done', timestamp: 1 }]
    const session = {
      run: { provider: 'codex', modelConfig: {}, workingDirectory: '/repo' } as Session['run'],
      status: 'idle',
      agentSessionId: 'codex-session',
      messages,
      pluginCommands: { global: [], project: [] },
    } as unknown as Session
    const settings = {
      activeAgent: 'codex',
      defaultModels: {} as Record<string, string>,
      tabGroupMode: 'flat',
      update(patch: { activeAgent?: string }) {
        if (patch.activeAgent) this.activeAgent = patch.activeAgent
      },
    }

    let switchCount = 0
    const { SessionConfigController } = await import('../../src/renderer/contexts/workspace/session-config.svelte')
    const controller = new SessionConfigController({
      settings: settings as any,
      registry: { activeTabId: 'tab-1', activeSession: session, sessionFor: () => session } as any,
      statusBar: { ctx: { workingDirectory: '/repo' } } as any,
      setPluginCommands: () => {},
      openSessionDraft: () => {},
      ctx: () => ({ session: { sessionId: 'tab-1' } }) as IpcContext,
      ctxForDirectory: () => ({ session: { sessionId: 'tab-1' } }) as IpcContext,
      apiFor: () => ({ switchSessionAgent: async () => { switchCount++; return {} } }) as any,
      refreshPluginCommands: () => {},
      draftFor: () => undefined,
      apiForRun: () => (window as any).solus,
      refreshGitRefs: () => {},
      refreshGitState: async () => ({ status: true, details: true, refs: true, registration: true, ok: true }),
    })

    controller.setDefaultAgent('claude-code')

    // WHY: this is a preference for the next session. Handing the open
    // conversation to another provider is a different act, and doing it from
    // Settings both rewrote a transcript the user was not looking at and failed
    // outright whenever that session had no attached runtime.
    expect(switchCount).toBe(0)
    expect(session.run.provider).toBe('codex')
    expect(session.agentSessionId).toBe('codex-session')
    expect(session.handoffFrom).toBeUndefined()
    expect(session.messages).toBe(messages)
    expect(session.messages.at(-1)).toMatchObject({ role: 'assistant' })
    // The default itself still moves, models included.
    expect(settings.activeAgent).toBe('claude-code')
    expect(controller.globalDefaults.modelConfig.modelId).toBe('claude-opus-5')
  })

  test('keeps the next-session model with the agent of the selected session', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const settings = {
      activeAgent: 'codex',
      defaultModels: {} as Record<string, string>,
      tabGroupMode: 'flat',
      update(patch: { activeAgent?: string }) {
        if (patch.activeAgent) this.activeAgent = patch.activeAgent
      },
    }
    const { SessionConfigController } = await import('../../src/renderer/contexts/workspace/session-config.svelte')
    const controller = new SessionConfigController({
      settings: settings as any,
      registry: {} as any,
      statusBar: {} as any,
      setPluginCommands: () => {},
      openSessionDraft: () => {},
      draftFor: () => undefined,
      ctx: () => ({}) as IpcContext,
      ctxForDirectory: () => ({}) as IpcContext,
      apiForRun: () => (window as any).solus,
      refreshPluginCommands: () => {},
      refreshGitRefs: () => {},
      refreshGitState: async () => ({ status: true, details: true, refs: true, registration: true, ok: true }),
    })

    controller.followActiveSessionAgent('claude-code')

    // WHY: a fresh draft reads the provider and model from these two defaults.
    // They must change as one unit or the picker shows one brand beside the
    // other provider's model and dispatches an invalid pair.
    expect(settings.activeAgent).toBe('claude-code')
    expect(controller.globalDefaults.modelConfig.modelId).toBe('claude-opus-5')
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
        worktree: null,
      } as Session['run'],
      agentSessionId: null,
      pluginCommands: { global: [], project: [] },
    } as unknown as Session
    const refreshedPluginDirectories: string[] = []
    const { SessionConfigController } = await import('../../src/renderer/contexts/workspace/session-config.svelte')
    const controller = new SessionConfigController({
      settings: { activeAgent: 'codex', defaultModels: {}, tabGroupMode: 'flat', worktreeEnabled: false } as any,
      registry: {
        activeTabId: 'draft-tab',
        activeSession: session,
        sessionFor: () => session,
      } as any,
      statusBar: { ctx: { workingDirectory: session.run.workingDirectory } } as any,
      setPluginCommands: () => {},
      openSessionDraft: () => {},
      ctx: () => ({ session: { sessionId: 'draft-tab' } }) as IpcContext,
      ctxForDirectory: () => ({ session: { sessionId: 'draft-tab' } }) as IpcContext,
      refreshPluginCommands: (cwd) => refreshedPluginDirectories.push(cwd),
      draftFor: () => undefined,
      apiForRun: () => (window as any).solus,
      refreshGitRefs: () => {},
      refreshGitState: async () => ({ status: true, details: true, refs: true, registration: true, ok: true }),
    })

    controller.toggleWorktreeMode('draft-tab')

    // WHY: creating a sibling from within a worktree only adapts the unstarted
    // draft into the project-root shape expected by the existing creation path.
    expect(session.run.workingDirectory).toBe('/repo')
    expect(session.run.gitContext).toEqual({ repoRoot: '/repo', branch: 'main', targetBranch: 'main' })
    expect(session.run.worktree).toEqual({ baseBranch: 'main' })
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
        worktree: null,
      } as Session['run'],
      agentSessionId: 'live-session',
    } as unknown as Session
    const { SessionConfigController } = await import('../../src/renderer/contexts/workspace/session-config.svelte')
    const controller = new SessionConfigController({
      settings: { activeAgent: 'codex', defaultModels: {}, tabGroupMode: 'flat', worktreeEnabled: false } as any,
      registry: { activeTabId: 'live-tab', activeSession: session, sessionFor: () => session } as any,
      statusBar: { ctx: { workingDirectory: session.run.workingDirectory } } as any,
      setPluginCommands: () => {},
      openSessionDraft: () => {},
      ctx: () => ({ session: { sessionId: 'live-tab' } }) as IpcContext,
      ctxForDirectory: () => ({ session: { sessionId: 'live-tab' } }) as IpcContext,
      refreshPluginCommands: () => {},
      draftFor: () => undefined,
      apiForRun: () => (window as any).solus,
      refreshGitRefs: () => {},
      refreshGitState: async () => ({ status: true, details: true, refs: true, registration: true, ok: true }),
    })

    controller.toggleWorktreeMode('live-tab')

    expect(session.run.workingDirectory).toBe('/repo/.solus-worktrees/current')
    expect(session.run.gitContext?.worktreePath).toBe('/repo/.solus-worktrees/current')
    expect(session.run.worktree).toBeNull()
  })
})

describe('SessionConfigController branch switching', () => {
  test('rejects a branch for dispatch and accepts an exact remote worktree', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    let checkoutCalls = 0
    const draft = {
      run: {
        serverId: 'local',
        taskServerId: 'local',
        workingDirectory: '/repo',
        gitContext: { repoRoot: '/repo', branch: 'main', targetBranch: 'main' },
        worktree: { baseBranch: 'main' },
        pendingHostDispatch: {
          serverId: 'studio',
          intent: 'dispatch',
          repoKey: 'github.com/openai/solus',
        },
      } as Session['run'],
    }
    const { SessionConfigController } = await import('../../src/renderer/contexts/workspace/session-config.svelte')
    const controller = new SessionConfigController({
      settings: { activeAgent: 'codex', defaultModels: {}, tabGroupMode: 'flat', worktreeEnabled: false } as any,
      registry: { activeSession: undefined, activeTabId: '', sessionFor: () => undefined } as any,
      statusBar: { ctx: { workingDirectory: '/repo' } } as any,
      setPluginCommands: () => {},
      openSessionDraft: () => {},
      ctx: () => ({ session: { sessionId: '' } }) as IpcContext,
      ctxForDirectory: () => ({ session: { sessionId: '' } }) as IpcContext,
      refreshPluginCommands: () => {},
      draftFor: (sourceId) => sourceId === 'draft-1' ? draft as any : undefined,
      apiForRun: () => ({
        gitCheckoutBranch: async () => {
          checkoutCalls++
          throw new Error('must not check out the local branch')
        },
      }) as any,
      refreshGitRefs: () => {},
      refreshGitState: async () => ({ status: true, details: true, refs: true, registration: true, ok: true }),
    })

    expect(await controller.switchToBranch('release', 'draft-1')).toBe(false)
    expect(checkoutCalls).toBe(0)
    expect(draft.run.gitContext?.branch).toBe('main')

    controller.setDispatchWorktree({
      path: '/srv/projects/solus/.solus-worktrees/release',
      branch: 'release',
    }, 'draft-1')

    expect(draft.run.worktree).toBeNull()
    expect(draft.run.pendingHostDispatch).toEqual({
      serverId: 'studio',
      intent: 'dispatch',
      repoKey: 'github.com/openai/solus',
      worktree: {
        path: '/srv/projects/solus/.solus-worktrees/release',
        branch: 'release',
      },
    })
  })

  test('leaves a started session alone and opens a draft in the selected worktree', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const originalSession = {
      run: {
        workingDirectory: '/repo',
        gitContext: { repoRoot: '/repo', branch: 'main', targetBranch: 'main' },
        worktree: null,
      } as Session['run'],
      agentSessionId: 'session-1',
      pluginCommands: { global: [], project: [] },
    } as unknown as Session
    const destinationSession = {
      run: {
        workingDirectory: '/repo',
        gitContext: { repoRoot: '/repo', branch: 'main', targetBranch: 'main' },
        worktree: null,
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
    const resetSessionIds: string[] = []
    let draftedCwd: string | undefined
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        dispatchEvent: () => true,
        solus: {
          resetSession: async (ctx: IpcContext) => {
            resetSessionIds.push(ctx.session.sessionId)
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
      settings: { activeAgent: 'codex', defaultModels: {}, tabGroupMode: 'flat' } as any,
      registry: registry as any,
      statusBar: { ctx: { workingDirectory: '/repo' } } as any,
      setPluginCommands: () => {},
      openSessionDraft: (cwd) => {
        draftedCwd = cwd
      },
      ctx: (tabId) => ({
        session: {
          sessionId: registry.activeSession.id,
          workingDirectory: registry.activeSession.run.workingDirectory,
          gitContext: registry.activeSession.run.gitContext,
        },
      }) as IpcContext,
      ctxForDirectory: () => ({ session: { sessionId: registry.activeTabId } }) as IpcContext,
      refreshPluginCommands: () => {},
      draftFor: () => undefined,
      apiForRun: () => (window as any).solus,
      refreshGitRefs: () => {},
      refreshGitState: async () => ({ status: true, details: true, refs: true, registration: true, ok: true }),
    })

    await controller.switchToWorktree('/repo/.solus-worktrees/feature')

    // WHY: entering a worktree is a new piece of work. A conversation already
    // under way must not be retargeted beneath the user, and nothing is created
    // to hold the new one until it is actually sent.
    expect(draftedCwd).toBe('/repo/.solus-worktrees/feature')
    expect(originalSession.agentSessionId).toBe('session-1')
    expect(originalSession.run.gitContext?.branch).toBe('main')
    expect(destinationSession.run.gitContext?.branch).toBe('main')
    expect(resetSessionIds).toEqual([])
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
          resetSession: async () => { resetCalls++ },
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
      const ctx = () => ({ session: { sessionId: 'tab-1', workingDirectory: session.run.workingDirectory, gitContext: session.run.gitContext } }) as IpcContext
      const controller = new SessionConfigController({
        settings: { activeAgent: 'codex', defaultModels: {}, tabGroupMode: 'flat' } as any,
        registry: { activeSession: session, activeTabId: 'tab-1' } as any,
        statusBar: { ctx: { workingDirectory: '/repo' } } as any,
        setPluginCommands: () => {},
        openSessionDraft: () => {},
        ctx,
        ctxForDirectory: ctx,
        refreshPluginCommands: () => {},
        draftFor: () => undefined,
      apiForRun: () => (window as any).solus,
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

describe('SessionConfigController PR repo checkout activation', () => {
  test('brings an already-matching tab to the front instead of opening a draft', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const liveSession = {
      run: { workingDirectory: '/repo', gitContext: { repoRoot: '/repo', branch: 'main', targetBranch: 'main' } },
    } as unknown as Session
    const matchingSession = {
      run: { workingDirectory: '/repo', gitContext: { repoRoot: '/repo', branch: 'feature/x', targetBranch: 'main' } },
    } as unknown as Session
    const sessions: Record<string, Session> = { 'tab-live': liveSession, 'tab-match': matchingSession }
    const selected: string[] = []
    let draftedCwd: string | undefined
    const { SessionConfigController } = await import('../../src/renderer/contexts/workspace/session-config.svelte')
    const controller = new SessionConfigController({
      settings: { activeAgent: 'codex', defaultModels: {}, tabGroupMode: 'flat' } as any,
      registry: {
        activeTabId: 'tab-live',
        activeSession: liveSession,
        tabOrder: ['tab-live', 'tab-match'],
        sessionFor: (tabId: string) => sessions[tabId],
      } as any,
      statusBar: { ctx: { workingDirectory: '/repo' } } as any,
      setPluginCommands: () => {},
      openSessionDraft: (cwd) => { draftedCwd = cwd },
      ctx: () => ({ session: { sessionId: 'tab-live' } }) as IpcContext,
      ctxForDirectory: () => ({ session: { sessionId: 'tab-live' } }) as IpcContext,
      refreshPluginCommands: () => {},
      draftFor: () => undefined,
      apiForRun: () => ({}) as any,
      refreshGitRefs: () => {},
      refreshGitState: async () => ({ status: true, details: true, refs: true, registration: true, ok: true }),
      selectTab: (tabId) => selected.push(tabId),
    })

    controller.activatePrRepoCheckout({ repoRoot: '/repo', branch: 'feature/x', targetBranch: 'main' }, null)

    // WHY: a tab already on this exact branch is what "activate a matching
    // tab" means — bringing it forward touches nothing about it, so a live
    // conversation on a different tab is left running untouched either way.
    expect(selected).toEqual(['tab-match'])
    expect(draftedCwd).toBeUndefined()
  })

  test('opens a fresh draft when no tab already matches, without migrating the live session', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const liveSession = {
      run: { workingDirectory: '/repo', gitContext: { repoRoot: '/repo', branch: 'main', targetBranch: 'main' } },
    } as unknown as Session
    const selected: string[] = []
    let draftedCwd: string | undefined
    const { SessionConfigController } = await import('../../src/renderer/contexts/workspace/session-config.svelte')
    const controller = new SessionConfigController({
      settings: { activeAgent: 'codex', defaultModels: {}, tabGroupMode: 'flat' } as any,
      registry: {
        activeTabId: 'tab-live',
        activeSession: liveSession,
        tabOrder: ['tab-live'],
        sessionFor: () => liveSession,
      } as any,
      statusBar: { ctx: { workingDirectory: '/repo' } } as any,
      setPluginCommands: () => {},
      openSessionDraft: (cwd) => { draftedCwd = cwd },
      ctx: () => ({ session: { sessionId: 'tab-live' } }) as IpcContext,
      ctxForDirectory: () => ({ session: { sessionId: 'tab-live' } }) as IpcContext,
      refreshPluginCommands: () => {},
      draftFor: () => undefined,
      apiForRun: () => ({}) as any,
      refreshGitRefs: () => {},
      refreshGitState: async () => ({ status: true, details: true, refs: true, registration: true, ok: true }),
      selectTab: (tabId) => selected.push(tabId),
    })

    controller.activatePrRepoCheckout({ repoRoot: '/repo', branch: 'feature/x', targetBranch: 'main' }, null)

    expect(selected).toEqual([])
    expect(draftedCwd).toBe('/repo')
    expect(controller.globalDefaults.gitContext).toEqual({ repoRoot: '/repo', branch: 'feature/x', targetBranch: 'main' })
    // The live tab's own session never moves to the new branch.
    expect(liveSession.run.gitContext?.branch).toBe('main')
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
          resetSession: async () => {},
          worktreeRestore: async () => restored,
        },
      },
    })

    const { SessionConfigController } = await import('../../src/renderer/contexts/workspace/session-config.svelte')
    const session = {
      run: {
        workingDirectory: '/repo',
        gitContext: null,
        worktree: null,
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
      settings: { activeAgent: 'codex', defaultModels: {}, tabGroupMode: 'flat', worktreeEnabled: false } as any,
      registry: registry as any,
      statusBar: { ctx: { workingDirectory: '/repo' } } as any,
      setPluginCommands: () => {},
      openSessionDraft: (cwd) => {
        createdCwd = cwd
      },
      ctx: () => ({ session: { sessionId: registry.activeTabId } }) as IpcContext,
      ctxForDirectory: () => ({ session: { sessionId: registry.activeTabId } }) as IpcContext,
      refreshPluginCommands: () => {},
      draftFor: () => undefined,
      apiForRun: () => (window as any).solus,
      refreshGitRefs: () => {},
      refreshGitState: async () => ({ status: true, details: true, refs: true, registration: true, ok: true }),
    })

    await controller.switchToWorktree(restored.worktreePath)

    // WHY: Pill mode can show the home without any tabs. Choosing an existing
    // worktree must point the next session at that checkout rather than leaving
    // the user on a generic home with only global defaults changed — and it
    // does so without creating a session nobody has written a prompt for yet.
    expect(createdCwd).toBe(restored.worktreePath)
    expect(session.run.gitContext).toBeNull()
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
      settings: { activeAgent: 'codex', defaultModels: {}, tabGroupMode: 'flat', worktreeEnabled: false } as any,
      registry: { activeSession: undefined, activeTabId: '', tabOrder: [], sessionFor: () => undefined } as any,
      statusBar: { ctx: { workingDirectory: '/workspace' } } as any,
      setPluginCommands: () => {},
      openSessionDraft: (cwd) => {
        createdCwd = cwd
      },
      ctx: () => ({ session: { sessionId: '' } }) as IpcContext,
      ctxForDirectory: () => ({ session: { sessionId: '' } }) as IpcContext,
      refreshPluginCommands: () => {},
      draftFor: () => undefined,
      apiForRun: () => (window as any).solus,
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
          resetSession: async () => {},
          trackRecentProject: async () => {},
        },
      },
    })

    const { SessionConfigController } = await import('../../src/renderer/contexts/workspace/session-config.svelte')
    const session = {
      run: {
        workingDirectory: '/old-project',
        gitContext: { repoRoot: '/old-project', branch: 'main', targetBranch: 'main' },
        worktree: null,
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
      settings: { activeAgent: 'codex', defaultModels: {}, tabGroupMode: 'flat', worktreeEnabled: true } as any,
      registry: {
        activeSession: session,
        activeTabId: 'tab-1',
        tabOrder: ['tab-1'],
        sessionFor: () => session,
      } as any,
      statusBar: { ctx: { workingDirectory: '/old-project' } } as any,
      setPluginCommands: () => {},
      openSessionDraft: () => {},
      ctx: () => ({ session: { sessionId: 'tab-1' } }) as IpcContext,
      ctxForDirectory: () => ({ session: { sessionId: 'tab-1' } }) as IpcContext,
      refreshPluginCommands: () => {},
      draftFor: () => undefined,
      apiForRun: () => (window as any).solus,
      refreshGitRefs: () => {},
      refreshGitState: async (options) => {
        expect(options).toEqual({ sourceId: 'tab-1', cwd: '/new-project', worktreeRequested: true })
        await refresh
        session.run.gitContext = { repoRoot: '/new-project', branch: 'main', targetBranch: 'main' }
        session.run.worktree = { baseBranch: 'main' }
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
    expect(session.run.worktree).toEqual({ baseBranch: 'main' })
  })
})
