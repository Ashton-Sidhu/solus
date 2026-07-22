import { afterEach, describe, expect, test } from 'bun:test'
import type { GitCheckout, GitState, Session } from '../../src/shared/types'

const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

describe('Git state initialization', () => {
  test('waits for tab-less Git state before startup completes', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { solus: {
        start: async () => ({ version: 'test', auth: null, projectPath: '/project', homePath: '/home/test', workspacePath: '/my-workspace', agents: [] }),
        getPluginCommands: async () => ({ global: [], project: [] }),
      } },
    })
    let finishRefresh!: () => void
    const refresh = new Promise<void>((resolve) => { finishRefresh = resolve })
    const { WorkspaceLifecycleStore } = await import('../../src/renderer/contexts/workspace-lifecycle.store.svelte')
    const globalDefaults = {
      permissionMode: 'auto' as const,
      workingDirectory: '~',
      gitContext: null as GitCheckout | null,
      worktreeBaseBranch: null as string | null,
      modelConfig: { modelId: null, reasoningEffort: 'high' as const, contextWindow: null, fastMode: false },
    }
    let refreshedDirectory: string | null = null
    const store = new WorkspaceLifecycleStore({
      registry: { activeTabId: '', tabOrder: [], sessionFor: () => undefined } as any,
      settings: { activeAgent: 'codex', update: () => {} } as any,
      config: { globalDefaults } as any,
      planStore: {} as any,
      refreshGitState: async () => {
        refreshedDirectory = globalDefaults.workingDirectory
        await refresh
        globalDefaults.gitContext = { repoRoot: '/project', branch: 'main', targetBranch: 'main' }
        return { status: true, details: true, refs: true, registration: true, ok: true }
      },
      ctxFor: () => ({ session: { provider: null } }) as any,
      loadTranscript: async () => ({ messages: [], progress: null, planIds: [] }),
    })
    let initialized = false
    const initialization = store.initStaticInfo().then(() => { initialized = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(initialized).toBe(false)
    finishRefresh()
    await initialization
    expect(globalDefaults.workingDirectory).toBe('/project')
    expect(refreshedDirectory).toBe('/project')
    expect(globalDefaults.gitContext?.targetBranch).toBe('main')
    const { homeGitDetails } = await import('../../src/renderer/components/layout/lib/new-tab-home')
    const home = homeGitDetails(
      globalDefaults.workingDirectory,
      undefined,
      globalDefaults.gitContext,
      globalDefaults.worktreeBaseBranch,
    )
    expect(home.canToggleWorktree).toBe(true)
    const { SessionEnvironmentStore } = await import('../../src/renderer/contexts/session-environment.store.svelte')
    const environmentStore = new SessionEnvironmentStore()
    environmentStore.bindWorkspace({
      activeTabId: '',
      tabOrder: [],
      globalDefaults,
      settings: { worktreeEnabled: false },
      sessionFor: () => undefined,
      ctxFor: () => ({ session: {} }),
    } as any)
    expect(environmentStore.environmentFor().name).toBe('Main')
    expect(environmentStore.environmentFor().checkout).toEqual(globalDefaults.gitContext)
  })

  test('refreshes and registers a worktree without erasing its path', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const worktreePath = '/repo/.solus-worktrees/feature'
    const session = {
      workingDirectory: '/repo',
      gitContext: { repoRoot: '/repo', branch: 'feature', targetBranch: 'main', worktreePath },
      worktreeBaseBranch: null,
    } as Session
    let registered: GitCheckout | null = null
    const state: GitState = {
      repoRoot: '/repo',
      headSha: 'abc123',
      branch: 'feature-updated',
      targetBranch: 'main',
      uncommittedChanges: { files: [], hasMoreFiles: false, insertions: 0, deletions: 0, mergeInProgress: false },
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { solus: {
        gitRefreshState: async () => state,
        gitRegisterEnvironment: async (_ctx: unknown, _cwd: string, gitContext: GitCheckout | null) => { registered = gitContext },
      } },
    })
    const { SessionEnvironmentStore } = await import('../../src/renderer/contexts/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()
    const workspace = {
      activeTabId: 'tab-1',
      tabOrder: ['tab-1'],
      globalDefaults: { workingDirectory: '/repo', gitContext: null },
      settings: { worktreeEnabled: false },
      sessionFor: () => session,
      ctxFor: () => ({ session: {} }),
    } as any
    const result = await store.refreshTab(workspace, { tabId: 'tab-1' })
    expect(result.ok).toBe(true)
    expect(session.gitContext).toEqual({ repoRoot: '/repo', branch: 'feature-updated', targetBranch: 'main', worktreePath })
    expect(registered).toEqual(session.gitContext)
  })

  test('live Git state is authoritative over the attached session snapshot', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const worktreePath = '/repo/.solus-worktrees/feature'
    const attachedCheckout: GitCheckout = {
      repoRoot: '/repo',
      branch: 'stale-branch',
      targetBranch: 'main',
      worktreePath,
    }
    const session = {
      workingDirectory: '/repo',
      gitContext: attachedCheckout,
      worktreeBaseBranch: null,
    } as Session
    const { SessionEnvironmentStore } = await import('../../src/renderer/contexts/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()
    store.bindWorkspace({
      activeTabId: 'tab-1',
      tabOrder: ['tab-1'],
      globalDefaults: { workingDirectory: '/repo', gitContext: null, worktreeBaseBranch: null },
      settings: { worktreeEnabled: false },
      sessionFor: () => session,
      ctxFor: () => ({ session: {} }),
    } as any)
    store.set(worktreePath, {
      repoRoot: '/repo',
      headSha: 'detached-abc123',
      branch: null,
      targetBranch: 'main',
      uncommittedChanges: {
        files: [],
        hasMoreFiles: false,
        insertions: 0,
        deletions: 0,
        mergeInProgress: false,
      },
    })

    const environment = store.environmentFor('tab-1')

    expect(environment.cwd).toBe(worktreePath)
    expect(environment.checkout).toEqual({
      repoRoot: '/repo',
      branch: null,
      detachedHeadSha: 'detached-abc123',
      targetBranch: 'main',
      worktreePath,
    })
    expect(session.gitContext).toBe(attachedCheckout)
  })

  test('records a non-Git directory when the Environment panel requests details first', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { solus: { gitRefreshState: async () => null } },
    })
    const { SessionEnvironmentStore } = await import('../../src/renderer/contexts/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()

    expect(store.statusFor('/not-a-repo')).toBeUndefined()
    expect(await store.refresh('/not-a-repo', { force: true, details: true })).toBe(true)
    expect(store.statusFor('/not-a-repo')).toBeNull()
  })
})
