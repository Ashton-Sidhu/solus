import { expect, test } from 'bun:test'
import { TasksStore } from '@solus/client-core/tasks-store'
import type { TaskDetails, TaskSourceOptions, TaskSourceState } from '@solus/contracts/task-types'
import { taskSourceKey } from '@solus/contracts/task-sources'
import { identityKeyFor } from './helpers/signing-host'
import { createHostWorld, FakeApi, healthFetch } from './helpers/native-mobile-fakes'
import { REPO } from './helpers/task-fixtures'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const details: TaskDetails = {
  task: {
    id: 'github:I1',
    providerId: 'github',
    kind: 'issue',
    title: 'Fix login',
    body: '',
    url: null,
    state: { name: 'Open', category: 'open' },
    category: 'open',
    placements: [{ sourceKey: taskSourceKey(REPO), columnId: 'open' }],
    labels: [],
    writableFields: ['title'],
    updatedAt: 1
  },
  comments: [],
  activity: [],
  links: []
}
async function storeForApi(api: FakeApi) {
  const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
  await world.registry.load()
  await world.registry.savePaired(
    { id: 'inst-a', identityKey: identityKeyFor('inst-a'), label: 'A', url: 'http://a:1' },
    'ta'
  )
  const connection = world.connections.connection('inst-a')!
  return new TasksStore(
    () => connection.api,
    () => [REPO]
  )
}

test('an account reset clears details and ignores replies from the old account', async () => {
  const response = deferred<TaskDetails>()
  const api = new FakeApi().on('tasksGet', () => response.promise)
  const store = await storeForApi(api)
  const reading = store.detail(details.task.id)
  store.reset()
  response.resolve(details)
  await reading
  expect(store.current.details.size).toBe(0)
})

test('a source response from the old account cannot start more reads', async () => {
  const response = deferred<TaskSourceState[]>()
  const api = new FakeApi().on('tasksSources', () => response.promise)
  const store = await storeForApi(api)
  const reading = store.load()
  store.reset()
  response.resolve([])
  await reading
  expect(api.calls.map((call) => call.method)).toEqual(['tasksSources'])
  expect(store.current.pending).toBe(false)
})

test('an old options reply cannot restore a disconnected account name', async () => {
  const response = deferred<TaskSourceOptions>()
  const api = new FakeApi().on('tasksSourceOptions', () => response.promise)
  const store = await storeForApi(api)
  const reading = store.loadOptions()
  store.reset()
  response.resolve({
    github: { connected: false, repositories: [], projects: [] },
    jira: { connected: false, projects: [], boards: [] },
    linear: { connected: true, account: 'Old account', teams: [] }
  })
  await reading
  expect(store.current.options).toBeNull()
})

test('two page requests share one command and a failed page leaves details intact', async () => {
  const response = deferred<void>()
  const api = new FakeApi()
    .on('tasksGet', () => details)
    .on('tasksLoadMore', async () => {
      await response.promise
      throw new Error('rate limited')
    })
  const store = await storeForApi(api)
  await store.detail(details.task.id)
  const first = store.loadMore(REPO),
    second = store.loadMore(REPO)
  expect(first).toBe(second)
  response.resolve()
  await expect(first).rejects.toThrow('rate limited')
  expect(api.callsOf('tasksLoadMore')).toHaveLength(1)
  expect(store.current.details.get(details.task.id)?.task.title).toBe('Fix login')
  expect(store.current.loadingMore).toBe(false)
})
