import { afterEach, describe, expect, test } from 'bun:test'
import type { HostApi } from '@solus/client-core/host-api'
import { hostKey } from '@solus/client-core/host-key'
import { serverConnections } from '@solus/client-core/server-connections'
import type { GitCheckout, GitState, Session } from '@solus/contracts/types'

const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

describe('Git state initialization', () => {
  test('keeps the same path distinct on two hosts', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()
    const cwd = '/workspace'
    const apiA: HostApi = {} as never
    const apiB: HostApi = {} as never
    const state = (headSha: string): GitState => ({
      repoRoot: cwd,
      headSha,
      branch: 'main',
      targetBranch: 'main',
      uncommittedChanges: { files: [], hasMoreFiles: false, insertions: 0, deletions: 0, mergeInProgress: false },
    })

    store.bindCwd('host-a', cwd, apiA)
    store.set(cwd, state('head-a'))
    store.bindCwd('host-b', cwd, apiB)
    store.set(cwd, state('head-b'))

    // WHY: path strings are display data. Two machines can use the same path
    // for unrelated repositories, and neither answer may overwrite the other.
    expect(store.byCwd[hostKey('host-a', cwd)]?.headSha).toBe('head-a')
    expect(store.byCwd[hostKey('host-b', cwd)]?.headSha).toBe('head-b')
    expect(store.statusFor(cwd)?.headSha).toBe('head-b')
    store.bindCwd('host-a', cwd, apiA)
    expect(store.statusFor(cwd)?.headSha).toBe('head-a')
  })

  test('starts new windows in the server workspace instead of its projects root', async () => {
    const { startDirectoryForServer } = await import('@solus/workspace-ui/contexts/workspace/workspace-lifecycle.store.svelte')
    const startInfo = {
      version: 'test',
      projectPath: '/var/lib/solus',
      homePath: '/home/sidhu',
      workspacePath: '/home/sidhu/.solus/my-workspace',
      agents: [],
    }

    expect(startDirectoryForServer(startInfo)).toBe('/home/sidhu/.solus/my-workspace')
    expect(startDirectoryForServer({ ...startInfo, workspacePath: '' })).toBe('/var/lib/solus')
  })

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
    serverConnections.registerPrimary(
      'test-primary',
      window.solus as never,
      { destroy: () => {}, attachDialOutcomeReporter: () => {}, events: { subscribe: () => () => {} } } as never,
      {
        id: 'test-primary',
        label: 'Test primary',
        url: 'http://test.invalid',
        sessionToken: 'test',
        local: false,
      },
    )
    let finishRefresh!: () => void
    const refresh = new Promise<void>((resolve) => { finishRefresh = resolve })
    const { WorkspaceLifecycleStore } = await import('@solus/workspace-ui/contexts/workspace/workspace-lifecycle.store.svelte')
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
      settings: { activeAgent: 'codex', defaultModels: {}, update: () => {} } as any,
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
      rebuildAgentConversations: () => {},
    })
    let initialized = false
    const initialization = store.initStaticInfo().then(() => { initialized = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(initialized).toBe(false)
    finishRefresh()
    await initialization
    expect(globalDefaults.workingDirectory).toBe('/my-workspace')
    expect(refreshedDirectory).toBe('/my-workspace')
    expect(globalDefaults.gitContext?.targetBranch).toBe('main')
    const { homeGitDetails } = await import('@solus/workspace-ui/lib/git-context')
    const home = homeGitDetails(
      globalDefaults.workingDirectory,
      undefined,
      globalDefaults.gitContext,
    )
    expect(home.canToggleWorktree).toBe(true)
    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const environmentStore = new SessionEnvironmentStore()
    environmentStore.bindWorkspace({
      activeTabId: '',
      tabOrder: [],
      globalDefaults,
      settings: { worktreeEnabled: false },
      runFor: () => undefined,
      sessionFor: () => undefined,
      ctxFor: () => ({ session: {} }),
    } as any)
    expect(environmentStore.environmentFor().name).toBe('Main')
    expect(environmentStore.environmentFor().checkout).toEqual(globalDefaults.gitContext)
  })

  test('keeps new-worktree mode available from an existing worktree', async () => {
    const { homeGitDetails } = await import('@solus/workspace-ui/lib/git-context')
    const home = homeGitDetails(
      '/project/.solus-worktrees/current',
      {
        repoRoot: '/project',
        branch: 'solus/current-12345',
        targetBranch: 'main',
        worktreePath: '/project/.solus-worktrees/current',
      },
      null,
    )

    // WHY: a worktree is a checkout, not a base restriction. A new session can
    // start in a sibling worktree as long as the repository default is known.
    expect(home.canToggleWorktree).toBe(true)
    expect(home.baseBranch).toBe('main')
    expect(home.projectRoot).toBe('/project')
  })

  test('refreshes and registers a worktree without erasing its path', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const worktreePath = '/repo/.solus-worktrees/feature'
    const session = {
      run: {
        serverId: 'test-host',
        workingDirectory: '/repo',
        gitContext: { repoRoot: '/repo', branch: 'feature', targetBranch: 'main', worktreePath },
        worktreeBaseBranch: null,
      } as Session['run'],
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
    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()
    const workspace = {
      activeTabId: 'tab-1',
      tabOrder: ['tab-1'],
      globalDefaults: { workingDirectory: '/repo', gitContext: null },
      settings: { worktreeEnabled: false },
      runFor: () => session.run,
      sessionFor: () => session,
      apiFor: () => window.solus,
      ctxFor: () => ({ session: {} }),
    } as any
    const result = await store.refreshEnvironment(workspace, { sourceId: 'tab-1' })
    expect(result.ok).toBe(true)
    expect(session.run.gitContext).toEqual({ repoRoot: '/repo', branch: 'feature-updated', targetBranch: 'main', worktreePath })
    expect(registered).toEqual(session.run.gitContext)
  })

  test('groups a cold session by identity before the working-tree scan returns', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const session = {
      run: {
        serverId: 'test-host',
        workingDirectory: '/repo',
        gitContext: null,
        worktreeBaseBranch: null,
      } as Session['run'],
    } as Session
    let finishStatus!: () => void
    const statusPending = new Promise<void>((resolve) => { finishStatus = resolve })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { solus: {
        gitIdentity: async () => ({
          repoRoot: '/repo',
          headSha: 'abc123',
          branch: 'feature',
          targetBranch: 'main',
        }),
        gitRefreshState: async () => {
          await statusPending
          return {
            repoRoot: '/repo',
            headSha: 'def456',
            branch: 'feature',
            targetBranch: 'main',
            uncommittedChanges: { files: [{ path: 'a.ts', conflicted: false }], hasMoreFiles: false, insertions: 3, deletions: 1, mergeInProgress: false },
          } satisfies GitState
        },
        gitRegisterEnvironment: async () => {},
      } },
    })
    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()
    const workspace = {
      activeTabId: 'tab-1',
      tabOrder: ['tab-1'],
      globalDefaults: { workingDirectory: '/repo', gitContext: null },
      settings: { worktreeEnabled: false },
      runFor: () => session.run,
      sessionFor: () => session,
      apiFor: () => window.solus,
      ctxFor: () => ({ session: {} }),
    } as any

    const refresh = store.refreshEnvironment(workspace, { sourceId: 'tab-1' })
    // Let the identity round-trip settle while the status scan is still blocked.
    for (let i = 0; i < 10; i++) await Promise.resolve()

    // The sidebar can already place this session under /repo › feature.
    expect(session.run.gitContext).toEqual({ repoRoot: '/repo', branch: 'feature', targetBranch: 'main' })
    // …but nothing claims to know whether the working tree is clean yet.
    expect(store.statusFor('/repo')).toBeUndefined()

    finishStatus()
    expect((await refresh).ok).toBe(true)
    expect(session.run.gitContext).toEqual({ repoRoot: '/repo', branch: 'feature', targetBranch: 'main' })
    expect(store.statusFor('/repo')?.uncommittedChanges.files).toHaveLength(1)
  })

  test('applies a tab-less resolved target through session config', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const state: GitState = {
      repoRoot: '/repo',
      headSha: 'abc123',
      branch: 'main',
      targetBranch: 'main',
      uncommittedChanges: { files: [], hasMoreFiles: false, insertions: 0, deletions: 0, mergeInProgress: false },
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { solus: {
        gitIdentity: async () => ({ repoRoot: '/repo', headSha: 'abc123', branch: 'main', targetBranch: 'main' }),
        gitRefreshState: async () => state,
      } },
    })
    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()
    const primaryApi: HostApi = serverConnections.registerPrimary(
      'test-primary',
      window.solus as never,
      { destroy: () => {}, attachDialOutcomeReporter: () => {}, events: { subscribe: () => () => {} } } as never,
      {
        id: 'test-primary',
        label: 'Test primary',
        url: 'http://test.invalid',
        sessionToken: 'test',
        local: false,
      },
    ).api as never
    const globalDefaults = {
      workingDirectory: '/repo',
      gitContext: null as GitCheckout | null,
      worktreeBaseBranch: null as string | null,
    }
    const appliedTargets: Array<{ gitContext: GitCheckout | null; worktreeBaseBranch: string | null }> = []
    const workspace = {
      activeTabId: '',
      tabOrder: [],
      globalDefaults,
      config: { applyGlobalStartTarget: (target: typeof appliedTargets[number]) => appliedTargets.push(target) },
      settings: { worktreeEnabled: false },
      runFor: () => undefined,
      sessionFor: () => undefined,
      apiFor: () => primaryApi,
      ctxFor: () => ({ session: {} }),
    } as any

    const result = await store.refreshEnvironment(workspace)

    expect(result.ok).toBe(true)
    // Two applies, identical: identity lands the start target before the
    // working-tree scan so the zero-tab home can offer its worktree toggle
    // immediately, then the authoritative pass confirms the same values.
    const startTarget = {
      gitContext: { repoRoot: '/repo', branch: 'main', targetBranch: 'main' },
      worktreeBaseBranch: null,
    }
    expect(appliedTargets).toEqual([startTarget, startTarget])
    expect(globalDefaults.gitContext).toBeNull()
  })

  test('reads a draft opened on another host from that host', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    // A draft: a run config with nowhere to run yet, and no session behind it.
    const draftRun = {
      serverId: 'studio',
      workingDirectory: '/studio/dotfiles',
      gitContext: null,
      worktreeBaseBranch: null,
    } as unknown as Session['run']
    const remoteState: GitState = {
      repoRoot: '/studio/dotfiles',
      headSha: 'abc123',
      branch: 'main',
      targetBranch: 'main',
      uncommittedChanges: { files: [], hasMoreFiles: false, insertions: 0, deletions: 0, mergeInProgress: false },
    }
    let registered = false
    const remoteApi = {
      gitIdentity: async () => ({ repoRoot: '/studio/dotfiles', headSha: 'abc123', branch: 'main', targetBranch: 'main' }),
      gitRefreshState: async () => remoteState,
      gitRegisterEnvironment: async () => { registered = true },
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      // This machine has never heard of the directory, and must not be asked.
      value: { solus: {
        gitIdentity: async () => null,
        gitRefreshState: async () => null,
        gitRegisterEnvironment: async () => { registered = true },
      } },
    })
    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()
    const workspace = {
      activeTabId: 'tab-1',
      tabOrder: ['tab-1'],
      globalDefaults: { workingDirectory: '/repo', gitContext: null, worktreeBaseBranch: null },
      settings: { worktreeEnabled: false },
      runFor: (sourceId: string) => (sourceId === 'draft-1' ? draftRun : undefined),
      sessionFor: () => undefined,
      apiFor: () => remoteApi,
      ctxFor: () => ({ session: {} }),
    } as any

    const result = await store.refreshEnvironment(workspace, { sourceId: 'draft-1' })

    // WHY: the directory exists on the other machine and nowhere else, so the
    // question goes to the host the run names. Asking this one answers "not a
    // repository", which hides every control describing the destination — the
    // Run on picker among them.
    expect(result.ok).toBe(true)
    expect(draftRun.gitContext).toEqual({ repoRoot: '/studio/dotfiles', branch: 'main', targetBranch: 'main' })
    // WHY: there is no session for the host to hold an environment against, and
    // nothing is running in it — registration waits for Send to make one.
    expect(registered).toBe(false)
  })

  test('a source pointed elsewhere mid-refresh keeps the project it moved to', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const draftRun = {
      serverId: 'test-host',
      workingDirectory: '/studio/dotfiles',
      gitContext: null,
      worktreeBaseBranch: null,
    } as unknown as Session['run']
    let finishStatus!: () => void
    const statusPending = new Promise<void>((resolve) => { finishStatus = resolve })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { solus: {
        gitIdentity: async () => null,
        gitRefreshState: async () => {
          await statusPending
          return {
            repoRoot: '/studio/dotfiles',
            headSha: 'abc123',
            branch: 'main',
            targetBranch: 'main',
            uncommittedChanges: { files: [], hasMoreFiles: false, insertions: 0, deletions: 0, mergeInProgress: false },
          } satisfies GitState
        },
      } },
    })
    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()
    const workspace = {
      activeTabId: 'tab-1',
      tabOrder: ['tab-1'],
      globalDefaults: { workingDirectory: '/repo', gitContext: null, worktreeBaseBranch: null },
      settings: { worktreeEnabled: false },
      runFor: () => draftRun,
      sessionFor: () => undefined,
      apiFor: () => window.solus,
      ctxFor: () => ({ session: {} }),
    } as any

    const refresh = store.refreshEnvironment(workspace, { sourceId: 'draft-1' })
    // The user picks another project while the host is still answering.
    draftRun.workingDirectory = '/studio/other'
    finishStatus()
    const result = await refresh

    // WHY: the late answer describes a directory the source has left. Landing it
    // would label the new project with the old one's branch and start the
    // session there.
    expect(result.ok).toBe(false)
    expect(draftRun.gitContext).toBeNull()
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
      run: {
        workingDirectory: '/repo',
        gitContext: attachedCheckout,
        worktreeBaseBranch: null,
      } as Session['run'],
    } as Session
    const {
      SessionEnvironmentStore,
      environmentBranchKey,
      environmentProjectKey,
    } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()
    store.bindWorkspace({
      activeTabId: 'tab-1',
      tabOrder: ['tab-1'],
      globalDefaults: { workingDirectory: '/repo', gitContext: null, worktreeBaseBranch: null },
      settings: { worktreeEnabled: false },
      runFor: () => session.run,
      sessionFor: () => session,
      ctxFor: () => ({ session: {} }),
    } as any)
    store.bindCwd('test-host', worktreePath, {} as never)
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

    const environment = store.environmentFor(session.run)

    expect(environment.cwd).toBe(worktreePath)
    expect(environment.checkout).toEqual({
      repoRoot: '/repo',
      branch: null,
      detachedHeadSha: 'detached-abc123',
      targetBranch: 'main',
      worktreePath,
    })
    expect(environmentProjectKey(environment)).toBe('/repo')
    expect(environmentBranchKey(environment)).toBe('/repo::no branch (worktree)')
    expect(session.run.gitContext).toBe(attachedCheckout)
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
    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()
    store.bindCwd('test-host', '/not-a-repo', window.solus as never)

    expect(store.statusFor('/not-a-repo')).toBeUndefined()
    expect(await store.refresh('/not-a-repo', { force: true, details: true })).toBe(true)
    expect(store.statusFor('/not-a-repo')).toBeNull()
  })
})
