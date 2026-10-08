import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SOLUS_WORKTREE_PATH_MARKER, type ProjectEntry, type RecentProject } from '@solus/contracts/types'
import { ProjectsStore, type UntrackHosts } from '@solus/workspace-ui/contexts/projects/projects.store.svelte'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

const originalLocalStorage = globalThis.localStorage

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true })
})

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: originalLocalStorage, configurable: true })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function recent(path: string): RecentProject {
  return { path, folderName: path.split('/').at(-1)!, lastOpened: '2026-09-04T12:00:00Z' }
}

function listed(path: string, repositoryKey: string | null, lastUsedAt = '2026-09-04T12:00:00Z'): ProjectEntry {
  return { key: path, path, folderName: path.split('/').at(-1)!, addedAt: '2026-09-01T12:00:00Z', lastUsedAt, repositoryKey }
}

const noRecents = () => Promise.resolve([])

/** A host whose list is `projects`, and which records what it is asked to add. */
function fakeHost(projects: ProjectEntry[] = []) {
  const tracked: string[] = []
  return {
    tracked,
    api: {
      trackRecentProject: async (path: string) => { tracked.push(path) },
      listProjects: async () => projects,
    },
  }
}

/** Hosts a removal asks: `online` answer, and each untrack is recorded. */
function untrackHosts(online: string[], refuses: string[] = []): UntrackHosts & { untracked: string[] } {
  const untracked: string[] = []
  return {
    untracked,
    isConnected: (serverId) => online.includes(serverId),
    untrackProject: async (serverId, path) => {
      if (refuses.includes(serverId)) throw new Error('refused')
      untracked.push(`${serverId}:${path}`)
    },
  }
}

describe('the host list is the only record of projects', () => {
  test("a host's list names each checkout's repository and orders by last use", async () => {
    // WHY: pages group checkouts by repository (project-model.md §1) and list
    // the projects a person used last first; both facts come from the host.
    const store = new ProjectsStore([], noRecents)
    await store.loadProjectsFor('laptop', fakeHost([
      listed('/Users/me/scratch', null, '2026-09-02T12:00:00Z'),
      listed('/Users/me/web', 'github.com/acme/web', '2026-09-05T12:00:00Z'),
    ]).api)
    expect(store.entries.map((entry) => [entry.projectRoot, entry.repositoryKey])).toEqual([
      ['/Users/me/web', 'github.com/acme/web'],
      ['/Users/me/scratch', null],
    ])
  })

  test('a host that cannot answer keeps the list it last gave, also after a restart', async () => {
    // WHY: a host that is away must still name and group its projects; the
    // copy is a cache of the host's list, never a record of its own.
    const store = new ProjectsStore([], noRecents)
    await store.loadProjectsFor('box', fakeHost([listed('/srv/web', 'github.com/acme/web')]).api)
    await store.loadProjectsFor('box', { listProjects: () => Promise.reject(new Error('offline')) }, { force: true })
    expect(store.projectsFor('box').map((project) => project.path)).toEqual(['/srv/web'])

    store.flush()
    const restarted = new ProjectsStore(undefined, noRecents)
    expect(restarted.projectKeyFor('box', '/srv/web')).toBe('github.com/acme/web')
    expect(restarted.projectsLoadedFor('box')).toBe(false)
  })

  test('the next read replaces the kept copy, so a folder another client untracked leaves', async () => {
    const store = new ProjectsStore([{ serverId: 'box', projects: [listed('/srv/web', null), listed('/srv/old', null)] }], noRecents)
    await store.loadProjectsFor('box', fakeHost([listed('/srv/web', null)]).api)
    expect(store.entries.map((entry) => entry.projectRoot)).toEqual(['/srv/web'])
  })
})

describe('the project of a folder', () => {
  // WHY: sessions, tasks and works name the folder they ran in, which may be
  // a worktree or a subfolder of a project, or a clone a host keeps for
  // dispatch. Each must land in the project that holds it (project-model.md §3).
  const store = new ProjectsStore([{
    serverId: 'laptop',
    projects: [listed('/Users/me/web', 'github.com/acme/web'), listed('/Users/me/notes', null)],
  }], noRecents)

  test('a worktree or subfolder of a listed project is that project', () => {
    expect(store.projectKeyFor('laptop', `/Users/me/web${SOLUS_WORKTREE_PATH_MARKER}fix`)).toBe('github.com/acme/web')
    expect(store.projectKeyFor('laptop', '/Users/me/web/packages/api')).toBe('github.com/acme/web')
    expect(store.repositoryKeyFor('laptop', '/Users/me/web/packages/api')).toBe('github.com/acme/web')
    // A sibling whose name starts the same is not inside it.
    expect(store.projectKeyFor('laptop', '/Users/me/web-old')).toBe('laptop:/Users/me/web-old')
  })

  test('a listed folder with no remote is its host\'s alone', () => {
    expect(store.projectKeyFor('laptop', '/Users/me/notes')).toBe('laptop:/Users/me/notes')
    expect(store.projectKeyFor('box', '/Users/me/notes')).toBe('box:/Users/me/notes')
  })

  test('a dispatch clone no host lists is the repository its path names', () => {
    expect(store.projectKeyFor('box', '/home/me/projects/solus-remote/dev1/github.com/acme/web')).toBe('github.com/acme/web')
  })
})

describe('adding a project', () => {
  test('lists it at once and tells the host, which then decides', async () => {
    const store = new ProjectsStore([], noRecents)
    const reply = deferred<ProjectEntry[]>()
    const tracked: string[] = []
    const project = store.addProject('studio', {
      trackRecentProject: async (path) => { tracked.push(path) },
      listProjects: () => reply.promise,
    }, '/repos/solus')

    expect(project).toEqual({ serverId: 'studio', projectRoot: '/repos/solus' })
    expect(tracked).toEqual(['/repos/solus'])
    expect(store.entries.map((entry) => [entry.projectRoot, entry.label])).toEqual([['/repos/solus', 'solus']])

    // The host's entry replaces the guess and names the repository.
    reply.resolve([listed('/repos/solus', 'github.com/acme/solus')])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.projectKeyFor('studio', '/repos/solus')).toBe('github.com/acme/solus')
  })

  test('a host that refuses drops the folder again on its next answer', async () => {
    const store = new ProjectsStore([], noRecents)
    const list = deferred<ProjectEntry[]>()
    store.addProject('studio', {
      trackRecentProject: async () => { throw new Error('refused') },
      listProjects: () => list.promise,
    }, '/repos/lighthouse')
    list.resolve([])
    await list.promise
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.entries).toEqual([])
  })

  test('a worktree is added as its project; no folder and a dispatch clone are not projects', () => {
    const store = new ProjectsStore([], noRecents)
    const host = fakeHost()
    store.addProject('local', host.api, `/repos/atlas${SOLUS_WORKTREE_PATH_MARKER}feature`)
    expect(store.addProject('local', host.api, '~')).toBeNull()
    expect(store.addProject('local', host.api, '/home/me/solus-remote/dev1/github.com/acme/web')).toBeNull()
    expect(host.tracked).toEqual(['/repos/atlas'])
  })
})

describe('removing a project', () => {
  const lists = () => [
    { serverId: 'laptop', projects: [listed('/Users/me/web', 'github.com/acme/web'), listed('/Users/me/api', 'github.com/acme/api')] },
    { serverId: 'box', projects: [listed('/srv/web', 'github.com/acme/web')] },
  ]

  test('untracks every checkout on the hosts that answer, and nothing else', async () => {
    const hosts = untrackHosts(['laptop', 'box'])
    const store = new ProjectsStore(lists(), noRecents, hosts)
    await store.removeProject('github.com/acme/web')
    expect(hosts.untracked.sort()).toEqual(['box:/srv/web', 'laptop:/Users/me/web'])
    expect(store.entries.map((entry) => entry.projectRoot)).toEqual(['/Users/me/api'])
  })

  test('a host that is away or refuses keeps its checkout listed', async () => {
    // WHY: the list shows what the hosts hold. Hiding a checkout its host
    // still lists would bring it back on the next read.
    const hosts = untrackHosts(['laptop'], ['laptop'])
    const store = new ProjectsStore(lists(), noRecents, hosts)
    await store.removeProject('github.com/acme/web')
    expect(store.checkoutsOf('github.com/acme/web').map((entry) => entry.serverId).sort()).toEqual(['box', 'laptop'])
  })
})

describe('recent folders', () => {
  test('two pickers share a request and its result, while other hosts stay separate', async () => {
    const reply = deferred<RecentProject[]>()
    const calls: string[] = []
    const store = new ProjectsStore([], (host) => {
      calls.push(host)
      return host === 'a' ? reply.promise : Promise.resolve([recent('/repo/b')])
    })
    const first = store.loadRecentProjects('a')
    const second = store.loadRecentProjects('a')
    await store.loadRecentProjects('b')
    expect(calls).toEqual(['a', 'b'])
    expect(store.recentProjectsLoadingFor('a')).toBe(true)
    reply.resolve([recent('/repo/a')])
    await Promise.all([first, second])
    await store.loadRecentProjects('a')
    expect(calls).toEqual(['a', 'b'])
    expect(store.recentProjectsFor('a')).toEqual([recent('/repo/a')])
    expect(store.recentProjectsFor('b')).toEqual([recent('/repo/b')])
    expect(store.recentProjectsLoadingFor('a')).toBe(false)
  })

  test('a recent folder is not a project', async () => {
    // WHY: only adding a folder makes it a project; a folder opened once and
    // never added must not appear in every project list.
    const store = new ProjectsStore([], async () => [recent('/repo/once')])
    await store.loadRecentProjects('a')
    expect(store.entries).toEqual([])
  })

  test('a late reply cannot overwrite a forced refresh', async () => {
    const old = deferred<RecentProject[]>()
    const fresh = deferred<RecentProject[]>()
    let calls = 0
    const store = new ProjectsStore([], () => ++calls === 1 ? old.promise : fresh.promise)
    const first = store.loadRecentProjects('a')
    const second = store.loadRecentProjects('a', { force: true })
    fresh.resolve([recent('/new')])
    await second
    old.resolve([recent('/old')])
    await first
    expect(store.recentProjectsFor('a')).toEqual([recent('/new')])
  })

  test('invalidating one host refreshes it without reloading another host', async () => {
    const calls: string[] = []
    const store = new ProjectsStore([], async (host) => {
      calls.push(host)
      return [recent(`/repo/${calls.length}`)]
    })
    await Promise.all([store.loadRecentProjects('a'), store.loadRecentProjects('b')])
    store.invalidateRecentProjects('a')
    await store.loadRecentProjects('a')
    expect(calls).toEqual(['a', 'b', 'a'])
    expect(store.recentProjectsFor('a')).toEqual([recent('/repo/3')])
    expect(store.recentProjectsFor('b')).toEqual([recent('/repo/2')])
  })
})
