import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { GitActionResult, GitSyncResult, Session } from '../../src/shared/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const previousWindow = globalThis.window
const previousDocument = globalThis.document
const previousState = (globalThis as unknown as { $state?: unknown }).$state
const testServerConnections = singleHostServerConnections()

mock.module('@client-core/server-connections', () => ({
  serverConnections: testServerConnections,
}))

function installState(): void {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: { documentElement: { classList: { toggle: () => {} } } },
  })
}

function sessionRun(): Session['run'] {
  return {
    workingDirectory: '/repo',
    gitContext: {
      repoRoot: '/repo',
      branch: 'feature',
      targetBranch: 'main',
    },
  } as Session['run']
}

function actionResult(): GitActionResult {
  return {
    action: 'commit_push',
    branch: { status: 'skipped' },
    commit: { status: 'created', sha: 'abc123', subject: 'fix: keep state fresh' },
    push: { status: 'pushed', branch: 'feature' },
    pullRequest: { status: 'skipped' },
  }
}

afterEach(() => {
  testServerConnections.reset()
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  if (previousDocument === undefined) delete (globalThis as unknown as { document?: Document }).document
  else Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: previousDocument })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

describe('GitActions sync', () => {
  test('refreshes Git status when pull fails after starting a conflicted merge', async () => {
    installState()
    const syncResult: GitSyncResult = { success: false, outcome: 'conflicted', error: 'pull failed with conflicts' }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        dispatchEvent: () => true,
        solus: { gitSync: async () => syncResult },
      },
    })

    const { GitActions } = await import('../../src/renderer/lib/git-actions.svelte')
    const run = sessionRun()
    const refreshes: Array<{ sourceId?: string; cwd?: string; level?: string }> = []
    const actions = new GitActions(
      {
        runFor: () => run,
        apiFor: () => window.solus,
        ctxForEnvironment: () => ({ session: { sessionId: 'tab-1' } }),
      } as any,
      'tab-1',
      {
        environmentFor: () => ({ cwd: '/repo', checkout: run.gitContext }),
        refreshEnvironment: async (_workspace, options) => {
          refreshes.push(options)
          return { status: true, details: true, refs: true, registration: true, ok: true }
        },
      } as any,
    )

    await actions.sync()

    expect(actions.syncError).toBe(syncResult.error)
    expect(refreshes).toEqual([{ sourceId: 'tab-1', cwd: '/repo', level: 'details' }])
  })
})

describe('GitActions unified action', () => {
  test('cleans up and refreshes live Git state when the transport rejects', async () => {
    installState()
    const solus = {
      gitRunAction: async () => { throw new Error('transport disconnected') },
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        dispatchEvent: () => true,
        solus,
      },
    })
    testServerConnections.registerPrimary('local', solus)
    const { GitActions } = await import('../../src/renderer/lib/git-actions.svelte')
    const run = sessionRun()
    const refreshes: unknown[] = []
    const actions = new GitActions(
      {
        runFor: () => run,
        apiFor: () => window.solus,
        ctxForEnvironment: () => ({ session: { sessionId: 'tab-1' } }),
      } as any,
      'tab-1',
      {
        environmentFor: () => ({ cwd: '/repo', checkout: run.gitContext }),
        refreshEnvironment: async (_workspace: unknown, options: unknown) => {
          refreshes.push(options)
          return { status: true, details: true, refs: true, registration: true, ok: true }
        },
        statusFor: () => null,
      } as any,
    )

    await actions.run('commit_push')

    expect(actions.running).toBe(false)
    expect(actions.actionError).toBe('transport disconnected')
    expect(refreshes).toEqual([{ sourceId: 'tab-1', cwd: '/repo', level: 'details' }])
  })

  test('runs the selected environment action when no chat tab exists', async () => {
    installState()
    let receivedCtx: any
    let receivedRequest: any
    const solus = {
      gitRunAction: async (ctx: unknown, request: unknown) => {
        receivedCtx = ctx
        receivedRequest = request
        return actionResult()
      },
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        dispatchEvent: () => true,
        solus,
      },
    })
    testServerConnections.registerPrimary('local', solus)
    const { GitActions } = await import('../../src/renderer/lib/git-actions.svelte')
    const checkout = {
      repoRoot: '/repo',
      worktreePath: '/repo/.solus-worktrees/feature',
      branch: 'feature',
      targetBranch: 'main',
    }
    const actions = new GitActions(
      {
        runFor: () => undefined,
        apiFor: () => window.solus,
        globalDefaults: { workingDirectory: '/repo', gitContext: checkout },
        ctxForEnvironment: (cwd: string, gitContext: unknown, sourceId: string) => ({
          session: { sessionId: sourceId, workingDirectory: cwd, gitContext },
        }),
      } as any,
      '',
      {
        environmentFor: () => ({ cwd: checkout.worktreePath, checkout }),
        refreshEnvironment: async () => ({ status: true, details: true, refs: true, registration: true, ok: true }),
        statusFor: () => null,
      } as any,
    )

    await actions.run('commit_push_pull_request', { createFeatureBranch: true })

    expect(receivedCtx.session).toEqual({
      sessionId: '',
      workingDirectory: checkout.worktreePath,
      gitContext: checkout,
    })
    expect(receivedRequest).toMatchObject({
      action: 'commit_push_pull_request',
      createFeatureBranch: true,
    })
    expect(typeof receivedRequest.actionId).toBe('string')
  })
})
