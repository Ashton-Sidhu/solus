import { afterEach, describe, expect, test } from 'bun:test'
import { hostKey } from '../../src/client-core/host-key'
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
})
