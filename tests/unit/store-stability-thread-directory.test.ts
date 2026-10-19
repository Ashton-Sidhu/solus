import { describe, expect, test } from 'bun:test'
import type { ProjectEntry, SessionRecord, SessionRecordListFilter } from '@solus/contracts/types'
import { ThreadDirectory } from '../../apps/mobile/src/features/threads/thread-directory'

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

function world() {
  const host = { id: 'h', label: 'Mac' }
  const answer = {
    projects: [project('/w/app'), project('/w/site')],
    records: [record('a', 2)],
    /** When set, the next project read waits for it. */
    projectsGate: null as Promise<ProjectEntry[]> | null,
  }
  const connection = {
    state: { sessionGeneration: 0 },
    api: {
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
  const directory = new ThreadDirectory(registry as never, () => connection as never)
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
