import { afterEach, describe, expect, test } from 'bun:test'
import { hostKey } from '../../src/client-core/host-key'
import { serverConnections } from '../../src/client-core/server-connections'
import type { IpcContext } from '../../src/shared/types'

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
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
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

    const { SessionEnvironmentStore } = await import('../../src/renderer/contexts/git/session-environment.store.svelte')
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
      { destroy: () => {}, events: { subscribe: () => () => {} } } as never,
      {
        id: 'dispatch-test-host',
        label: 'Dispatch test host',
        url: 'http://test.invalid',
        sessionToken: 'test',
        local: false,
      },
    )
    const { SessionEnvironmentStore } = await import('../../src/renderer/contexts/git/session-environment.store.svelte')
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
