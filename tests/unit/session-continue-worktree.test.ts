import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { GitCheckout, Session } from '@solus/contracts/types'

mock.module('@solus/workspace-ui/lib/analytics', () => ({
  identifyInstallation: () => {},
  initAnalytics: () => {},
  registerSuperProps: () => {},
  setAnalyticsEnabled: () => {},
  track: () => {},
}))

const previousAudio = globalThis.Audio
const previousCustomEvent = globalThis.CustomEvent
const previousDerived = (globalThis as unknown as { $derived?: unknown }).$derived
const previousEffect = (globalThis as unknown as { $effect?: unknown }).$effect
const previousLocalStorage = globalThis.localStorage
const previousState = (globalThis as unknown as { $state?: unknown }).$state
const previousWindow = globalThis.window
let continueInWorktree: (this: ContinueInWorktreeContext, tabId: string) => Promise<void>

interface ContinueInWorktreeContext {
  ui: {
    beginContinueInWorktree(tabId: string): void
    endContinueInWorktree(tabId: string): void
    isContinuingInWorktree(tabId: string): boolean
  }
  sessionFor(tabId: string): Session | undefined
  apiFor(tabId: string): {
    continueInWorktree(ctx: unknown, prompt: string): Promise<{ success: boolean; gitContext: GitCheckout }>
  }
  ctxFor(tabId: string): unknown
  environment: {
    refreshEnvironment(
      workspace: ContinueInWorktreeContext,
      options: { sourceId: string; level: string; force: boolean },
    ): Promise<unknown>
  }
}

beforeAll(async () => {
  ;(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(
    <T>(value: T) => value,
    { by: <T>(read: () => T) => read() },
  )
  ;(globalThis as unknown as { $effect: unknown }).$effect = Object.assign(
    () => {},
    { pre: () => {}, root: () => () => {} },
  )
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    {
      raw: <T>(value: T) => value,
      snapshot: <T>(value: T) => value,
    },
  )
  Object.defineProperty(globalThis, 'Audio', {
    configurable: true,
    value: class { volume = 1 },
  })
  Object.defineProperty(globalThis, 'CustomEvent', {
    configurable: true,
    value: class {
      constructor(_name: string, _options?: unknown) {}
    },
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      removeItem: () => {},
      setItem: () => {},
    },
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: () => {},
      dispatchEvent: () => true,
      matchMedia: () => ({
        addEventListener: () => {},
        matches: false,
        removeEventListener: () => {},
      }),
      removeEventListener: () => {},
    },
  })
  const { WorkspaceContext } = await import('@solus/workspace-ui/contexts/workspace/workspace.context.svelte')
  continueInWorktree = WorkspaceContext.prototype.continueInWorktree
})

afterAll(() => {
  for (const [name, previous] of [
    ['Audio', previousAudio],
    ['CustomEvent', previousCustomEvent],
    ['localStorage', previousLocalStorage],
    ['window', previousWindow],
  ] as const) {
    if (previous === undefined) delete (globalThis as unknown as { [key: string]: unknown })[name]
    else Object.defineProperty(globalThis, name, { configurable: true, value: previous })
  }
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
  if (previousDerived === undefined) delete (globalThis as unknown as { $derived?: unknown }).$derived
  else (globalThis as unknown as { $derived: unknown }).$derived = previousDerived
  if (previousEffect === undefined) delete (globalThis as unknown as { $effect?: unknown }).$effect
  else (globalThis as unknown as { $effect: unknown }).$effect = previousEffect
})

describe('continue session in worktree', () => {
  test('refreshes the session environment after worktree setup completes', async () => {
    // WHY: the session starts on the project checkout. Applying only the new
    // Git context leaves the environment store without the generated worktree
    // name and status until another user action causes a refresh.
    const session = {
      agentSessionId: 'provider-session',
      run: {
        workingDirectory: '/repo',
        gitContext: { repoRoot: '/repo', branch: 'main', targetBranch: 'main' },
        worktree: null,
      },
      messages: [{ id: 'user-1', role: 'user', content: 'Fix environment refresh', timestamp: 1 }],
      statusCard: null,
    } as unknown as Session
    const gitContext: GitCheckout = {
      repoRoot: '/repo',
      branch: 'solus/fix-environment-abcde',
      targetBranch: 'main',
      worktreePath: '/repo/.git/solus/worktrees/fix-environment-abcde',
    }
    const refreshes: unknown[] = []
    const context: ContinueInWorktreeContext = {
      ui: {
        beginContinueInWorktree: () => {},
        endContinueInWorktree: () => {},
        isContinuingInWorktree: () => false,
      },
      sessionFor: () => session,
      apiFor: () => ({
        continueInWorktree: async () => ({ success: true, gitContext }),
      }),
      ctxFor: () => ({}),
      environment: {
        refreshEnvironment: async (_workspace, options) => { refreshes.push(options) },
      },
    }

    await continueInWorktree.call(context, 'tab-1')

    expect(session.run.gitContext).toBe(gitContext)
    expect(refreshes).toEqual([{ sourceId: 'tab-1', level: 'full', force: true }])
  })
})
