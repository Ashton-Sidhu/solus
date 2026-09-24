import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { asHostApi, type HostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { gitCheckoutFromState, type GitState, type GitStateOptions, type IpcContext, type RunConfig, type Session } from '@solus/contracts/types'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  mock.restore()
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

/** The workspace's surface for its one source. Git reads go to the host's own
 *  connection, so that connection serves the same fake. */
function servedBy(api: HostApi): () => HostApi {
  spyOn(serverConnections, 'apiFor').mockReturnValue(api)
  return () => api
}

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
  test("a new worktree starts from the organization's default branch for the project", async () => {
    // WHY: docs/plans/project-model.md §7 — a member sets the branch every new
    // worktree of a cloud project starts from; the host's detected default
    // applies only when nobody set one.
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value })
    const api = asHostApi({
      gitIdentity: async () => gitState('main'),
      gitRefreshState: async () => gitState('main'),
    })
    const run = { workingDirectory: '/repo', gitContext: null, serverId: 'host-a', worktree: { baseBranch: null } } as RunConfig
    const workspace = {
      activeTabId: 'draft',
      tabOrder: [],
      defaultRunConfig: { workingDirectory: '/repo', gitContext: null, serverId: 'host-a', worktree: null } as RunConfig,
      runFor: () => run,
      sessionFor: () => undefined,
      ctxFor: () => ({ session: { sessionId: '' } }) as IpcContext,
      apiFor: servedBy(api),
      serverIdFor: () => 'host-a',
      projectDefaultBranchFor: () => 'develop',
    }
    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    await new SessionEnvironmentStore().refreshEnvironment(workspace, { force: true })

    expect(run.worktree).toEqual({ baseBranch: 'develop' })
  })

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
      defaultRunConfig: { workingDirectory: '/repo', gitContext: null, serverId: 'host-a', worktree: null } as RunConfig,
      runFor: () => run,
      sessionFor: () => session,
      ctxFor: () => ctx,
      apiFor: servedBy(api),
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
      defaultRunConfig: { workingDirectory: '/repo', gitContext: null, serverId: 'host-a', worktree: null } as RunConfig,
      runFor: () => run,
      sessionFor: () => session,
      ctxFor: () => ctx,
      apiFor: servedBy(api),
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
      defaultRunConfig: { workingDirectory: '/repo', gitContext: null, serverId: 'host-a', worktree: null } as RunConfig,
      runFor: () => run,
      sessionFor: () => session,
      ctxFor: () => ({ session: { sessionId: 'session-one', workingDirectory: '/repo' } }) as IpcContext,
      apiFor: servedBy(api),
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

describe('Git environment reuse when a tab opens', () => {
  test('a tab opened on a checkout another session runs in does not read it again', async () => {
    // WHY: the host watches every registered checkout and pushes its status, so
    // a second tab on the same project, worktree, and branch already holds a
    // live answer. A different directory, or a host that forgot its
    // registrations, still needs a real read.
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const reads: string[] = []
    const api = asHostApi({
      gitIdentity: async () => gitState('main'),
      gitRefreshState: async (cwd: string) => { reads.push(cwd); return gitState('main') },
      gitRegisterEnvironment: async () => {},
    })
    const runs: Record<string, RunConfig> = {
      first: { workingDirectory: '/repo', gitContext: null, serverId: 'host-a' } as RunConfig,
      second: { workingDirectory: '/repo', gitContext: null, serverId: 'host-a' } as RunConfig,
      other: { workingDirectory: '/other', gitContext: null, serverId: 'host-a' } as RunConfig,
      third: { workingDirectory: '/repo', gitContext: null, serverId: 'host-a' } as RunConfig,
    }
    const sessions: Record<string, Session> = {
      first: { sessionId: 'first' } as Session,
      second: { sessionId: 'second' } as Session,
      other: { sessionId: 'other' } as Session,
      third: { sessionId: 'third' } as Session,
    }
    const workspace = {
      activeTabId: 'first',
      tabOrder: Object.keys(runs),
      defaultRunConfig: { workingDirectory: '/repo', gitContext: null, serverId: 'host-a', worktree: null } as RunConfig,
      runFor: (tabId: string) => runs[tabId],
      sessionFor: (tabId: string) => sessions[tabId],
      ctxFor: (tabId: string) => ({ session: { sessionId: tabId } }) as IpcContext,
      apiFor: servedBy(api),
      serverIdFor: () => 'host-a',
    }
    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()

    await store.refreshEnvironment(workspace, { sourceId: 'first', force: false })
    const second = await store.refreshEnvironment(workspace, { sourceId: 'second', force: false })
    await store.refreshEnvironment(workspace, { sourceId: 'other', force: false })
    // A restarted host watches nothing, so the next open reads once the last
    // read is older than the store's freshness window.
    store.invalidateRegistrationsForHost('host-a')
    const now = Date.now()
    spyOn(Date, 'now').mockReturnValue(now + 3_000)
    await store.refreshEnvironment(workspace, { sourceId: 'third', force: false })

    expect(reads).toEqual(['/repo', '/other', '/repo'])
    expect(second.ok).toBe(true)
    expect(runs.second.gitContext?.branch).toBe('main')
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
      defaultRunConfig: { workingDirectory: '/repo', gitContext: null, serverId: 'host-a', worktree: null } as RunConfig,
      runFor: () => run,
      sessionFor: () => ({ sessionId: 'session-one' }) as Session,
      ctxFor: () => ({ session: { sessionId: 'session-one', workingDirectory: '/repo' } }) as IpcContext,
      apiFor: servedBy(api),
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
    expect(store.refsFor('host-a', '/repo')).toEqual(fixture.refs)
    // Refs are project state, not checkout state: they must not land in status.
    expect(store.statusFor('host-a', '/repo')).not.toHaveProperty('refs')
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
    expect(store.refsFor('host-a', '/repo')).toEqual(fixture.refs)
  })
})

describe('Git environment on a tab switch', () => {
  function registeredTabFixture() {
    ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
      <T>(value: T) => value,
      { snapshot: <T>(value: T) => value },
    )
    const reads: Array<GitStateOptions | undefined> = []
    const api = asHostApi({
      gitIdentity: async () => gitState('main'),
      gitRefreshState: async (_cwd: string, options?: GitStateOptions) => { reads.push(options); return gitState('main') },
      gitRegisterEnvironment: async () => {},
    })
    const run = { workingDirectory: '/repo', gitContext: null, serverId: 'host-a' } as RunConfig
    const session = { sessionId: 'only' } as Session
    const workspace = {
      activeTabId: 'only',
      tabOrder: ['only'],
      defaultRunConfig: { workingDirectory: '/repo', gitContext: null, serverId: 'host-a', worktree: null } as RunConfig,
      runFor: () => run,
      sessionFor: () => session,
      ctxFor: () => ({ session: { sessionId: 'only' } }) as IpcContext,
      apiFor: servedBy(api),
      serverIdFor: () => 'host-a',
    }
    return { workspace, reads }
  }

  test('a checkout the host watches is read from the store, including by the tab registered on it', async () => {
    // WHY: every mounted tab surface used to re-read Git when the active tab
    // changed. The host pushes the status of every registered checkout, so a
    // tab returning to its own checkout has nothing to ask for.
    const { workspace, reads } = registeredTabFixture()
    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()
    store.bindWorkspace(workspace)
    await store.refreshEnvironment(workspace, { sourceId: 'only', force: false })
    const readsAfterOpen = reads.length

    await store.refreshEnvironment(workspace, { sourceId: 'only', force: false })
    await store.refresh('host-a', '/repo')
    expect(reads.length).toBe(readsAfterOpen)

    // After a host restart nothing is watched until the tab registers again.
    store.invalidateRegistrationsForHost('host-a')
    await store.refresh('host-a', '/repo', { force: true })
    expect(reads.length).toBe(readsAfterOpen + 1)
  })

  test('details are read again only after a status change nobody watched', async () => {
    // WHY: the host pushes status but not line counts, ahead counts, or the pull
    // request URL. A surface that mounts on a tab switch must not re-read them
    // while they are current, and must re-read them once a change made them stale.
    const { workspace, reads } = registeredTabFixture()
    const { SessionEnvironmentStore } = await import('@solus/workspace-ui/contexts/git/session-environment.store.svelte')
    const store = new SessionEnvironmentStore()
    store.bindWorkspace(workspace)
    await store.refreshEnvironment(workspace, { sourceId: 'only', level: 'details', force: false })
    const detailReads = () => reads.filter((options) => options?.includeDetails).length
    expect(detailReads()).toBe(1)

    store.watchDetails('host-a', '/repo')()
    await Bun.sleep(0)
    expect(detailReads()).toBe(1)

    store.set('host-a', '/repo', gitState('feature'))
    store.watchDetails('host-a', '/repo')()
    await Bun.sleep(0)
    expect(detailReads()).toBe(2)
  })
})
