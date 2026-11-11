import { afterAll, afterEach, describe, expect, jest, test } from 'bun:test'
import type { TaskProjectSources, TaskSourceOptions } from '@solus/contracts/task-types'
import {
  BOARD_SOURCE_KEY,
  JIRA_SOURCE_KEY,
  REPO_SOURCE_KEY,
  createTasksWorld,
  disposeTasksWorlds,
  settle,
  sourceState,
} from './helpers/tasks-world'

// The task sources of each project, as each host last read them. Loaded like
// the pull request list: one request per host for all its projects, and the
// host says when a read ends (docs/plans/provider-owned-tasks.md §5).

afterAll(disposeTasksWorlds)
afterEach(() => jest.useRealTimers())

const APP = 'github.com/acme/app'
type SourcesAnswer = Record<string, TaskProjectSources>

function sourcesOf(...sourceKeys: string[]): TaskProjectSources {
  return { sources: sourceKeys.map((sourceKey) => sourceState(sourceKey)), defaultSourceKey: sourceKeys[0] }
}

describe('reading the task sources', () => {
  test('one request per host names all its projects', async () => {
    // WHY: the host owns freshness and reads a source once for every project
    // that lists it. A request per project would start a provider read each.
    const world = await createTasksWorld()
    world.checkouts.push(
      { serverId: 'local', path: '/work/app', projectKey: APP },
      { serverId: 'local', path: '/work/site', projectKey: 'github.com/acme/site' },
    )
    const requests: Array<{ cwds: string[]; opts: unknown }> = []
    world.connections.registerPrimary('local', {
      tasksSources: async (cwds: string[], opts?: unknown) => {
        requests.push({ cwds, opts })
        return { '/work/app': sourcesOf(REPO_SOURCE_KEY, BOARD_SOURCE_KEY), '/work/site': { sources: [] } }
      },
    })

    await world.taskSourcesStore.load()

    expect(requests).toEqual([{ cwds: ['/work/app', '/work/site'], opts: undefined }])
    expect(world.taskSourcesStore.sourcesFor('local', '/work/app')?.defaultSourceKey).toBe(REPO_SOURCE_KEY)
    expect(world.taskSourcesStore.sourcesOfProject(APP).map((source) => source.label)).toEqual(['acme/app', 'Roadmap'])
    // A project with no source is in no grouping: it has no tasks.
    expect([...world.taskSourcesStore.sourceKeysByProject.keys()]).toEqual([APP])
    expect(world.taskSourcesStore.sourceByKey.get(BOARD_SOURCE_KEY)?.columns.map((column) => column.name))
      .toEqual(['Todo', 'In progress', 'Shipped'])
  })

  test('a refresh that a person asks for tells the host to read each source again', async () => {
    // WHY: the refresh control must reach the provider, not the host's copy.
    const world = await createTasksWorld()
    world.checkouts.push({ serverId: 'local', path: '/work/app', projectKey: APP })
    const options: unknown[] = []
    world.connections.registerPrimary('local', {
      tasksSources: async (_cwds: string[], opts?: unknown) => {
        options.push(opts)
        return { '/work/app': sourcesOf(REPO_SOURCE_KEY) }
      },
    })

    await world.taskSourcesStore.load({ refresh: 'force' })
    expect(options).toEqual([{ refresh: 'force' }])
  })

  test('a host that holds only attachments is not asked for sources', async () => {
    // WHY: the organization's Solus API has no project config and no provider
    // connection (decision 6). The call would fail on each load.
    const world = await createTasksWorld()
    world.checkouts.push({ serverId: 'cloud', path: '/work/app', projectKey: APP })
    world.attachmentOnlyHosts.add('cloud')
    let asked = 0
    world.connections.registerPrimary('cloud', { tasksSources: async () => { asked++; return {} } })

    await world.taskSourcesStore.load()
    expect(asked).toBe(0)
  })

  test('a folder that the project list does not hold is read when a page asks for it, and stays in later reads', async () => {
    // WHY: the Tasks page can show a folder that is not a saved project. Its
    // sources must not go away on the next refresh of the host.
    const world = await createTasksWorld()
    world.checkouts.push({ serverId: 'local', path: '/work/app', projectKey: APP })
    const requests: string[][] = []
    world.connections.registerPrimary('local', {
      tasksSources: async (cwds: string[]) => {
        requests.push(cwds)
        return Object.fromEntries(cwds.map((cwd) => [cwd, sourcesOf(REPO_SOURCE_KEY)]))
      },
    })

    await world.taskSourcesStore.loadHost('local', { cwd: '/scratch/experiment' })
    await world.taskSourcesStore.loadHost('local')

    expect(requests).toEqual([['/work/app', '/scratch/experiment'], ['/work/app', '/scratch/experiment']])
    expect(world.taskSourcesStore.sourcesFor('local', '/scratch/experiment')).not.toBeNull()
  })

  test('a failed read keeps the last answer on screen and says why it failed', async () => {
    // WHY: a host that fails one read did not lose its sources. An empty page
    // would read as "this project has no task source" and offer the setup.
    const world = await createTasksWorld()
    world.checkouts.push({ serverId: 'local', path: '/work/app', projectKey: APP })
    let fail = false
    world.connections.registerPrimary('local', {
      tasksSources: async () => {
        if (fail) throw new Error('The host did not answer.')
        return { '/work/app': sourcesOf(REPO_SOURCE_KEY) }
      },
    })
    await world.taskSourcesStore.load()

    fail = true
    await world.taskSourcesStore.load()
    expect(world.taskSourcesStore.errorFor('local')).toBe('The host did not answer.')
    expect(world.taskSourcesStore.sourcesOfProject(APP).map((source) => source.sourceKey)).toEqual([REPO_SOURCE_KEY])

    fail = false
    await world.taskSourcesStore.load()
    expect(world.taskSourcesStore.errorFor('local')).toBeNull()
  })

  test('a checkout that the host no longer answers leaves, and its project has no source', async () => {
    // WHY: a removed project must not keep its tasks on the Tasks page.
    const world = await createTasksWorld()
    world.checkouts.push({ serverId: 'local', path: '/work/app', projectKey: APP })
    let answer: SourcesAnswer = { '/work/app': sourcesOf(REPO_SOURCE_KEY) }
    world.connections.registerPrimary('local', { tasksSources: async () => answer })
    await world.taskSourcesStore.load()
    expect(world.taskSourcesStore.projectKeysBySource.get(REPO_SOURCE_KEY)).toEqual([APP])

    answer = {}
    await world.taskSourcesStore.load()
    expect(world.taskSourcesStore.sourcesFor('local', '/work/app')).toBeNull()
    expect(world.taskSourcesStore.sourceKeysByProject.has(APP)).toBe(false)
    expect(world.taskSourcesStore.projectKeysBySource.has(REPO_SOURCE_KEY)).toBe(false)
  })

  test('an older answer never replaces a newer one', async () => {
    // WHY: a slow read from before a source was added would otherwise remove
    // the source that the person just added.
    const world = await createTasksWorld()
    world.checkouts.push({ serverId: 'local', path: '/work/app', projectKey: APP })
    const slow = Promise.withResolvers<SourcesAnswer>()
    let reads = 0
    world.connections.registerPrimary('local', {
      tasksSources: () => reads++ === 0 ? slow.promise : Promise.resolve({ '/work/app': sourcesOf(REPO_SOURCE_KEY, BOARD_SOURCE_KEY) }),
    })

    const older = world.taskSourcesStore.loadHost('local')
    await world.taskSourcesStore.loadHost('local')
    slow.resolve({ '/work/app': sourcesOf(REPO_SOURCE_KEY) })
    await older

    expect(world.taskSourcesStore.sourcesOfProject(APP).map((source) => source.sourceKey)).toEqual([REPO_SOURCE_KEY, BOARD_SOURCE_KEY])
  })

  test('says that it refreshes while a read is in flight, and while a host reads a source from its provider', async () => {
    // WHY: the header spinner describes the read of GitHub or Jira, which
    // goes on after the host answered its copy. A spinner that stops early lies.
    const world = await createTasksWorld()
    world.checkouts.push({ serverId: 'local', path: '/work/app', projectKey: APP })
    const answer = Promise.withResolvers<SourcesAnswer>()
    let next: Promise<SourcesAnswer> = answer.promise
    world.connections.registerPrimary('local', { tasksSources: () => next })

    const load = world.taskSourcesStore.load()
    expect(world.taskSourcesStore.refreshing).toBe(true)
    answer.resolve({ '/work/app': { sources: [sourceState(REPO_SOURCE_KEY, { refreshing: true })] } })
    await load
    expect(world.taskSourcesStore.refreshing).toBe(true)

    next = Promise.resolve({ '/work/app': sourcesOf(REPO_SOURCE_KEY) })
    await world.taskSourcesStore.load()
    expect(world.taskSourcesStore.refreshing).toBe(false)
  })
})

describe('when a host says that its sources changed', () => {
  test('several events of one refresh cause one read of that host', async () => {
    // WHY: one refresh of a project with four sources ends as four events.
    // Nothing here polls: the event is the only cause of a new read.
    jest.useFakeTimers()
    const world = await createTasksWorld()
    world.checkouts.push(
      { serverId: 'local', path: '/work/app', projectKey: APP },
      { serverId: 'workshop', path: '/work/app', projectKey: APP },
    )
    const reads: string[] = []
    const api = (name: string) => ({
      tasksSidebarSnapshot: async () => ({ tasks: [], sessionsByTask: {} }),
      tasksSources: async () => {
        reads.push(name)
        return { '/work/app': sourcesOf(REPO_SOURCE_KEY) }
      },
    })
    world.connections.registerPrimary('local', api('local'))
    world.connections.registerHost('workshop', api('workshop'))
    const store = new world.TasksStore()
    await store.ensureLoaded()
    expect(reads).toEqual([])

    world.connections.emit('workshop', 'tasks.sourcesChanged', { sourceKeys: [REPO_SOURCE_KEY] })
    world.connections.emit('workshop', 'tasks.sourcesChanged', { sourceKeys: [BOARD_SOURCE_KEY] })
    jest.advanceTimersByTime(99)
    expect(reads).toEqual([])
    jest.advanceTimersByTime(1)
    await settle()

    expect(reads).toEqual(['workshop'])
  })

  test('a host that reconnects is read again', async () => {
    // WHY: it missed its own events while it was away.
    const world = await createTasksWorld()
    world.checkouts.push({ serverId: 'local', path: '/work/app', projectKey: APP })
    let reads = 0
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => ({ tasks: [], sessionsByTask: {} }),
      tasksSources: async () => {
        reads++
        return { '/work/app': sourcesOf(REPO_SOURCE_KEY) }
      },
    })
    const store = new world.TasksStore()
    await store.ensureLoaded()

    world.connections.emitReadiness('local', 'reconnecting')
    world.connections.emitReadiness('local', 'ready')
    await settle()

    expect(reads).toBe(1)
  })
})

describe('one project on two hosts', () => {
  async function twoCheckouts() {
    const world = await createTasksWorld()
    world.checkouts.push(
      { serverId: 'laptop', path: '/Users/me/app', projectKey: APP },
      { serverId: 'workshop', path: '/srv/app', projectKey: APP },
    )
    world.connections.registerPrimary('laptop', {
      tasksSources: async () => ({
        '/Users/me/app': { sources: [sourceState(REPO_SOURCE_KEY, { fetchedAt: 100, health: 'error' })], defaultSourceKey: REPO_SOURCE_KEY },
      }),
    })
    world.connections.registerHost('workshop', {
      tasksSources: async () => ({
        '/srv/app': { sources: [sourceState(REPO_SOURCE_KEY, { fetchedAt: 200 }), sourceState(JIRA_SOURCE_KEY)], defaultSourceKey: REPO_SOURCE_KEY },
      }),
    })
    await world.taskSourcesStore.load()
    return world
  }

  test('each source of the project shows once, as the host that read it most recently reports it', async () => {
    // WHY: the two checkouts list the same repository. The project is one
    // project, and a person wants the newest read of each source.
    const world = await twoCheckouts()

    const sources = world.taskSourcesStore.sourcesOfProject(APP)
    expect(sources.map((source) => source.sourceKey)).toEqual([REPO_SOURCE_KEY, JIRA_SOURCE_KEY])
    expect(sources[0]).toMatchObject({ fetchedAt: 200, health: 'ok' })
    expect([...world.taskSourcesStore.sourceKeysByProject.get(APP) ?? []]).toEqual([REPO_SOURCE_KEY, JIRA_SOURCE_KEY])
    // The project lists the source from two checkouts and is still one project.
    expect(world.taskSourcesStore.projectKeysBySource.get(REPO_SOURCE_KEY)).toEqual([APP])
  })

  test('a write for a source goes to the first connected checkout that lists the source', async () => {
    // WHY: `tasksCreate` needs a project folder on a host whose project config
    // names the source. A checkout that does not list the source, or whose
    // host is away, cannot create the task.
    const world = await twoCheckouts()

    expect(world.taskSourcesStore.checkoutForSource(APP, REPO_SOURCE_KEY)).toEqual({ serverId: 'laptop', cwd: '/Users/me/app' })
    expect(world.taskSourcesStore.checkoutForSource(APP, JIRA_SOURCE_KEY)).toEqual({ serverId: 'workshop', cwd: '/srv/app' })
    expect(world.taskSourcesStore.checkoutForSource(APP, BOARD_SOURCE_KEY)).toBeNull()

    world.connections.emitReadiness('laptop', 'unreachable')
    expect(world.taskSourcesStore.checkoutForSource(APP, REPO_SOURCE_KEY)).toEqual({ serverId: 'workshop', cwd: '/srv/app' })
  })
})

describe('the choices of the source setup', () => {
  const options: TaskSourceOptions = {
    github: { connected: true, projects: [] },
    jira: { connected: false, projects: [], boards: [] },
  }

  test('each open of the setup reads the choices again', async () => {
    // WHY: a person connects GitHub or Jira in Settings between two opens. A
    // cached "not connected" would hide the Projects they just gave access to.
    const world = await createTasksWorld()
    let reads = 0
    world.connections.registerPrimary('local', {
      tasksSourceOptions: async () => ({ ...options, github: { connected: reads++ > 0, projects: [] } }),
    })

    expect(world.taskSourcesStore.optionsFor('local', '/work/app')).toBeNull()
    await world.taskSourcesStore.loadOptions('local', '/work/app')
    expect(world.taskSourcesStore.optionsFor('local', '/work/app')?.github.connected).toBe(false)
    await world.taskSourcesStore.loadOptions('local', '/work/app')
    expect(world.taskSourcesStore.optionsFor('local', '/work/app')?.github.connected).toBe(true)
  })

  test('two surfaces that open at the same time share one read', async () => {
    const world = await createTasksWorld()
    let reads = 0
    world.connections.registerPrimary('local', { tasksSourceOptions: async () => { reads++; return options } })

    await Promise.all([
      world.taskSourcesStore.loadOptions('local', '/work/app'),
      world.taskSourcesStore.loadOptions('local', '/work/app'),
    ])
    expect(reads).toBe(1)
  })

  test('a failed read is reported, keeps the last choices, and clears on the next good read', async () => {
    // WHY: the setup must say that the host did not answer. An empty menu
    // would read as "nothing can be added".
    const world = await createTasksWorld()
    let fail = false
    world.connections.registerPrimary('local', {
      tasksSourceOptions: async () => {
        if (fail) throw new Error('GitHub did not answer.')
        return options
      },
    })
    await world.taskSourcesStore.loadOptions('local', '/work/app')

    fail = true
    expect(await world.taskSourcesStore.loadOptions('local', '/work/app')).toBeNull()
    expect(world.taskSourcesStore.optionsErrorFor('local', '/work/app')).toBe('GitHub did not answer.')
    expect(world.taskSourcesStore.optionsFor('local', '/work/app')).toEqual(options)

    fail = false
    await world.taskSourcesStore.loadOptions('local', '/work/app')
    expect(world.taskSourcesStore.optionsErrorFor('local', '/work/app')).toBeNull()
  })
})
