import { afterEach, describe, expect, test } from 'bun:test'
import type { GitSyncResult, Session } from '../../src/shared/types'

const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

describe('GitActions sync', () => {
  test('refreshes Git status when pull fails after starting a conflicted merge', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const syncResult: GitSyncResult = { success: false, outcome: 'conflicted', error: 'pull failed with conflicts' }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        matchMedia: () => ({
          matches: false,
          addEventListener: () => {},
        }),
        dispatchEvent: () => true,
        solus: {
          gitSync: async () => syncResult,
        },
      },
    })

    const { GitActions } = await import('../../src/renderer/lib/git-actions.svelte')
    const session = {
      workingDirectory: '/repo',
      gitContext: {
        repoRoot: '/repo',
        branch: 'feature',
        targetBranch: 'main',
      },
    } as Session
    const refreshes: Array<{ tabId?: string; cwd?: string; level?: string }> = []
    const actions = new GitActions(
      {
        sessionFor: () => session,
        ctxFor: () => ({ session: { tabId: 'tab-1' } }),
      } as any,
      'tab-1',
      {
        refreshTab: async (_workspace, options) => {
          refreshes.push(options)
          return { status: true, details: true, refs: true, registration: true, ok: true }
        },
      } as any,
    )

    await actions.sync()

    expect(actions.syncError).toBe(syncResult.error)
    expect(refreshes).toEqual([
      { tabId: 'tab-1', cwd: '/repo', level: 'details' },
    ])
  })
})

describe('GitActions commit and push', () => {
  test('cleans up and refreshes live Git state when the transport rejects', async () => {
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
        solus: { gitCommitPush: async () => { throw new Error('transport disconnected') } },
      },
    })
    const { GitActions } = await import('../../src/renderer/lib/git-actions.svelte')
    const session = {
      workingDirectory: '/repo',
      gitContext: { repoRoot: '/repo', branch: 'feature', targetBranch: 'main' },
    } as Session
    const refreshes: unknown[] = []
    const actions = new GitActions(
      { sessionFor: () => session, ctxFor: () => ({ session: { tabId: 'tab-1' } }) } as any,
      'tab-1',
      {
        refreshTab: async (_workspace: unknown, options: unknown) => {
          refreshes.push(options)
          return { status: true, details: true, refs: true, registration: true, ok: true }
        },
        statusFor: () => null,
      } as any,
    )

    await actions.commitPush()

    expect(actions.commitPushing).toBe(false)
    expect(actions.commitPushError).toBe('transport disconnected')
    expect(refreshes).toEqual([{ tabId: 'tab-1', cwd: '/repo', level: 'details' }])
  })
})
