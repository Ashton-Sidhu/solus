import { afterEach, describe, expect, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { gitCheckoutFromState, type GitState, type GitStateOptions, type IpcContext, type RunConfig, type Session } from '@solus/contracts/types'

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

  test('a checkout registered ahead of the refresh is not registered again', async () => {
    // WHY: a resume reads identity on its critical path and registers the
    // checkout itself. The full refresh that follows must recognise that
    // registration, or every resume costs two identical round trips.
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const state = gitState('main')
    const registrations: string[] = []
    const api = asHostApi({
      gitIdentity: async () => state,
      gitRefreshState: async () => state,
      gitRegisterEnvironment: async (_ctx: IpcContext, _cwd: string, checkout: { branch: string | null } | null) => {
        registrations.push(checkout?.branch ?? 'none')
      },
    })
    const session = { sessionId: 'session-one' } as Session
    const run = { workingDirectory: '/repo', gitContext: null, serverId: 'host-a' } as RunConfig
    const ctx = { session: { sessionId: 'session-one', workingDirectory: '/repo' } } as IpcContext
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

    await store.registerEnvironment(workspace, 'tab-one', '/repo', gitCheckoutFromState(state))
    run.gitContext = gitCheckoutFromState(state)
    const result = await store.refreshEnvironment(workspace, { force: true, level: 'details' })

    expect(result.registration).toBe(true)
    expect(registrations).toEqual(['main'])
  })

  test('refreshes racing for one session register its checkout once', async () => {
    // WHY: boot hydration and the runtime sync both refresh a restored tab
    // within the same frame. Recording the registration only after the answer
    // landed let both reach the host; the second must join the first instead.
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const state = gitState('main')
    const registrations: string[] = []
    const api = asHostApi({
      gitIdentity: async () => state,
      gitRefreshState: async () => state,
      gitRegisterEnvironment: async (_ctx: IpcContext, _cwd: string, checkout: { branch: string | null } | null) => {
        registrations.push(checkout?.branch ?? 'none')
      },
    })
    const session = { sessionId: 'session-one' } as Session
    const run = { workingDirectory: '/repo', gitContext: gitCheckoutFromState(state), serverId: 'host-a' } as RunConfig
    const workspace = {
      activeTabId: 'tab-one',
      tabOrder: ['tab-one'],
      globalDefaults: { workingDirectory: '/repo', gitContext: null },
      config: { applyGlobalStartTarget: () => {} },
      runFor: () => run,
      sessionFor: () => session,
      ctxFor: () => ({ session: { sessionId: 'session-one', workingDirectory: '/repo' } }) as IpcContext,
      apiFor: () => api,
      serverIdFor: () => 'host-a',
    }
    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()

    const results = await Promise.all([
      store.refreshEnvironment(workspace, { force: true }),
      store.refreshEnvironment(workspace, { force: true }),
    ])

    expect(results.every((result) => result.registration)).toBe(true)
    expect(registrations).toEqual(['main'])
  })
})

describe('Git environment full refresh', () => {
  function fullRefreshFixture(hostAnswersRefs: boolean) {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const state = gitState('main')
    const refs = { worktrees: [{ path: '/repo/.git/solus/worktrees/feature', branch: 'feature' }], branches: ['main', 'feature'] }
    const statusOptions: Array<GitStateOptions | undefined> = []
    let separateRefsReads = 0
    const api = asHostApi({
      gitIdentity: async () => state,
      gitRefreshState: async (_cwd: string, options?: GitStateOptions) => {
        statusOptions.push(options)
        return options?.includeRefs && hostAnswersRefs ? { ...state, refs } : state
      },
      gitRegisterEnvironment: async () => {},
      worktreeListProject: async () => { separateRefsReads += 1; return refs.worktrees },
      worktreeBranches: async () => { separateRefsReads += 1; return refs.branches },
    })
    const run = { workingDirectory: '/repo', gitContext: gitCheckoutFromState(state), serverId: 'host-a' } as RunConfig
    const workspace = {
      activeTabId: 'tab-one',
      tabOrder: ['tab-one'],
      globalDefaults: { workingDirectory: '/repo', gitContext: null },
      config: { applyGlobalStartTarget: () => {} },
      runFor: () => run,
      sessionFor: () => ({ sessionId: 'session-one' }) as Session,
      ctxFor: () => ({ session: { sessionId: 'session-one', workingDirectory: '/repo' } }) as IpcContext,
      apiFor: () => api,
      serverIdFor: () => 'host-a',
    }
    return { workspace, refs, statusOptions, separateRefsReads: () => separateRefsReads }
  }

  test('reads refs on the details round trip instead of two more calls', async () => {
    // WHY: a full refresh always wants worktrees and branches after the details
    // scan. One request that carries all three is what keeps opening a session
    // from fanning out into a chain of small reads.
    const fixture = fullRefreshFixture(true)
    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()

    const result = await store.refreshEnvironment(fixture.workspace, { force: true, level: 'full' })

    expect(result.ok).toBe(true)
    expect(fixture.statusOptions).toEqual([undefined, { includeDetails: true, bypassCache: true, includeRefs: true }])
    expect(fixture.separateRefsReads()).toBe(0)
    expect(store.refsFor('/repo')).toEqual(fixture.refs)
    // Refs are project state, not checkout state: they must not land in status.
    expect(store.statusFor('/repo')).not.toHaveProperty('refs')
  })

  test('falls back to separate refs reads on a host that answers without them', async () => {
    // WHY: a client may connect to an older host. The picker still needs its
    // branches, so the old two-call path stays behind the new one.
    const fixture = fullRefreshFixture(false)
    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()

    const result = await store.refreshEnvironment(fixture.workspace, { force: true, level: 'full' })

    expect(result.ok).toBe(true)
    expect(fixture.separateRefsReads()).toBe(2)
    expect(store.refsFor('/repo')).toEqual(fixture.refs)
  })
})
