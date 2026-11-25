import { describe, expect, test } from 'bun:test'
import type { ProjectEntry, SessionRecord, SessionRecordListFilter } from '@solus/contracts/types'
import { MobileSessionCache } from '../../apps/mobile/solus-core/features/threads/session-cache'
import { PullRequestCache, memoryPullRequestCacheDatabase } from '@solus/client-core/pull-request-cache'
import { ThreadDirectory } from '../../apps/mobile/solus-core/features/threads/thread-directory'

// The native project filter, sidebar, and new-task picker read
// `ThreadDirectory.projects()` through `useSyncExternalStore`, which renders
// again whenever the array is a new object. A host read again with the same
// projects, a host that starts reading, and a change to sessions only must
// leave that array and each project object as they were.

const project = (path: string, extra: Partial<ProjectEntry> = {}): ProjectEntry => ({
  key: path, path, folderName: path.split('/').at(-1)!, addedAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-01-01T00:00:00Z', repositoryKey: null, ...extra,
})
const record = (sessionId: string, lastActivityAt: number) => ({ sessionId, parentSessionId: null, lastActivityAt, projectPath: '/p' }) as SessionRecord

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function world(options: { managed?: boolean; cache?: MobileSessionCache } = {}) {
  const host = options.managed ? { id: 'h', label: 'Mac', uplink: { hostId: 'h', directoryUrl: 'https://app', kind: 'cloud' as const } } : { id: 'h', label: 'Mac' }
  const answer = {
    reads: [] as string[],
    projects: [project('/w/app'), project('/w/site')],
    records: [record('a', 2)],
    /** When set, the next project read waits for it. */
    projectsGate: null as Promise<ProjectEntry[]> | null,
  }
  const connection = {
    state: { sessionGeneration: 0 },
    api: {
      pinnedSessionsList: async () => [],
      sessionRecordGet: async (id: string) => { answer.reads.push(id); return answer.records.find(record => record.sessionId === id) ?? null },
      // New objects on every read, as the host sends them.
      sessionRecordList: async (filter: SessionRecordListFilter) => ({ records: filter.scope === 'all' ? [] : structuredClone(answer.records), indexing: false }),
      listProjects: async () => {
        const gate = answer.projectsGate
        answer.projectsGate = null
        return gate ?? structuredClone(answer.projects)
      },
    },
  }
  const registry = { host: () => host, hosts: () => [host] }
  const directory = new ThreadDirectory(registry as never, () => connection as never, undefined, undefined, undefined, options.cache)
  return { directory, host, answer }
}

/** Records each `projects()` array a listener sees. */
function watchProjects(directory: ThreadDirectory) {
  const seen: unknown[] = []
  const stop = directory.changes.subscribe(() => {
    const current = directory.projects()
    if (seen.at(-1) !== current) seen.push(current)
  })
  return { seen, stop }
}

describe('native thread directory keeps unchanged projects', () => {
  test('shows the listed sessions while projects are pending and keeps equal rows after refresh', async () => {
    const { directory, answer } = world()
    const pending = deferred<ProjectEntry[]>()
    answer.projectsGate = pending.promise
    const visible = new Promise<void>((resolve) => {
      const stop = directory.changes.subscribe(() => {
        if (!directory.threads().length) return
        stop()
        resolve()
      })
    })
    const finished = directory.load('h')
    await visible
    expect(directory.stateOf('h').kind).toBe('loading')
    const rows = directory.threads()
    pending.resolve(answer.projects)
    await finished
    await directory.load('h')
    expect(directory.threads()).toBe(rows)
  })

  test('restores only the known host in the current account and replaces its cached rows with a confirmed empty list', async () => {
    let scope = 'one'
    const cache = new MobileSessionCache(new PullRequestCache(memoryPullRequestCacheDatabase()), () => scope)
    const disk = cache.forHost('h')
    await world({ cache }).directory.load('h')
    const { directory, answer } = world({ cache })
    await directory.restore('h')
    expect(directory.threads().map(t => t.record.sessionId)).toEqual(['a'])
    expect(directory.stateOf('h').kind).toBe('loading')
    answer.records = []
    await directory.load('h')
    await directory.restore('h')
    expect(directory.threads()).toEqual([])
    expect(directory.stateOf('h').kind).toBe('loaded')
    scope = 'two'
    expect(await cache.forHost('h').directory()).toBeNull()
    expect(await disk.directory()).toBeNull()
  })

  test('an equal read keeps the project array and its objects through loading and loaded, while the state change is still heard', async () => {
    const { directory } = world()
    await directory.load('h')
    const before = directory.projects()
    const states: string[] = []
    const watch = watchProjects(directory)
    const stopStates = directory.changes.subscribe(() => states.push(directory.stateOf('h').kind))
    await directory.load('h')
    expect(directory.projects()).toBe(before)
    expect(watch.seen.every((array) => array === before)).toBe(true)
    expect(states).toEqual(['loading', 'loaded'])
    watch.stop()
    stopStates()
  })

  test('a change to sessions only gives new threads and keeps the projects', async () => {
    const { directory, answer } = world()
    await directory.load('h')
    const projects = directory.projects()
    const threads = directory.threads()
    answer.records = [record('b', 3), record('a', 2)]
    await directory.load('h')
    expect(directory.projects()).toBe(projects)
    expect(directory.threads()).not.toBe(threads)
    expect(directory.threads().map((thread) => thread.record.sessionId)).toEqual(['b', 'a'])
  })

  test('a renamed, added, removed, or re-pointed project is a change; the others keep their objects', async () => {
    const { directory, answer } = world()
    await directory.load('h')
    const [app, site] = directory.projects()
    answer.projects = [project('/w/app', { folderName: 'App' }), project('/w/site')]
    await directory.load('h')
    expect(directory.projects()[0]).not.toBe(app)
    expect(directory.projects()[0]!.project.folderName).toBe('App')
    expect(directory.projects()[1]).toBe(site)

    const renamed = directory.projects()
    answer.projects = [project('/w/app', { folderName: 'App' }), project('/w/site', { repositoryKey: 'github.com/o/site' })]
    await directory.load('h')
    expect(directory.projects()).not.toBe(renamed)
    expect(directory.projects()[0]).toBe(renamed[0])
    expect(directory.projects()[1]!.project.repositoryKey).toBe('github.com/o/site')

    const repointed = directory.projects()
    answer.projects = [...answer.projects, project('/w/docs')]
    await directory.load('h')
    expect(directory.projects().map((entry) => entry.project.path)).toEqual(['/w/app', '/w/docs', '/w/site'])
    expect(directory.projects()[0]).toBe(repointed[0])
    expect(directory.projects()[2]).toBe(repointed[1])

    const added = directory.projects()
    answer.projects = [project('/w/app', { folderName: 'App' })]
    await directory.load('h')
    expect(directory.projects()).toHaveLength(1)
    expect(directory.projects()[0]).toBe(added[0])
  })

  test('a host with a new label gives every project of it a new object that names the label', async () => {
    const { directory, host } = world()
    await directory.load('h')
    const before = directory.projects()
    host.label = 'Studio'
    await directory.load('h')
    expect(directory.projects()).not.toBe(before)
    expect(directory.projects().map((entry) => entry.hostLabel)).toEqual(['Studio', 'Studio'])
  })

  test('a read that a newer read made stale writes nothing, and the newer answer shows', async () => {
    const { directory, answer } = world()
    await directory.load('h')
    const stale = deferred<ProjectEntry[]>()
    answer.projectsGate = stale.promise
    const older = directory.load('h')
    answer.projects = [project('/w/app')]
    await directory.load('h')
    const newer = directory.projects()
    stale.resolve([project('/w/app'), project('/w/site'), project('/w/old')])
    await older
    expect(directory.projects()).toBe(newer)
    expect(directory.projects().map((entry) => entry.project.path)).toEqual(['/w/app'])
  })
})

test('native organization selection filters a managed host\'s cached sessions and restores them without a host read', async () => {
  const { directory, answer } = world({ managed: true })
  answer.records = [
    { ...record('local', 3), organizationId: 'local' },
    { ...record('first', 2), organizationId: 'org-1' },
    { ...record('second', 1), organizationId: 'org-2' },
  ]
  await directory.load('h')
  const projects = directory.projects()
  directory.selectOrganization('org-1')
  const first = directory.threads().find((thread) => thread.record.sessionId === 'first')
  expect(directory.threads().map((thread) => thread.record.sessionId)).toEqual(['local', 'first'])
  directory.selectOrganization('org-2')
  expect(directory.thread('h', 'first')).toBe(first!)
  expect(directory.threads().map((thread) => thread.record.sessionId)).toEqual(['local', 'second'])
  directory.selectOrganization('org-1')
  expect(directory.threads().map((thread) => thread.record.sessionId)).toEqual(['local', 'first'])
  expect(directory.threads().find((thread) => thread.record.sessionId === 'first')).toBe(first!)
  directory.selectOrganization(null)
  expect(directory.threads().map((thread) => thread.record.sessionId)).toEqual(['local'])
  expect(directory.projects()).toBe(projects)
})

test('a personal host\'s sessions show whole, whatever organization is selected, signed in or out', async () => {
  // WHY (plans/031 rule 1): the owner's organization sessions on their own machine vanished when they signed out.
  const { directory, answer } = world()
  answer.records = [
    { ...record('local', 3), organizationId: 'local' },
    { ...record('first', 2), organizationId: 'org-1' },
    { ...record('second', 1), organizationId: 'org-2' },
  ]
  await directory.load('h')
  directory.selectOrganization(null)
  expect(directory.threads().map((thread) => thread.record.sessionId)).toEqual(['local', 'first', 'second'])
  directory.selectOrganization('org-1')
  expect(directory.threads().map((thread) => thread.record.sessionId)).toEqual(['local', 'first', 'second'])
})

test('native lists a healthy host while another host is still loading', async () => {
  const hosts = [{ id: 'healthy', label: 'Mac' }, { id: 'slow', label: 'Remote' }]
  const slow = Promise.withResolvers<SessionRecord[]>()
  const connections = new Map(hosts.map((host) => [host.id, {
    state: { sessionGeneration: 0 },
    api: {
      pinnedSessionsList: async () => [],
      sessionRecordList: async (filter: SessionRecordListFilter) => ({
        records: filter.scope === 'all' ? [] : host.id === 'slow' ? await slow.promise : [record(host.id, 1)], indexing: false,
      }),
      listProjects: async () => [],
    },
  }]))
  const registry = { hosts: () => hosts, host: (hostId: string) => hosts.find((host) => host.id === hostId) }
  const directory = new ThreadDirectory(registry as never, (hostId) => connections.get(hostId) as never)
  const healthyLoaded = new Promise<void>((resolve) => {
    const stop = directory.changes.subscribe(() => {
      if (directory.stateOf('healthy').kind !== 'loaded') return
      stop()
      resolve()
    })
  })
  const load = directory.loadAll()
  await healthyLoaded
  expect(directory.threads().map((thread) => thread.record.sessionId)).toEqual(['healthy'])
  expect(directory.stateOf('slow').kind).toBe('loading')
  slow.resolve([record('slow', 1)])
  await load
  expect(directory.threads().map((thread) => thread.record.sessionId).sort()).toEqual(['healthy', 'slow'])
})


test('session events preserve untouched rows and request only the missing records', async () => {
  const { directory, answer } = world()
  answer.records = [record('a', 2), record('b', 1)]
  await directory.load('h')
  const untouched = directory.thread('h', 'a')
  const missing = directory.applyRowChanges('h', new Map([
    ['b', { title: 'Renamed', execution: { revision: 1, current: { runId: 'run', phase: 'running', startedAt: 5 }, lastTurn: null } }],
    ['c', { title: 'New' }],
  ]))
  expect(directory.threads()[0]?.record).toMatchObject({ sessionId: 'b', customTitle: 'Renamed', lastActivityAt: 5 })
  const beforeStatus = directory.threads()
  directory.applyRowChanges('h', new Map([['b', { execution: { revision: 2, current: null, lastTurn: { runId: 'run', outcome: 'completed', startedAt: 5, endedAt: 6 } } }]]))
  expect(directory.changedPositions(beforeStatus, [])).toEqual([0])
  expect(missing).toEqual(['c'])
  expect(answer.reads).toEqual([])
  answer.records.push(record('c', 7))
  expect(await directory.refreshRecords('h', missing)).toBe(true)
  expect(answer.reads).toEqual(['c'])
  expect(directory.threads().map(row => row.record.sessionId)).toEqual(['c', 'b', 'a'])
  expect(directory.thread('h', 'a')).toBe(untouched)
  answer.records = []
  await directory.refreshRecords('h', ['c'])
  expect(directory.thread('h', 'c')).toBeNull()
  expect(directory.thread('h', 'a')).toBe(untouched)
})
