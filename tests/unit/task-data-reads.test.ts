import { expect, test } from 'bun:test'
import { TaskDataStore } from '@solus/client-core/task-data'
import { taskReadOptionsSchema, type TaskReadOptions } from '@solus/contracts/task-read'
import type { TaskDetails } from '@solus/contracts/task-types'
import type { TaskProviderData } from '@solus/contracts/task-data'
import { RPC_INVOKE_METHODS } from '@solus/contracts/rpc'
import { FakeApi } from './helpers/native-mobile-fakes'
import { deferred, hostWorld } from './helpers/native-mobile-prs-fixtures'

const details: TaskDetails = {
  task: {
    id: 'github:I1',
    providerId: 'github',
    kind: 'issue',
    title: 'Fix login',
    body: 'Description',
    url: null,
    state: { name: 'Open', category: 'open' },
    category: 'open',
    placements: [],
    labels: [],
    writableFields: [],
    updatedAt: 1
  },
  comments: [],
  links: [],
  activity: []
}
const provider: TaskProviderData = {
  author: 'Ada',
  assignees: [],
  reactions: [],
  events: [],
  pullRequests: [],
  historyCursor: 'older',
  capabilities: { history: true, reactions: true, multipleAssignees: true, templates: true }
}
async function storeWith(api: FakeApi) {
  const world = await hostWorld(api, { connected: true })
  return new TaskDataStore(details.task.id, () => world.connections.connection('inst-a')!.api)
}

test('normal detail reads stay compatible and concurrent readers share one request', async () => {
  const answer = deferred<TaskDetails>(),
    api = new FakeApi().on('tasksGet', () => answer.promise)
  const store = await storeWith(api),
    first = store.loadDetails(),
    second = store.loadDetails()
  expect(first).toBe(second)
  answer.resolve(details)
  await first
  expect(api.callsOf('tasksGet')).toEqual([[details.task.id]])
  expect(store.current.details.value).toEqual(details)
  expect(store.current.provider.value).toBeNull()
})

test('provider failures do not hide task content, and older history reads request no task body', async () => {
  let fail = true
  const api = new FakeApi().on('tasksGet', (_id: string, read?: TaskReadOptions) => {
    if (read?.section !== 'provider') return details
    if (fail) throw new Error('History rate limited')
    return { ...provider, historyCursor: read.cursor ? null : 'older' }
  })
  const store = await storeWith(api)
  await Promise.all([store.loadDetails(), store.loadProvider()])
  expect(store.current.details.value).toEqual(details)
  expect(store.current.provider.error).toBe('History rate limited')
  fail = false
  await store.loadProvider()
  await store.loadOlderHistory()
  expect(api.callsOf('tasksGet').slice(-1)).toEqual([
    [details.task.id, { section: 'provider', cursor: 'older' }]
  ])
  expect(store.current.provider.value?.historyCursor).toBeNull()
  expect(store.current.details.value).toEqual(details)
})

test('when the issue already has reactions and closing links, activity asks only for the timeline', async () => {
  const api = new FakeApi().on('tasksGet', () => ({ ...provider, author: null }))
  const store = await storeWith(api)
  const metadata = {
    author: 'Ada', assignees: [], reactions: [],
    pullRequests: [{
      url: 'https://github.com/acme/app/pull/7', number: 7, title: 'Fix login',
      state: 'open' as const, closesIssue: true,
    }],
  }
  await store.loadProvider(metadata)
  expect(api.callsOf('tasksGet')).toEqual([[details.task.id, { section: 'provider', timelineOnly: true }]])
  expect(store.current.provider.value).toMatchObject({ author: 'Ada', pullRequests: metadata.pullRequests })
})

test('an older host that ignores the requested section gives a retryable error', async () => {
  const store = await storeWith(new FakeApi().on('tasksGet', () => details))
  await store.loadDetails()
  await store.loadProvider()
  expect(store.current.details.value).toEqual(details)
  expect(store.current.provider.pending).toBe(false)
  expect(store.current.provider.error).toContain('Update the task host')
  expect(store.current.provider.value).toBeNull()
})

test('task read sections reject unrelated cursors and the separate inspection RPC is gone', () => {
  expect(taskReadOptionsSchema.safeParse({ section: 'details', cursor: 'older' }).success).toBe(
    false
  )
  expect(taskReadOptionsSchema.safeParse({ section: 'provider', cursor: '' }).success).toBe(false)
  expect(taskReadOptionsSchema.safeParse({ section: 'anything' }).success).toBe(false)
  expect(RPC_INVOKE_METHODS.some((method) => method === 'tasksGet')).toBe(true)
  expect(RPC_INVOKE_METHODS.some((method) => String(method) === 'tasksInspect')).toBe(false)
})

test('a refresh after a write cannot reuse or be overwritten by a read started before the write', async () => {
  const old = deferred<TaskDetails>(),
    started = deferred<void>()
  let reads = 0
  const updated = { ...details, task: { ...details.task, title: 'Updated title' } }
  const store = await storeWith(
    new FakeApi().on('tasksGet', () => {
      if (++reads === 1) {
        started.resolve()
        return old.promise
      }
      return updated
    })
  )
  const first = store.loadDetails()
  await started.promise
  await store.loadDetails({ refresh: true })
  old.resolve(details)
  await first
  expect(reads).toBe(2)
  expect(store.current.details.value?.task.title).toBe('Updated title')
})
