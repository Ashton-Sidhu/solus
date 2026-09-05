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
    store.recordProject('a', '/chosen')
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
    store.recordProject('a', '/known')
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
