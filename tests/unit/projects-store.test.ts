import { describe, expect, test } from 'bun:test'
import type { RecentProject } from '@solus/contracts/types'
import { ProjectsStore } from '@solus/workspace-ui/contexts/projects/projects.store.svelte'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function project(path: string): RecentProject {
  return { path, folderName: path.split('/').at(-1)!, lastOpened: '2026-09-04T12:00:00Z' }
}

const empty = () => ({ entries: [], ignoredDiscoveryKeys: [] })

describe('shared host project state', () => {
  test('two pickers share a request and its result, while other hosts stay separate', async () => {
    const reply = deferred<RecentProject[]>()
    const calls: string[] = []
    const store = new ProjectsStore(empty(), (host) => {
      calls.push(host)
      return host === 'a' ? reply.promise : Promise.resolve([project('/repo/b')])
    })
    const first = store.loadRecentProjects('a')
    const second = store.loadRecentProjects('a')
    await store.loadRecentProjects('b')
    expect(calls).toEqual(['a', 'b'])
    expect(store.recentProjectsLoadingFor('a')).toBe(true)
    expect(store.recentProjectsFor('a')).toEqual([])
    reply.resolve([project('/repo/a')])
    await Promise.all([first, second])
    await store.loadRecentProjects('a')
    expect(calls).toEqual(['a', 'b'])
    expect(store.recentProjectsFor('a')).toEqual([project('/repo/a')])
    expect(store.recentProjectsFor('b')).toEqual([project('/repo/b')])
    expect(store.has({ serverId: 'a', projectRoot: '/repo/a' })).toBe(true)
    expect(store.recentProjectsLoadingFor('a')).toBe(false)
    store.flush()
  })

  test('a late reply cannot overwrite a forced refresh', async () => {
    const old = deferred<RecentProject[]>()
    const fresh = deferred<RecentProject[]>()
    let calls = 0
    const store = new ProjectsStore(empty(), () => ++calls === 1 ? old.promise : fresh.promise)
    const first = store.loadRecentProjects('a')
    const second = store.loadRecentProjects('a', { force: true })
    fresh.resolve([project('/new')])
    await second
    old.resolve([project('/old')])
    await first
    expect(store.recentProjectsFor('a')).toEqual([project('/new')])
    expect(store.has({ serverId: 'a', projectRoot: '/old' })).toBe(false)
    store.flush()
  })

  test('opening a project updates all readers immediately and rejects an older host reply', async () => {
    const reply = deferred<RecentProject[]>()
    const store = new ProjectsStore(empty(), () => reply.promise)
    const loading = store.loadRecentProjects('a')
    // The host is still recording it, so the device's own record must lead.
    store.addProject('a', { trackRecentProject: () => new Promise<void>(() => {}) }, '/chosen')
    expect(store.recentProjectsFor('a').map((entry) => entry.path)).toEqual(['/chosen'])
    reply.resolve([project('/old')])
    await loading
    expect(store.recentProjectsFor('a').map((entry) => entry.path)).toEqual(['/chosen'])
    expect(store.has({ serverId: 'a', projectRoot: '/chosen' })).toBe(true)
    store.flush()
  })

  test('a failed refresh keeps known projects and permits a retry after reconnect', async () => {
    let calls = 0
    const store = new ProjectsStore(empty(), async () => {
      if (++calls === 1) throw new Error('offline')
      return [project('/after-reconnect')]
    })
    store.addProject('a', { trackRecentProject: () => new Promise<void>(() => {}) }, '/known')
    await store.loadRecentProjects('a')
    expect(store.recentProjectsFor('a').map((entry) => entry.path)).toEqual(['/known'])
    expect(store.recentProjectsLoadingFor('a')).toBe(false)
    await store.loadRecentProjects('a')
    expect(store.recentProjectsFor('a')).toEqual([project('/after-reconnect')])
    store.flush()
  })

  test('invalidating one host refreshes shared readers without reloading another host', async () => {
    const calls: string[] = []
    const store = new ProjectsStore(empty(), async (host) => {
      calls.push(host)
      return [project(`/repo/${calls.length}`)]
    })
    await Promise.all([store.loadRecentProjects('a'), store.loadRecentProjects('b')])
    store.invalidateRecentProjects('a')
    await store.loadRecentProjects('a')
    expect(calls).toEqual(['a', 'b', 'a'])
    expect(store.recentProjectsFor('a')).toEqual([project('/repo/3')])
    expect(store.recentProjectsFor('b')).toEqual([project('/repo/2')])
    store.flush()
  })
})

describe('checkout repository keys', () => {
  test("a host's listing names each checkout's repository without reordering what was touched", async () => {
    // WHY: the pages group checkouts by repository (project-model.md §1), and
    // must still know the repository when the host is offline. A listing is
    // not a visit: it must not move a project the person touched down the list.
    const store = new ProjectsStore(empty(), async () => [])
    store.record({ serverId: 'laptop', projectRoot: '/Users/me/web' }, 'web')
    const touchedAt = store.entries[0]!.lastSeenAt

    await store.loadProjectsFor('laptop', {
      listProjects: async () => [
        { key: 'k1', path: '/Users/me/web', folderName: 'web', addedAt: '', repositoryKey: 'github.com/acme/web' },
        { key: 'k2', path: '/Users/me/scratch', folderName: 'scratch', addedAt: '', repositoryKey: null },
      ],
    })

    const web = store.entries.find((entry) => entry.projectRoot === '/Users/me/web')
    expect(web).toMatchObject({ repositoryKey: 'github.com/acme/web', lastSeenAt: touchedAt })
    expect(store.entries.find((entry) => entry.projectRoot === '/Users/me/scratch')?.repositoryKey).toBeNull()
    store.flush()
  })
})

describe('dispatch checkouts stay out of the project list', () => {
  // WHY: a dispatch clone is where a host keeps one device's copy of a project
  // sent to it. Listed as a project, every "Run on" choice would add a second
  // entry for the same repository under the target host.
  const clone = '/home/me/solus-remote/device-1/github.com/acme/web'

  test('a session in a dispatch clone does not add a project', () => {
    const store = new ProjectsStore(empty(), () => Promise.resolve([]))
    store.record({ serverId: 'build', projectRoot: clone }, 'web')
    store.recordDiscovered({ serverId: 'build', projectRoot: `${clone}/.git/solus/worktrees/solus-0a1b2c3d` }, 'web')
    expect(store.entries).toEqual([])
    store.record({ serverId: 'build', projectRoot: '/home/me/web' }, 'web')
    expect(store.entries.map((entry) => entry.projectRoot)).toEqual(['/home/me/web'])
    store.flush()
  })
})

describe('only opening a folder makes it a project', () => {
  // WHY: a session can run in any folder — a scratch directory, a subfolder,
  // a clone a host keeps for dispatch. Only a person opening, cloning, or
  // adding a folder should put it in every project list.
  test('a session in an unknown folder adds nothing', () => {
    const store = new ProjectsStore(empty(), () => Promise.resolve([]))
    store.touch({ serverId: 'a', projectRoot: '/tmp/scratch' })
    expect(store.entries).toEqual([])
    store.flush()
  })

  test('a session in a known project moves it to the top', () => {
    const tracked: string[] = []
    const api = { trackRecentProject: async (path: string) => { tracked.push(path) } }
    const store = new ProjectsStore({
      entries: [
        { serverId: 'a', projectRoot: '/repos/web', label: 'web', lastSeenAt: 2 },
        { serverId: 'a', projectRoot: '/repos/api', label: 'api', lastSeenAt: 1 },
      ],
      ignoredDiscoveryKeys: [],
    }, () => Promise.resolve([]))
    store.touch({ serverId: 'a', projectRoot: '/repos/api' })
    expect(store.entries.map((entry) => entry.projectRoot)).toEqual(['/repos/api', '/repos/web'])
    expect(tracked).toEqual([])
    const opened = store.addProject('a', api, '/repos/new')
    expect(opened).toEqual({ serverId: 'a', projectRoot: '/repos/new' })
    expect(tracked).toEqual(['/repos/new'])
    store.flush()
  })
})
