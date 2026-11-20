import { expect, test } from 'bun:test'
import type { SyncAccount } from '@solus/client-core/document-sync'
import type { TaskSourceOptions } from '@solus/contracts/task-types'
import { tasksStoreFor } from '../../apps/mobile/src/features/tasks/tasks-store'
import { Listeners } from '../../apps/mobile/src/lib/listeners'
import { FakeApi } from './helpers/native-mobile-fakes'
import { deferred, hostWorld } from './helpers/native-mobile-prs-fixtures'
import { REPO } from './helpers/task-fixtures'

const options: TaskSourceOptions = {
  github: { connected: false, repositories: [], projects: [] },
  jira: { connected: false, projects: [], boards: [] },
  linear: { connected: false, teams: [] }
}
async function contextFor(api: FakeApi) {
  const world = await hostWorld(api, { connected: true })
  const account: {
    syncAccount: SyncAccount | null
    organizationId: string | null
    changes: Listeners
  } = {
    syncAccount: null,
    organizationId: null,
    changes: new Listeners()
  }
  return { ...world, account, personal: { current: () => ({ taskSources: [REPO] }) } }
}

test('reading the task store is lazy and shares state only within the same app and host', async () => {
  const api = new FakeApi(),
    first = await contextFor(api),
    second = await contextFor(api)
  const before = api.calls.length
  const store = tasksStoreFor(first, 'inst-a')
  expect(tasksStoreFor(first, 'inst-a')).toBe(store)
  expect(tasksStoreFor(first, 'other-host')).not.toBe(store)
  expect(tasksStoreFor(second, 'inst-a')).not.toBe(store)
  expect(api.calls.length).toBe(before)
})

test('account and organization changes clear shared state and reject late replies', async () => {
  const late = deferred<TaskSourceOptions>()
  let delayed = false
  const context = await contextFor(
    new FakeApi().on('tasksSourceOptions', () => (delayed ? late.promise : options))
  )
  const store = tasksStoreFor(context, 'inst-a')
  await store.loadOptions()
  context.account.changes.notify()
  expect(store.current.options).toEqual(options)
  delayed = true
  const reading = store.loadOptions()
  context.account.syncAccount = { origin: 'https://account.example', userId: 'another-person' }
  context.account.changes.notify()
  late.resolve(options)
  await reading
  expect(store.current.options).toBeNull()
  delayed = false
  await store.loadOptions()
  context.account.organizationId = 'another-organization'
  context.account.changes.notify()
  expect(store.current.options).toBeNull()
  expect(tasksStoreFor(context, 'inst-a')).toBe(store)
})

test('forgetting a host clears its task state and drops its cached store', async () => {
  const context = await contextFor(new FakeApi().on('tasksSourceOptions', () => options))
  const store = tasksStoreFor(context, 'inst-a')
  await store.loadOptions()
  await context.registry.forget('inst-a')
  expect(store.current.options).toBeNull()
  expect(tasksStoreFor(context, 'inst-a')).not.toBe(store)
})
