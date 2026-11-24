import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { Codebase, CodebaseFolderScan, CodebaseMember } from '@solus/contracts/codebases'
import type { RunConfig, Session, Tab } from '@solus/contracts/types'
import type { CodebaseHostAccess, CodebaseHostApi } from '@solus/workspace-ui/contexts/codebases/codebase-host-access'
import type { IpcContextBuilderDeps } from '@solus/workspace-ui/contexts/workspace/ipc-context'
import type { StatusBarCtx } from '@solus/contracts/types'
import { startMembers } from '@solus/client-core/codebases'
import { plainFolderGetsTaskFolder, worktreeRepositoryChoice } from '@solus/workspace-ui/components/input/lib/worktree-repositories'
import { repositoriesInFolder, repositoriesInFolderLabel } from '@solus/workspace-ui/components/project-panel/lib/git-setup'
import { projectRowTrailing } from '@solus/workspace-ui/components/project-panel/lib/project-row'
import { tooltipDisplay } from '@solus/workspace-ui/components/ui/tooltip/content'
import { chooseStart, codebaseOf, folderLocation, refuseCodebase, refusesCodebase, startsWorktree } from '@solus/workspace-ui/contexts/workspace/run-location'

/**
 * The client side of decisions 13 and 14 of docs/plans/codebases.md: the
 * session event that gives the run its codebase, and what a draft reads of
 * its project folder (a project covers the repositories inside it, with no
 * codebase). The divider that the conversation shows for a codebase that the
 * host made is in `codebase-formed-divider.test.ts`.
 */

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    serverIds: () => [],
    onConnectionCreated: () => () => {},
    onReadinessChange: () => () => {},
    resolveId: (serverId: string) => serverId,
    apiFor: () => ({}),
  },
}))
// The live access reads the connection stores of the app, which a unit test does not load.
mock.module('@solus/workspace-ui/contexts/codebases/codebase-host-access', () => ({ liveCodebaseHostAccess: null }))

let CodebasesStore: typeof import('@solus/workspace-ui/contexts/codebases/codebases.store.svelte')['CodebasesStore']
let IpcContextBuilder: typeof import('@solus/workspace-ui/contexts/workspace/ipc-context')['IpcContextBuilder']
beforeAll(async () => {
  ({ CodebasesStore } = await import('@solus/workspace-ui/contexts/codebases/codebases.store.svelte'))
  ;({ IpcContextBuilder } = await import('@solus/workspace-ui/contexts/workspace/ipc-context'))
})

const previousState = (globalThis as unknown as { $state?: unknown }).$state
afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

describe('the session_codebase event', () => {
  async function reducerFor(session: Session) {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { SessionEventReducer } = await import('@solus/workspace-ui/contexts/workspace/session-event-reducer.svelte')
    const tab = { id: 'tab-1', sessionId: 'session-1' } as Tab
    const reducer = new SessionEventReducer({
      sessions: { byId: { 'session-1': session } },
      registry: { tabs: { 'tab-1': tab }, sessionFor: () => session, tabIdsBySession: new Map([['session-1', ['tab-1']]]) },
      settings: { rateLimitBehavior: 'ask' },
      log: () => {},
    } as never)
    return { reducer }
  }

  function sessionAt(path: string, status: Session['status'] = 'running'): Session {
    return { status, sessionFolders: [], run: { location: folderLocation({ serverId: 'local', path }) } as Session['run'] } as Session
  }

  // The run names the codebase from then on, so the next prompt of this client names it too.
  test('gives the run of the session the codebase', async () => {
    const session = sessionAt('/code/shop')
    const { reducer } = await reducerFor(session)
    reducer.apply('session-1', { type: 'session_codebase', codebaseId: 'shop-1', name: 'shop' })
    expect(codebaseOf(session.run)).toBe('shop-1')
  })

  // A draft that refused a codebase and then got one from the person on a different client refuses none.
  test('a run that refused a codebase has the one that the host names', async () => {
    const session = sessionAt('/code/shop')
    session.run.location = refuseCodebase(session.run.location)
    const { reducer } = await reducerFor(session)
    reducer.apply('session-1', { type: 'session_codebase', codebaseId: 'shop-1', name: 'shop' })
    expect(codebaseOf(session.run)).toBe('shop-1')
    expect(refusesCodebase(session.run)).toBe(false)
  })

  // The event comes at the start of the turn after a Stop, before the status of that turn.
  test('lands on a session that the person stopped', async () => {
    const session = sessionAt('/code/shop', 'interrupted')
    const { reducer } = await reducerFor(session)
    reducer.apply('session-1', { type: 'session_codebase', codebaseId: 'shop-1', name: 'shop' })
    expect(codebaseOf(session.run)).toBe('shop-1')
  })
})

function member(path: string, rootPath: string, patch: Partial<CodebaseMember> = {}): CodebaseMember {
  return { path, name: path.split('/').at(-1)!, state: 'git', repositoryKey: null, rootPath, discovered: path !== rootPath, hasCommit: true, submodule: false, ...patch }
}

const STORE_SCAN: CodebaseFolderScan = {
  path: '/code/store',
  state: 'plain',
  members: [member('/code/store', '/code/store', { state: 'plain' }), member('/code/store/api', '/code/store'), member('/code/store/web', '/code/store')],
  suggestions: [],
}

describe('the project folder of a draft', () => {
  function storeWith(copies: Codebase[], scans: Record<string, CodebaseFolderScan>) {
    const scanned: string[] = []
    const api: CodebaseHostApi = {
      codebaseList: async () => copies,
      codebaseSave: async (copy) => copy,
      codebaseMembers: async () => [],
      codebaseScanFolder: async (path) => {
        scanned.push(path)
        const scan = scans[path]
        if (!scan) throw new Error('The host did not answer.')
        return scan
      },
    }
    const access: CodebaseHostAccess = {
      machines: () => [{ serverId: 'laptop', installationId: 'install-laptop', label: 'Laptop', isReady: true }],
      resolveId: (installationId) => (installationId === 'install-laptop' ? 'laptop' : installationId),
      api: () => api,
      onReadinessChange: () => () => {},
      onCodebasesChanged: () => () => {},
    }
    return { store: new CodebasesStore(access, () => 1_000), scanned }
  }

  // A project covers the repositories inside it with no codebase: the scan is the list, whatever codebases exist.
  test('the store answers the scan of the folder after it was read, also for a folder that a codebase holds', async () => {
    const roots = [{ installationId: 'install-laptop', path: '/code/store', name: 'store' }, { installationId: 'install-laptop', path: '/code/ui', name: 'ui' }]
    const { store } = storeWith([{ id: 'live', name: 'store + ui', roots, updatedAt: 5, deletedAt: null }], { '/code/store': STORE_SCAN })
    await store.load('laptop')
    expect(store.projectScanAt('laptop', '/code/store')).toBeNull()
    await store.readFolder('laptop', '/code/store')
    expect(store.projectScanAt('laptop', '/code/store')).toBe(STORE_SCAN)
  })

  // A run whose codebase is deleted has none. A codebase that no host named yet is not a deleted one.
  test('the store says that a codebase is deleted only when a host named its deleted record', async () => {
    const root = { installationId: 'install-laptop', path: '/code/store', name: 'store' }
    const second = { installationId: 'install-laptop', path: '/code/ui', name: 'ui' }
    const { store } = storeWith([
      { id: 'gone', name: 'store', roots: [root, second], updatedAt: 5, deletedAt: 5 },
      { id: 'live', name: 'shop', roots: [{ ...root, path: '/code/shop' }, second], updatedAt: 5, deletedAt: null },
    ], {})
    expect(store.isDeleted('gone')).toBe(false)
    await store.load('laptop')
    expect(store.isDeleted('gone')).toBe(true)
    expect(store.isDeleted('live')).toBe(false)
    expect(store.isDeleted('not-known')).toBe(false)
  })

  test('a read that fails keeps the last answer', async () => {
    const scans: Record<string, CodebaseFolderScan> = { '/code/store': STORE_SCAN }
    const { store } = storeWith([], scans)
    await store.load('laptop')
    await store.readFolder('laptop', '/code/store')
    delete scans['/code/store']
    await store.readFolder('laptop', '/code/store')
    expect(store.projectScanAt('laptop', '/code/store')).toBe(STORE_SCAN)
  })

  // The host plans a new worktree from the repositories of the project, with no codebase. The start control shows the same list.
  test('the repositories of a new worktree are the repositories that the scan found, with no codebase', () => {
    const choice = worktreeRepositoryChoice(startMembers(STORE_SCAN.members, []), '/code/store', null)!
    expect(choice.working).toEqual({ path: '/code/store', name: 'store', isRepository: false })
    expect(choice.rows.map((row) => [row.name, row.isChosen])).toEqual([['api', true], ['web', true]])
    expect(choice.isDefault).toBe(true)
  })

  test('a codebase adds its members to the repositories of the project, each one time', () => {
    const ofCodebase = [member('/code/store', '/code/store', { state: 'plain' }), member('/code/store/api', '/code/store'), member('/code/ui', '/code/ui')]
    const members = startMembers(STORE_SCAN.members, ofCodebase)
    expect(members.map((each) => each.path)).toEqual(['/code/store', '/code/store/api', '/code/store/web', '/code/ui'])
    expect(worktreeRepositoryChoice(members, '/code/store', null)!.rows.map((row) => row.name)).toEqual(['api', 'ui', 'web'])
  })

  // The host makes a task folder for a folder with no repository only when there is a repository to isolate, or a codebase.
  test('a folder with no repository gets a new worktree only when it holds a repository or the run has a codebase', () => {
    const empty = [member('/code/notes', '/code/notes', { state: 'plain' })]
    expect(plainFolderGetsTaskFolder(STORE_SCAN.members, '/code/store', false)).toBe(true)
    expect(plainFolderGetsTaskFolder(empty, '/code/notes', false)).toBe(false)
    expect(plainFolderGetsTaskFolder(empty, '/code/notes', true)).toBe(true)
    // A repository is not a folder with no repository, and a folder that was not read is not known.
    expect(plainFolderGetsTaskFolder([member('/code/api', '/code/api')], '/code/api', true)).toBe(false)
    expect(plainFolderGetsTaskFolder([], '/code/store', true)).toBe(false)
  })

  test('"No codebase" reaches the host with the prompt, and a run that refuses none sends nothing', () => {
    const contextOf = (location: RunConfig['location']) => {
      const run = { location, permissionMode: 'full-access', provider: 'codex', modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false } } as unknown as RunConfig
      const deps = {
        sessionFor: () => undefined, runFor: () => run, hasDraft: () => false, defaultRunConfig: () => run,
        settings: { ctx: {} },
        statusBar: { ctx: {} as StatusBarCtx, ctxFor: () => ({}) as StatusBarCtx, ctxForRun: () => ({}) as StatusBarCtx },
      } as unknown as IpcContextBuilderDeps
      return new IpcContextBuilder(deps).sessionCtx('draft')
    }
    const location = chooseStart(folderLocation({ serverId: 'host', path: '/code/store' }), { kind: 'new-worktree', baseBranch: 'main' })
    const refused = contextOf(refuseCodebase(location))
    expect(refused).toMatchObject({ codebaseId: null, noCodebase: true })
    // The request for a new worktree stays: "No codebase" changes only the codebase.
    expect(startsWorktree({ location: refuseCodebase(location) })).toBe(true)
    expect('noCodebase' in contextOf(location)).toBe(false)
  })
})

describe('the standing Git section of a folder with no repository', () => {
  const folders = [
    { path: '/code/shop/api', state: 'git' as const },
    { path: '/code/shop/web', state: 'git' as const },
    { path: '/code/shop/notes', state: 'plain' as const },
    { path: '/code/libs/ui', state: 'git' as const },
  ]

  // A folder that holds repositories is not a project that lacks Git: the section names the repositories.
  test('counts the repositories inside the folder, from the session folders of a started session', () => {
    expect(repositoriesInFolder('/code/shop', folders, [])).toBe(2)
    expect(repositoriesInFolderLabel(2)).toBe('2 repositories in this folder')
    expect(repositoriesInFolderLabel(1)).toBe('1 repository in this folder')
  })

  test('counts the repositories that the host found for a draft, each one time', () => {
    expect(repositoriesInFolder('/code/store', [], STORE_SCAN.members)).toBe(2)
    // A repository that is a session folder and a member is one repository.
    expect(repositoriesInFolder('/code/shop', folders, [{ path: '/code/shop/api/', state: 'git' }])).toBe(2)
  })

  // With no repository inside, the section keeps its "This folder isn't a Git repository yet." state.
  test('a folder with no repository inside it has none to name', () => {
    expect(repositoriesInFolder('/code/notes', folders, [])).toBe(0)
    expect(repositoriesInFolder('/code/shop/api', folders, [])).toBe(0)
    expect(repositoriesInFolder('~', folders, [])).toBe(0)
    expect(repositoriesInFolder(null, folders, [])).toBe(0)
  })
})

describe('the project row of the Environment section', () => {
  test('a run with no codebase shows only its host, as before', () => {
    expect(projectRowTrailing({ codebaseName: null, hostLabel: 'This Mac', isLocalHost: true })).toEqual({ badge: undefined, badgePrefix: undefined, tooltip: 'Runs on This Mac' })
    expect(projectRowTrailing({ codebaseName: null, hostLabel: 'Build server', isLocalHost: false })).toEqual({ badge: 'Build server', badgePrefix: undefined, tooltip: 'Runs on Build server' })
  })

  // On this machine the host is a glyph, so the codebase is the one text of the slot.
  test('a run with a codebase on this machine names the codebase', () => {
    expect(projectRowTrailing({ codebaseName: 'shop', hostLabel: 'This Mac', isLocalHost: true })).toEqual({ badge: 'shop', badgePrefix: undefined, tooltip: 'Codebase shop · Runs on This Mac' })
  })

  // The tooltip of a row is one line of text: a line break shows as a space, and "shop Runs on" reads as one fact.
  test('the two facts of the tooltip show as two facts on one line', () => {
    const { tooltip } = projectRowTrailing({ codebaseName: 'shop', hostLabel: 'This Mac', isLocalHost: true })
    expect(tooltip).not.toContain('\n')
    expect(tooltipDisplay(tooltip!)).toEqual({ label: 'Codebase shop · Runs on This Mac' })
  })

  // The host name stays. The codebase is the prefix, which the row cuts first when the rail is narrow.
  test('a run with a codebase on a different host keeps the host and puts the codebase in front of it', () => {
    const trailing = projectRowTrailing({ codebaseName: 'shop', hostLabel: 'Build server', isLocalHost: false })
    expect(trailing.badge).toBe('Build server')
    expect(trailing.badgePrefix).toBe('shop · ')
    expect(trailing.tooltip).toBe('Codebase shop · Runs on Build server')
  })
})
