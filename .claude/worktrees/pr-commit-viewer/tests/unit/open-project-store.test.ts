import { afterEach, describe, expect, test } from 'bun:test'
import type { HostReadiness, RecentProject } from '../../src/shared/types'
import type { HostOption } from '../../src/renderer/components/servers/lib/open-project-flow'

const previousState = (globalThis as unknown as { $state?: unknown }).$state
const previousLocalStorage = (globalThis as unknown as { localStorage?: unknown }).localStorage
const previousAudio = (globalThis as unknown as { Audio?: unknown }).Audio

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
  if (previousLocalStorage === undefined) delete (globalThis as unknown as { localStorage?: unknown }).localStorage
  else (globalThis as unknown as { localStorage: unknown }).localStorage = previousLocalStorage
  if (previousAudio === undefined) delete (globalThis as unknown as { Audio?: unknown }).Audio
  else (globalThis as unknown as { Audio: unknown }).Audio = previousAudio
})

const STUDIO: HostOption = { id: 'studio-vm', label: 'Studio VM', local: false }
const LAPTOP: HostOption = { id: 'local', label: 'This Mac', local: true }

const SOLUS: RecentProject = {
  path: '/home/dev/projects/solus',
  folderName: 'solus',
  lastOpened: '2026-07-20T10:00:00.000Z',
}
const NOTES: RecentProject = {
  path: '/home/dev/scratch/notes',
  folderName: 'notes',
  lastOpened: '2026-07-19T10:00:00.000Z',
}

interface Call {
  serverId: string
  method: string
  args: unknown[]
}

interface FakeOptions {
  repoFailure?: Error
  cloneFailure?: Error
  recents?: RecentProject[]
  deferredClone?: Deferred<{ path: string; projectKey: string; auth: 'token' }>
  deferredRecents?: Deferred<RecentProject[]>[]
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

/** Lets every request the store fired on open reach its `.then` before asserting. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Records which host each call was routed to; every method resolves to a benign value. */
function fakeConnections(options: FakeOptions = {}) {
  const calls: Call[] = []
  const resolveApi = (serverId: string) =>
    new Proxy({}, {
      get: (_target, method: string) => (...args: unknown[]) => {
        calls.push({ serverId, method, args })
        if (method.startsWith('on')) return () => {}
        if (method === 'setupHostReadiness') {
          return Promise.resolve({
            platform: 'linux',
            home: '/home/dev',
            projectsRoot: '/home/dev/projects',
            git: { installed: true, version: 'git 2.4', identity: null, credentialHelper: false },
            github: { solusToken: true, solusLogin: 'dev', ghCli: false, ghAuthenticated: false },
            ssh: { publicKeys: [] },
            agents: {
              claude: { installed: true, signedIn: true },
              codex: { installed: false, signedIn: false },
            },
            installGit: null,
          })
        }
        if (method === 'setupListGithubRepos') {
          return options.repoFailure
            ? Promise.reject(options.repoFailure)
            : Promise.resolve({ connected: true, repos: [] })
        }
        if (method === 'setupCloneProject') {
          return options.cloneFailure
            ? Promise.reject(options.cloneFailure)
            : options.deferredClone?.promise ?? Promise.resolve({ path: '/home/dev/projects/solus', projectKey: 'k', auth: 'token' })
        }
        if (method === 'listRecentProjects') {
          // Tagged with the host that answered, so a reply landing on the wrong
          // machine is visible rather than indistinguishable.
          const recents = options.deferredRecents?.shift()?.promise ?? Promise.resolve(options.recents ?? [])
          return recents.then((projects) =>
            projects.map((project) => ({ ...project, path: `/hosts/${serverId}${project.path}` })),
          )
        }
        return Promise.resolve(null)
      },
    })
  return { calls, resolveApi: resolveApi as never }
}

async function newStore(options: FakeOptions = {}) {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;(globalThis as unknown as { Audio: unknown }).Audio = class {
    play() {}
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: () => null,
    setItem: () => {},
  }
  const { OpenProjectStore } = await import('../../src/renderer/components/servers/open-project.store.svelte')
  const { HostSetupSession } = await import('../../src/renderer/components/servers/host-setup.store.svelte')
  const { calls, resolveApi } = fakeConnections(options)
  const apiFor = resolveApi as unknown as (serverId: string) => {
    setupHostReadiness: () => Promise<HostReadiness>
    listRecentProjects: () => Promise<RecentProject[]>
  }
  const readinessByHost: Record<string, HostReadiness> = {}
  const setupStore = {
    readinessByHost,
    resolveApi,
    refreshHost: async (serverId: string) => {
      readinessByHost[serverId] = await apiFor(serverId).setupHostReadiness()
    },
  }
  const sessions = new Map<string, InstanceType<typeof HostSetupSession>>()
  const sessionFor = (serverId: string) => {
    let session = sessions.get(serverId)
    if (!session) {
      session = new HostSetupSession(serverId, setupStore as never)
      sessions.set(serverId, session)
    }
    return session
  }
  const recentProjectsFor = (serverId: string) => apiFor(serverId).listRecentProjects()
  return {
    store: new OpenProjectStore(resolveApi, sessionFor, recentProjectsFor),
    calls,
  }
}

describe('open project host scoping', () => {
  test('every call for a host goes to that host, never to the active one', async () => {
    const { store, calls } = await newStore()
    store.open([LAPTOP, STUDIO])
    store.selectHost(STUDIO)
    store.chooseCloneUrl('solus-sh/solus')
    calls.length = 0

    await store.refreshReadiness()
    await store.loadRepos()
    await store.setup!.installGit()
    await store.setup!.setGitIdentity({ name: 'Dev', email: 'dev@example.com' })
    await store.checkSshAccess()
    await store.setup!.authorizeGhCli()
    await store.setup!.installCredentialHelper()
    await store.clone()

    expect(calls.length).toBeGreaterThan(8)
    expect(calls.every((call) => call.serverId === 'studio-vm')).toBe(true)
    expect(calls.map((call) => call.method)).toContain('setupCloneProject')
    expect(calls.map((call) => call.method)).toContain('setupInstallGit')
  })

  test('moving to another host rebinds every later call to it', async () => {
    const { store, calls } = await newStore()
    store.open([LAPTOP, STUDIO])
    store.chooseCloneUrl('solus-sh/solus')
    store.selectHost(STUDIO)
    store.selectHost(LAPTOP)
    calls.length = 0

    await store.refreshReadiness()

    expect(calls.every((call) => call.serverId === 'local')).toBe(true)
  })

  test('a reply that outlived its host is dropped instead of describing the new one', async () => {
    const { store } = await newStore({ recents: [SOLUS] })
    store.open([LAPTOP, STUDIO])
    // The laptop's answer is still in flight when the chip moves to the VM;
    // landing it would list one machine's projects under the other's name.
    const stale = store.loadRecents()
    store.selectHost(STUDIO)
    await stale
    await settle()

    expect(store.recents.map((project: RecentProject) => project.path)).toEqual([
      '/hosts/studio-vm/home/dev/projects/solus',
    ])
  })

  test('a reply from a host you switched away from and back to is still stale', async () => {
    const staleRecents = deferred<RecentProject[]>()
    const { store } = await newStore({ recents: [NOTES], deferredRecents: [staleRecents] })
    store.open([LAPTOP, STUDIO])
    store.selectHost(STUDIO)
    store.selectHost(LAPTOP)
    await settle()

    staleRecents.resolve([SOLUS])
    await settle()

    expect(store.recents.map((project: RecentProject) => project.path)).toEqual([
      '/hosts/local/home/dev/scratch/notes',
    ])
  })
})

describe('GitHub repository loading', () => {
  test('a repository request failure does not claim the connected host is signed out', async () => {
    const { store } = await newStore({ repoFailure: new Error('GitHub is temporarily unavailable') })
    store.open([LAPTOP], { source: 'github' })
    await store.refreshReadiness()
    await store.loadRepos()

    expect(store.readiness?.github.solusToken).toBe(true)
    expect(store.reposConnected).not.toBe(false)
    expect(store.needsGithubOnHost).toBe(false)
    expect(store.reposError).toBe('GitHub is temporarily unavailable')
  })
})

describe('open project steps', () => {
  test('opening lands on home with a machine already bound', async () => {
    const { store } = await newStore()
    store.open([LAPTOP, STUDIO])

    // More than one machine no longer means a question: the head of the list is
    // the one App is already on, and the chip changes it from any screen.
    expect(store.step).toBe('home')
    expect(store.serverId).toBe('local')
    expect(store.hostLabel).toBe('This Mac')
  })

  test('an entry point that names a machine binds that one instead of the first', async () => {
    const { store } = await newStore()
    store.open([LAPTOP, STUDIO], { host: STUDIO })

    expect(store.step).toBe('home')
    expect(store.serverId).toBe('studio-vm')
  })

  test('the chip rebinds without moving off the screen it was used from', async () => {
    const { store } = await newStore()
    store.open([LAPTOP, STUDIO])
    store.chooseGithub()
    store.selectHost(STUDIO)

    expect(store.step).toBe('destination')
    expect(store.serverId).toBe('studio-vm')
  })

  test('each intent from home lands on the screen that can answer it', async () => {
    const { store } = await newStore()
    store.open([LAPTOP])

    store.browseFolder()
    expect(store.step).toBe('browse')
    expect(store.source).toBe('local')

    store.chooseGithub()
    expect(store.step).toBe('destination')
    expect(store.source).toBe('github')

    store.chooseCloneUrl('solus-sh/solus')
    expect(store.step).toBe('destination')
    expect(store.source).toBe('clone')
    expect(store.query).toBe('solus-sh/solus')
  })

  test('back returns to home from anywhere the flow can go', async () => {
    const { store } = await newStore()

    store.open([LAPTOP], { source: 'github' })
    store.back()
    expect(store.step).toBe('home')

    store.open([LAPTOP], { source: 'local' })
    store.back()
    expect(store.step).toBe('home')

    store.open([LAPTOP])
    store.step = 'cloning'
    store.back()
    expect(store.step).toBe('home')
  })

  test('cancelling the folder browser a clone opened keeps the URL that sent it there', async () => {
    const { store } = await newStore()
    store.open([LAPTOP], { source: 'clone', seed: 'solus-sh/solus' })
    store.beginBrowse()
    store.back()

    expect(store.step).toBe('destination')
    expect(store.query).toBe('solus-sh/solus')
  })

  test('a clone takes over the panel, and hands it back to the form when it fails', async () => {
    const { store } = await newStore({ cloneFailure: new Error('remote: Repository not found') })
    store.open([LAPTOP], { source: 'clone', seed: 'solus-sh/solus' })

    const running = store.clone()
    expect(store.step).toBe('cloning')
    await running

    // Retry and adopt live on the destination form, so a failure has to land there.
    expect(store.step).toBe('destination')
    expect(store.cloneFailure).not.toBeNull()
  })

  test('a clone finishing after the dialog was reopened returns no path and leaves the new state alone', async () => {
    const delayedClone = deferred<{ path: string; projectKey: string; auth: 'token' }>()
    const { store } = await newStore({ deferredClone: delayedClone })
    store.open([LAPTOP], { source: 'clone', seed: 'solus-sh/solus' })

    const clone = store.clone()
    store.close()
    store.open([LAPTOP], { source: 'clone', seed: 'solus-sh/solus' })
    delayedClone.resolve({ path: '/home/dev/projects/solus', projectKey: 'k', auth: 'token' })

    await expect(clone).resolves.toBeNull()
    expect(store.cloneStatus).toBe('idle')
    expect(store.clonedPath).toBeNull()
  })
})

describe('what home offers', () => {
  test('only the newest few are offered, so the actions below them stay on screen', async () => {
    const older: RecentProject[] = ['alpha', 'beta', 'gamma'].map((name) => ({
      path: `/home/dev/projects/${name}`,
      folderName: name,
      lastOpened: '2026-07-01T10:00:00.000Z',
    }))
    const { store } = await newStore({ recents: [SOLUS, NOTES, ...older] })
    store.open([LAPTOP])
    await settle()

    expect(store.recents).toHaveLength(5)
    expect(store.filteredRecents.map((project: RecentProject) => project.folderName)).toEqual([
      'solus',
      'notes',
      'alpha',
    ])
  })

  test('the search box narrows recents by name and by path', async () => {
    const { store } = await newStore({ recents: [SOLUS, NOTES] })
    store.open([LAPTOP])
    await settle()

    expect(store.filteredRecents).toHaveLength(2)

    store.homeQuery = 'note'
    expect(store.filteredRecents.map((project) => project.folderName)).toEqual(['notes'])

    store.homeQuery = 'PROJECTS'
    expect(store.filteredRecents.map((project) => project.folderName)).toEqual(['solus'])
  })

  test('a pasted clone URL is read as a repository to clone, not as a filter', async () => {
    const { store } = await newStore({ recents: [SOLUS] })
    store.open([LAPTOP])

    store.homeQuery = 'https://github.com/solus-sh/solus.git'
    expect(store.homeIntent.kind).toBe('clone-url')

    store.homeQuery = 'solus-sh/solus'
    expect(store.homeIntent.kind).toBe('owner-repo')

    store.homeQuery = 'solus'
    expect(store.homeIntent.kind).toBe('search')
  })
})

describe('where a project lands', () => {
  test('the primary action names no destination, so the host de-duplicates its own root', async () => {
    const { store, calls } = await newStore()
    store.open([STUDIO], { host: STUDIO, source: 'clone', seed: 'solus-sh/solus' })
    await store.refreshReadiness()

    expect(store.destinationPreview).toBe('/home/dev/projects/solus')
    await store.clone()

    const clone = calls.find((call) => call.method === 'setupCloneProject')
    expect((clone?.args[0] as { destination?: string }).destination).toBeUndefined()
  })

  test('choosing a location clones into that folder under the repo name', async () => {
    const { store, calls } = await newStore()
    store.open([STUDIO], { host: STUDIO, source: 'clone', seed: 'solus-sh/solus' })
    await store.refreshReadiness()

    await store.cloneInto('/data/checkouts')

    const clone = calls.find((call) => call.method === 'setupCloneProject')
    expect((clone?.args[0] as { destination?: string }).destination).toBe('/data/checkouts/solus')
  })

  test('a retry re-uses the destination the first attempt chose', async () => {
    const { store, calls } = await newStore()
    store.open([STUDIO], { host: STUDIO, source: 'clone', seed: 'solus-sh/solus' })
    await store.refreshReadiness()
    await store.cloneInto('/data/checkouts')
    calls.length = 0

    await store.clone({ clean: true })

    const clone = calls.find((call) => call.method === 'setupCloneProject')
    expect((clone?.args[0] as { destination?: string; clean?: boolean }).destination).toBe('/data/checkouts/solus')
    expect((clone?.args[0] as { clean?: boolean }).clean).toBe(true)
  })
})
