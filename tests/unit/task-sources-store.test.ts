import { afterAll, afterEach, describe, expect, jest, test } from 'bun:test'
import type { TaskSourceOptions, TaskSourceState } from '@solus/contracts/task-types'
import {
  BOARD_SOURCE_KEY,
  REPO_SOURCE_KEY,
  createTasksWorld,
  disposeTasksWorlds,
  settle,
  sourceState,
} from './helpers/tasks-world'

// The person's task sources, as the task host last read them. Tasks belong to
// no project: the sources are a personal setting, and the client asks one host
// to read them (docs/tasks.md).

afterAll(disposeTasksWorlds)
afterEach(() => jest.useRealTimers())

const repo = sourceState(REPO_SOURCE_KEY).source
const board = sourceState(BOARD_SOURCE_KEY).source

describe('which host reads the sources', () => {
  test('this device reads them when it runs agents, not the primary connection', async () => {
    // WHY: the device is the person's own machine with their provider
    // connection. One host reads the sources, so a second connected host is
    // not asked and does not start a provider read of its own.
    const world = await createTasksWorld()
    world.setSources([repo])
    const asked: string[] = []
    world.connections.registerPrimary('workshop', { tasksSources: async () => { asked.push('workshop'); return [] } })
    world.connections.registerHost('local', { tasksSources: async () => { asked.push('local'); return [sourceState(REPO_SOURCE_KEY)] } })

    await world.taskSourcesStore.load()

    expect(asked).toEqual(['local'])
    expect(world.taskSourcesStore.host).toBe('local')
  })

  test('the primary connection reads them when the device cannot run agents', async () => {
    // WHY: on web and mobile there is no device host, and a device that holds
    // only attachments has no provider connection. The page must still show
    // the tasks of a machine the person connected.
    const world = await createTasksWorld()
    world.setSources([repo])
    world.attachmentOnlyHosts.add('local')
    const asked: string[] = []
    world.connections.registerPrimary('workshop', { tasksSources: async () => { asked.push('workshop'); return [sourceState(REPO_SOURCE_KEY)] } })
    world.connections.registerHost('local', { tasksSources: async () => { asked.push('local'); return [] } })

    await world.taskSourcesStore.load()

    expect(asked).toEqual(['workshop'])
    expect(world.taskSourcesStore.sources.map((source) => source.sourceKey)).toEqual([REPO_SOURCE_KEY])
  })

  test('with no host that runs agents, nothing is asked and the store says so', async () => {
    // WHY: the organization's Solus API holds attachments only. Asking it
    // fails on each load; the page says that no machine can read the sources.
    const world = await createTasksWorld()
    world.setSources([repo])
    world.attachmentOnlyHosts.add('cloud')
    let asked = 0
    world.connections.registerPrimary('cloud', { tasksSources: async () => { asked++; return [] } })

    await world.taskSourcesStore.load()

    expect(asked).toBe(0)
    expect(world.taskSourcesStore.host).toBeNull()
  })
})

describe('reading the sources', () => {
  test('one request sends the sources of the settings, and a force refresh says so', async () => {
    // WHY: the host has no copy of the person's settings to read; the client
    // sends them. The refresh control must reach the provider, not the host's copy.
    const world = await createTasksWorld()
    world.setSources([repo, board])
    const requests: Array<{ sources: unknown; opts: unknown }> = []
    world.connections.registerPrimary('local', {
      tasksSources: async (sources: unknown, opts?: unknown) => {
        requests.push({ sources, opts })
        return [sourceState(REPO_SOURCE_KEY), sourceState(BOARD_SOURCE_KEY)]
      },
    })

    await world.taskSourcesStore.load()
    await world.taskSourcesStore.load({ refresh: 'force' })

    expect(requests).toEqual([
      { sources: [repo, board], opts: undefined },
      { sources: [repo, board], opts: { refresh: 'force' } },
    ])
    expect(world.taskSourcesStore.sourceByKey.get(BOARD_SOURCE_KEY)?.columns.map((column) => column.name))
      .toEqual(['Todo', 'In progress', 'Shipped'])
  })

  test('a change of the sources in the settings reads them again', async () => {
    // WHY: a source added on another device arrives by account sync. The
    // Tasks page must show its tasks without a manual refresh.
    const world = await createTasksWorld()
    const requests: unknown[] = []
    world.connections.registerPrimary('local', {
      tasksSources: async (sources: unknown) => {
        requests.push(sources)
        return [sourceState(REPO_SOURCE_KEY)]
      },
    })

    world.setSources([repo])
    await settle()

    expect(requests).toEqual([[repo]])
    expect(world.taskSourcesStore.sources.map((source) => source.sourceKey)).toEqual([REPO_SOURCE_KEY])
  })

  test('a person with no source asks nothing and has no source', async () => {
    // WHY: the last source was removed. Its tasks must leave the page, and the
    // host has nothing to read.
    const world = await createTasksWorld()
    world.setSources([repo])
    let asked = 0
    world.connections.registerPrimary('local', { tasksSources: async () => { asked++; return [sourceState(REPO_SOURCE_KEY)] } })
    await world.taskSourcesStore.load()

    world.setSources([])
    await settle()

    expect(asked).toBe(1)
    expect(world.taskSourcesStore.sources).toEqual([])
  })

  test('a failed read keeps the last answer on screen and says why it failed', async () => {
    // WHY: a host that fails one read did not lose the sources. An empty page
    // would read as "you have no task source" and offer the setup.
    const world = await createTasksWorld()
    world.setSources([repo])
    let fail = false
    world.connections.registerPrimary('local', {
      tasksSources: async () => {
        if (fail) throw new Error('The host did not answer.')
        return [sourceState(REPO_SOURCE_KEY)]
      },
    })
    await world.taskSourcesStore.load()

    fail = true
    await world.taskSourcesStore.load()
    expect(world.taskSourcesStore.error).toBe('The host did not answer.')
    expect(world.taskSourcesStore.sources.map((source) => source.sourceKey)).toEqual([REPO_SOURCE_KEY])

    fail = false
    await world.taskSourcesStore.load()
    expect(world.taskSourcesStore.error).toBeNull()
  })

  test('an older answer never replaces a newer one', async () => {
    // WHY: a slow read from before a source was added would otherwise remove
    // the source that the person just added.
    const world = await createTasksWorld()
    world.setSources([repo, board])
    const slow = Promise.withResolvers<TaskSourceState[]>()
    let reads = 0
    world.connections.registerPrimary('local', {
      tasksSources: () => reads++ === 0 ? slow.promise : Promise.resolve([sourceState(REPO_SOURCE_KEY), sourceState(BOARD_SOURCE_KEY)]),
    })

    const older = world.taskSourcesStore.load()
    await world.taskSourcesStore.load()
    slow.resolve([sourceState(REPO_SOURCE_KEY)])
    await older

    expect(world.taskSourcesStore.sources.map((source) => source.sourceKey)).toEqual([REPO_SOURCE_KEY, BOARD_SOURCE_KEY])
  })

  test('says that it refreshes while a read is in flight, and while the host reads a source from its provider', async () => {
    // WHY: the header spinner describes the read of GitHub or Jira, which
    // goes on after the host answered its copy. A spinner that stops early lies.
    const world = await createTasksWorld()
    world.setSources([repo])
    const answer = Promise.withResolvers<TaskSourceState[]>()
    let next: Promise<TaskSourceState[]> = answer.promise
    world.connections.registerPrimary('local', { tasksSources: () => next })

    const load = world.taskSourcesStore.load()
    expect(world.taskSourcesStore.refreshing).toBe(true)
    answer.resolve([sourceState(REPO_SOURCE_KEY, { refreshing: true })])
    await load
    expect(world.taskSourcesStore.refreshing).toBe(true)

    next = Promise.resolve([sourceState(REPO_SOURCE_KEY)])
    await world.taskSourcesStore.load()
    expect(world.taskSourcesStore.refreshing).toBe(false)
  })
})

describe('when the task host says that its sources changed', () => {
  test('several events of one refresh cause one read', async () => {
    // WHY: one refresh of four sources ends as four events. Nothing here
    // polls: the event is the only cause of a new read.
    jest.useFakeTimers()
    const world = await createTasksWorld()
    world.setSources([repo])
    await settle()
    const reads: string[] = []
    const api = (name: string) => ({
      tasksSidebarSnapshot: async () => ({ tasks: [], sessionsByTask: {} }),
      tasksSources: async () => {
        reads.push(name)
        return [sourceState(REPO_SOURCE_KEY)]
      },
    })
    world.connections.registerPrimary('local', api('local'))
    world.connections.registerHost('workshop', api('workshop'))
    const store = new world.TasksStore()
    await store.ensureLoaded()
    expect(reads).toEqual([])

    world.connections.emit('local', 'tasks.sourcesChanged', { sourceKeys: [REPO_SOURCE_KEY] })
    world.connections.emit('local', 'tasks.sourcesChanged', { sourceKeys: [BOARD_SOURCE_KEY] })
    // Another host's read does not change what the task host answered.
    world.connections.emit('workshop', 'tasks.sourcesChanged', { sourceKeys: [REPO_SOURCE_KEY] })
    jest.advanceTimersByTime(99)
    expect(reads).toEqual([])
    jest.advanceTimersByTime(1)
    await settle()

    expect(reads).toEqual(['local'])
  })

  test('a host that reconnects is read again', async () => {
    // WHY: it missed its own events while it was away.
    const world = await createTasksWorld()
    world.setSources([repo])
    await settle()
    let reads = 0
    world.connections.registerPrimary('local', {
      tasksSidebarSnapshot: async () => ({ tasks: [], sessionsByTask: {} }),
      tasksSources: async () => {
        reads++
        return [sourceState(REPO_SOURCE_KEY)]
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

describe('the choices of the source setup', () => {
  const options: TaskSourceOptions = {
    github: { connected: true, repositories: [], projects: [] },
    jira: { connected: false, projects: [], boards: [] },
  }

  test('each open of the setup reads the choices again, from the task host', async () => {
    // WHY: a person connects GitHub or Jira in Settings between two opens. A
    // cached "not connected" would hide the Projects they just gave access to.
    const world = await createTasksWorld()
    let reads = 0
    world.connections.registerPrimary('local', {
      tasksSourceOptions: async () => ({ ...options, github: { connected: reads++ > 0, repositories: [], projects: [] } }),
    })

    expect(world.taskSourcesStore.options).toBeNull()
    await world.taskSourcesStore.loadOptions()
    expect(world.taskSourcesStore.options?.github.connected).toBe(false)
    await world.taskSourcesStore.loadOptions()
    expect(world.taskSourcesStore.options?.github.connected).toBe(true)
  })

  test('two surfaces that open at the same time share one read', async () => {
    const world = await createTasksWorld()
    let reads = 0
    world.connections.registerPrimary('local', { tasksSourceOptions: async () => { reads++; return options } })

    await Promise.all([world.taskSourcesStore.loadOptions(), world.taskSourcesStore.loadOptions()])
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
    await world.taskSourcesStore.loadOptions()

    fail = true
    expect(await world.taskSourcesStore.loadOptions()).toBeNull()
    expect(world.taskSourcesStore.optionsError).toBe('GitHub did not answer.')
    expect(world.taskSourcesStore.options).toEqual(options)

    fail = false
    await world.taskSourcesStore.loadOptions()
    expect(world.taskSourcesStore.optionsError).toBeNull()
  })
})
