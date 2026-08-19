import { afterEach, describe, expect, test } from 'bun:test'
import { hostKey } from '@solus/client-core/host-key'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HostApi } from '@solus/client-core/host-api'
import type { IpcContext } from '@solus/contracts/types'

const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

describe('SessionEnvironmentStore refs', () => {
  test('reports a partial refresh failure without erasing the last known worktrees', async () => {
    Object.defineProperty(globalThis, '$state', {
      configurable: true,
      writable: true,
      value: Object.assign(
        <T>(value: T) => value,
        { snapshot: <T>(value: T) => value },
      ),
    })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        solus: {
          worktreeListProject: async () => { throw new Error('worktree lookup failed') },
          worktreeBranches: async () => ['main', 'feature'],
        },
      },
    })

    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()
    store.bindCwd('test-host', '/repo', window.solus as never)
    store.refsByRoot[hostKey('test-host', '/repo')] = {
      worktrees: [{ path: '/repo/.worktrees/existing', branch: 'existing' }],
      branches: ['main'],
    }

    const ok = await store.refreshRefs('/repo', { session: {} } as IpcContext, { force: true })

    expect(ok).toBe(false)
    expect(store.refsFor('/repo')).toEqual({
      worktrees: [{ path: '/repo/.worktrees/existing', branch: 'existing' }],
      branches: ['main', 'feature'],
    })
  })

  test('reports a local refs scan as loading until the branches arrive', async () => {
    // WHY: a first scan of a cold repo is slow enough that a picker with no
    // cached refs would otherwise claim the repo has no branches.
    Object.defineProperty(globalThis, '$state', {
      configurable: true,
      writable: true,
      value: Object.assign(
        <T>(value: T) => value,
        { snapshot: <T>(value: T) => value },
      ),
    })
    let finishBranchLoad!: (branches: string[]) => void
    const branchLoad = new Promise<string[]>((resolve) => { finishBranchLoad = resolve })
    const api = {
      worktreeListProject: async () => [],
      worktreeBranches: async () => branchLoad,
    }
    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()
    store.bindCwd('loading-host', '/repo', api as never)

    expect(store.refsLoadingFor('/repo')).toBe(false)
    const refresh = store.refreshRefs('/repo', { session: {} } as IpcContext, { force: true })
    expect(store.refsLoadingFor('/repo')).toBe(true)

    finishBranchLoad(['main', 'feature'])
    expect(await refresh).toBe(true)
    expect(store.refsLoadingFor('/repo')).toBe(false)
    expect(store.refsFor('/repo').branches).toEqual(['main', 'feature'])
  })

  test('loads device-scoped target worktrees and source origin branches', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const repoRoot = '/srv/dispatch/solus'
    const branchOptions: Array<{ remoteOnly?: boolean } | undefined> = []
    let finishBranchLoad!: (branches: string[]) => void
    const branchLoad = new Promise<string[]>((resolve) => { finishBranchLoad = resolve })
    const api = {
      resolveDispatchHistoryRoots: async () => [{ repoKey: 'github.com/openai/solus', path: repoRoot }],
      worktreeListProject: async () => [
        { path: repoRoot, branch: 'main' },
        { path: `${repoRoot}/.solus-worktrees/feature`, branch: 'feature' },
      ],
      worktreeBranches: async (_ctx: IpcContext, options?: { remoteOnly?: boolean }) => {
        branchOptions.push(options)
        return branchLoad
      },
    }
    serverConnections.registerPrimary(
      'dispatch-test-host',
      api as never,
      { destroy: () => {}, attachDialOutcomeReporter: () => {}, events: { subscribe: () => () => {} } } as never,
      {
        id: 'dispatch-test-host',
        label: 'Dispatch test host',
        url: 'http://test.invalid',
        sessionToken: 'test',
        local: false,
      },
    )
    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()
    const run = {
      serverId: 'dispatch-test-host',
      workingDirectory: '/source/solus',
      gitContext: { repoRoot: '/source/solus', branch: 'main', targetBranch: 'main' },
      pendingHostDispatch: {
        serverId: 'dispatch-test-host',
        intent: 'dispatch',
        repoKey: 'github.com/openai/solus',
      },
    } as never

    const refresh = store.refreshDispatchWorktrees(
      run,
      (cwd) => ({ session: { workingDirectory: cwd } }) as IpcContext,
    )

    // WHY: origin refs can take long enough that an empty picker looks broken.
    expect(store.dispatchBranchesLoadingFor(run)).toBe(true)
    finishBranchLoad(['main', 'feature', 'release'])
    expect(await refresh).toBe(true)
    expect(store.dispatchBranchesLoadingFor(run)).toBe(false)

    // WHY: a branch appears once. An existing target worktree wins; only origin
    // branches without one remain choices for a newly-created worktree.
    expect(store.dispatchWorktreesFor(run)).toEqual([
      { path: `${repoRoot}/.solus-worktrees/feature`, branch: 'feature' },
    ])
    expect(store.dispatchBranchesFor(run)).toEqual(['main', 'release'])
    expect(branchOptions).toContainEqual({ remoteOnly: true })
  })
})

describe('SessionEnvironmentStore detail watches', () => {
  test('shares one initial detail refresh for every consumer of a checkout', async () => {
    // WHY: reactive component re-entry and multiple mounted surfaces can watch
    // the same checkout. Only the 0 -> 1 watcher transition may start host work.
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    let calls = 0
    const api = {
      gitRefreshState: async () => {
        calls += 1
        return null
      },
    }
    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()
    // SAFETY: this test exercises only gitRefreshState; the fake implements that
    // exact HostApi method and no other store path can reach the omitted methods.
    store.bindCwd('host-a', '/repo', api as HostApi)

    const stopFirst = store.watchDetails('host-a', '/repo')
    const stopSecond = store.watchDetails('host-a', '/repo')
    await Bun.sleep(0)
    expect(calls).toBe(1)

    stopFirst()
    const stopThird = store.watchDetails('host-a', '/repo')
    await Bun.sleep(0)
    expect(calls).toBe(1)

    stopSecond()
    stopThird()
    const stopAfterIdle = store.watchDetails('host-a', '/repo')
    await Bun.sleep(0)
    expect(calls).toBe(2)
    stopAfterIdle()
  })
})
