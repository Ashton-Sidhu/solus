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

describe('SessionConfigController branch switching', () => {
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

    const { SessionConfigController } = await import('../../src/renderer/contexts/session-config.svelte')
    const { toasts } = await import('../../src/renderer/contexts/toast.store.svelte')
    const messages: string[] = []
    const originalError = toasts.error
    toasts.error = (message: string) => { messages.push(message) }
    try {
      const session = {
        workingDirectory: '/repo',
        gitContext: { repoRoot: '/repo', branch: 'main', targetBranch: 'main' },
        agentSessionId: null,
        sessionChangedFiles: [],
      } as unknown as Session
      const ctx = () => ({ session: { tabId: 'tab-1', workingDirectory: session.workingDirectory, gitContext: session.gitContext } }) as IpcContext
      const controller = new SessionConfigController({
        settings: { activeAgent: 'codex', tabGroupMode: 'flat' } as any,
        registry: { activeSession: session, activeTabId: 'tab-1' } as any,
        statusBar: { ctx: { workingDirectory: '/repo' } } as any,
        setPluginCommands: () => {},
        createTab: async () => 'tab-1',
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
  test('materializes a tab when a project is selected from the tab-less home', async () => {
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

    const { SessionConfigController } = await import('../../src/renderer/contexts/session-config.svelte')
    let createdCwd: string | undefined
    const controller = new SessionConfigController({
      settings: { activeAgent: 'codex', tabGroupMode: 'flat', worktreeEnabled: false } as any,
      registry: { activeSession: undefined, activeTabId: '', tabOrder: [], sessionFor: () => undefined } as any,
      statusBar: { ctx: { workingDirectory: '/workspace' } } as any,
      setPluginCommands: () => {},
      createTab: async (cwd) => {
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

    const { SessionConfigController } = await import('../../src/renderer/contexts/session-config.svelte')
    const session = {
      workingDirectory: '/old-project',
      gitContext: { repoRoot: '/old-project', branch: 'main', targetBranch: 'main' },
      worktreeBaseBranch: null,
      agentSessionId: null,
      provider: null,
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
      createTab: async () => 'tab-1',
      ctx: () => ({ session: { tabId: 'tab-1' } }) as IpcContext,
      ctxForDirectory: () => ({ session: { tabId: 'tab-1' } }) as IpcContext,
      refreshPluginCommands: () => {},
      refreshGitRefs: () => {},
      refreshGitState: async (options) => {
        expect(options).toEqual({ tabId: 'tab-1', cwd: '/new-project', worktreeRequested: true })
        await refresh
        session.gitContext = { repoRoot: '/new-project', branch: 'main', targetBranch: 'main' }
        session.worktreeBaseBranch = 'main'
        return { status: true, details: true, refs: true, registration: true, ok: true }
      },
    })

    let completed = false
    const selection = controller.setBaseDirectory('/new-project', 'tab-1').then(() => { completed = true })
    await Promise.resolve()

    expect(completed).toBe(false)
    expect(controller.pendingSessionStartTarget('tab-1')).not.toBeNull()
    expect(session.workingDirectory).toBe('/new-project')
    expect(session.gitContext).toBeNull()

    resolveRefresh()
    await selection

    expect(controller.pendingSessionStartTarget('tab-1')).toBeNull()
    expect(session.gitContext?.repoRoot).toBe('/new-project')
    expect(session.worktreeBaseBranch).toBe('main')
  })
})
