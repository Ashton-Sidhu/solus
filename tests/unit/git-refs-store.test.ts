import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { hostKey } from '@solus/client-core/host-key'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HostApi } from '@solus/client-core/host-api'
import type { IpcContext } from '@solus/contracts/types'

const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state

/** Serve each host's reads from its own fake connection. */
function stubHosts(apis: Record<string, unknown>): void {
  spyOn(serverConnections, 'apiFor').mockImplementation((serverId: string) => apis[serverId] as HostApi)
}

afterEach(() => {
  mock.restore()
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
    stubHosts({ 'test-host': window.solus })
    store.refsByRoot[hostKey('test-host', '/repo')] = {
      worktrees: [{ path: '/repo/.worktrees/existing', branch: 'existing' }],
      branches: ['main'],
    }

    const ok = await store.refreshRefs('test-host', '/repo', { session: {} } as IpcContext, { force: true })

    expect(ok).toBe(false)
    expect(store.refsFor('test-host', '/repo')).toEqual({
      worktrees: [{ path: '/repo/.worktrees/existing', branch: 'existing' }],
      branches: ['main', 'feature'],
    })
  })

  test('keeps two hosts with the same path apart', async () => {
    // WHY: `/workspace/app` on a laptop and on a Linux box are different
    // checkouts. A lookup by path alone answered with whichever host bound the
    // path last, so one machine showed the other's branches.
    Object.defineProperty(globalThis, '$state', {
      configurable: true,
      writable: true,
      value: Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value }),
    })
    const hostWith = (branch: string) => ({
      worktreeListProject: async () => [],
      worktreeBranches: async () => [branch],
    })
    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()
    stubHosts({ 'host-a': hostWith('laptop-branch'), 'host-b': hostWith('linux-branch') })

    await store.refreshRefs('host-a', '/workspace/app', { session: {} } as IpcContext, { force: true })
    await store.refreshRefs('host-b', '/workspace/app', { session: {} } as IpcContext, { force: true })

    expect(store.refsFor('host-a', '/workspace/app').branches).toEqual(['laptop-branch'])
    expect(store.refsFor('host-b', '/workspace/app').branches).toEqual(['linux-branch'])
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
    stubHosts({ 'loading-host': api })

    expect(store.refsLoadingFor('loading-host', '/repo')).toBe(false)
    const refresh = store.refreshRefs('loading-host', '/repo', { session: {} } as IpcContext, { force: true })
    expect(store.refsLoadingFor('loading-host', '/repo')).toBe(true)

    finishBranchLoad(['main', 'feature'])
    expect(await refresh).toBe(true)
    expect(store.refsLoadingFor('loading-host', '/repo')).toBe(false)
    expect(store.refsFor('loading-host', '/repo').branches).toEqual(['main', 'feature'])
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
        { path: `${repoRoot}/.git/solus/worktrees/feature`, branch: 'feature' },
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
      { path: `${repoRoot}/.git/solus/worktrees/feature`, branch: 'feature' },
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
    stubHosts({ 'host-a': api })

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
