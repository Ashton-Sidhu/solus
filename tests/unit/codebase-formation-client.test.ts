import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { Codebase, CodebaseFolderScan, CodebaseMember } from '@solus/contracts/codebases'
import type { RunConfig, Session, Tab } from '@solus/contracts/types'
import type { CodebaseHostAccess, CodebaseHostApi } from '@solus/workspace-ui/contexts/codebases/codebase-host-access'
import type { IpcContextBuilderDeps } from '@solus/workspace-ui/contexts/workspace/ipc-context'
import type { StatusBarCtx } from '@solus/contracts/types'
import { worktreeRepositoryChoice } from '@solus/workspace-ui/components/input/lib/worktree-repositories'
import { repositoriesInFolder } from '@solus/workspace-ui/components/project-panel/lib/git-setup'
import { projectRow } from '@solus/workspace-ui/components/project-panel/lib/project-row'
import { tooltipDisplay } from '@solus/workspace-ui/components/ui/tooltip/content'
import { chooseStart, codebaseOf, folderLocation, refuseCodebase, refusesCodebase, startsWorktree } from '@solus/workspace-ui/contexts/workspace/run-location'

/**
 * The client side of decisions 13 and 14 of docs/plans/codebases.md: the
 * session event that gives the run its codebase, and what a draft reads for
 * its start (a run with no codebase is in one project; a container is a
 * codebase, and its members are the list of a new worktree). The divider that the conversation shows for a codebase that the
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

  // The host plans a new worktree from the members of the codebase. The start control shows the same list.
  test('the repositories of a new worktree in a container are the members that its host found', () => {
    const choice = worktreeRepositoryChoice(STORE_SCAN.members, '/code/store', null)!
    expect(choice.working).toEqual({ path: '/code/store', name: 'store', isRepository: false })
    expect(choice.rows.map((row) => [row.name, row.isChosen])).toEqual([['api', true], ['web', true]])
    expect(choice.isDefault).toBe(true)
  })

  // A project is one folder or one repository: a run with no codebase has no members, so the start control lists none.
  test('a run with no codebase has no repository to choose', () => {
    expect(worktreeRepositoryChoice([], '/code/store', null)).toBeNull()
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

describe('a project folder with no repository that holds repositories', () => {
  const folders = [
    { path: '/code/shop/api', state: 'git' as const },
    { path: '/code/shop/web', state: 'git' as const },
    { path: '/code/shop/notes', state: 'plain' as const },
    { path: '/code/libs/ui', state: 'git' as const },
  ]

  // A folder that holds repositories is not a project that lacks Git: the Git card lists the repositories,
  // and "Track with Git" for the folder itself is in the menu of the project row of the Environment card.
  test('counts the repositories inside the folder, from the session folders of a started session', () => {
    expect(repositoriesInFolder('/code/shop', folders, [])).toBe(2)
  })

  test('counts the repositories that the host found for a draft, each one time', () => {
    expect(repositoriesInFolder('/code/store', [], STORE_SCAN.members)).toBe(2)
    // A repository that is a session folder and a member is one repository.
    expect(repositoriesInFolder('/code/shop', folders, [{ path: '/code/shop/api/', state: 'git' }])).toBe(2)
  })

  // With no repository inside, the Git card keeps its "This folder isn't a Git repository yet." state.
  test('a folder with no repository inside it has none to name', () => {
    expect(repositoriesInFolder('/code/notes', folders, [])).toBe(0)
    expect(repositoriesInFolder('/code/shop/api', folders, [])).toBe(0)
    expect(repositoriesInFolder('~', folders, [])).toBe(0)
    expect(repositoriesInFolder(null, folders, [])).toBe(0)
  })
})

describe('the project row of the Environment section', () => {
  // WHY: a run with one project must see the row as it was before codebases.
  test('a run with no codebase shows the name of its project and its host', () => {
    expect(projectRow({ projectName: 'api', codebaseName: null, hostLabel: 'This Mac', isLocalHost: true }))
      .toEqual({ label: 'api', badge: undefined, tooltip: 'Runs on This Mac' })
    expect(projectRow({ projectName: 'api', codebaseName: null, hostLabel: 'Build server', isLocalHost: false }))
      .toEqual({ label: 'api', badge: 'Build server', tooltip: 'Runs on Build server' })
  })

  // The row shows one name. The folders of the run are in the menu of the row.
  test('a run with a codebase shows the name of the codebase, not the name of its working folder', () => {
    const row = projectRow({ projectName: 'solus', codebaseName: 'solus + solus-cloud', hostLabel: 'This Mac', isLocalHost: true })
    expect(row).toMatchObject({ label: 'solus + solus-cloud', badge: undefined })
    // A container is a codebase with the name of its folder.
    expect(projectRow({ projectName: 'shop', codebaseName: 'shop', hostLabel: 'This Mac', isLocalHost: true }).label).toBe('shop')
  })

  // On this machine the host is a glyph. On a different host the row keeps the name of the host.
  test('a run with a codebase on a different host keeps the host in the trailing slot', () => {
    expect(projectRow({ projectName: 'api', codebaseName: 'shop', hostLabel: 'Build server', isLocalHost: false }).badge).toBe('Build server')
  })

  // The tooltip of a row is one line of text: a line break shows as a space, and "shop Works in" reads as one fact.
  test('the tooltip says where a run in a codebase works, each fact apart from the next on one line', () => {
    const { tooltip } = projectRow({ projectName: 'api', codebaseName: 'shop', hostLabel: 'Build server', isLocalHost: false })
    expect(tooltip).not.toContain('\n')
    expect(tooltipDisplay(tooltip!)).toEqual({ label: 'Codebase shop · Works in api · Runs on Build server' })
  })
})
