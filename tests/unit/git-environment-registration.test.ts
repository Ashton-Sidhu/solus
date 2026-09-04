import { afterEach, describe, expect, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import type { GitState, IpcContext, RunConfig, Session } from '@solus/contracts/types'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

function gitState(branch: string): GitState {
  return {
    repoRoot: '/repo',
    headSha: `head-${branch}`,
    branch,
    targetBranch: 'main',
    upstreamRef: null,
    aheadCount: 0,
    behindCount: 0,
    uncommittedChanges: {
      files: [],
      hasMoreFiles: false,
      insertions: 0,
      deletions: 0,
      mergeInProgress: false,
    },
  }
}

describe('Git environment registration', () => {
  test('reports only checkout identity changes and restores state after reconnect', async () => {
    // WHY: status refreshes are frequent and describe mutable files, but the
    // server's session-to-checkout registration changes far less often.
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    let currentState = gitState('main')
    const registrations: string[] = []
    let registrationFailure: Error | undefined
    const api = asHostApi({
      gitIdentity: async () => currentState,
      gitRefreshState: async () => currentState,
      gitRegisterEnvironment: async (_ctx: IpcContext, _cwd: string, checkout: { branch: string | null } | null) => {
        registrations.push(checkout?.branch ?? 'none')
        if (registrationFailure) {
          const error = registrationFailure
          registrationFailure = undefined
          throw error
        }
      },
    })
    const session = { sessionId: 'session-one' } as Session
    const run = {
      workingDirectory: '/repo',
      gitContext: null,
      serverId: 'host-a',
    } as RunConfig
    const ctx = {
      session: { sessionId: 'session-one', projectPath: '/repo', workingDirectory: '/repo' },
      window: {},
      settings: {},
      statusBar: {},
    } as IpcContext
    const workspace = {
      activeTabId: 'tab-one',
      tabOrder: ['tab-one'],
      globalDefaults: { workingDirectory: '/repo', gitContext: null },
      config: { applyGlobalStartTarget: () => {} },
      runFor: () => run,
      sessionFor: () => session,
      ctxFor: () => ctx,
      apiFor: () => api,
      serverIdFor: () => 'host-a',
    }
    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()

    await store.refreshEnvironment(workspace, { force: true })
    await store.refreshEnvironment(workspace, { force: true })
    currentState = gitState('feature')
    await store.refreshEnvironment(workspace, { force: true })
    store.invalidateRegistrationsForHost('host-a')
    await store.refreshEnvironment(workspace, { force: true })
    currentState = gitState('retry')
    registrationFailure = new Error('offline')
    const failed = await store.refreshEnvironment(workspace, { force: true })
    const retried = await store.refreshEnvironment(workspace, { force: true })

    expect(registrations).toEqual(['main', 'feature', 'feature', 'retry', 'retry'])
    expect(failed.registration).toBe(false)
    expect(retried.registration).toBe(true)
  })
})
