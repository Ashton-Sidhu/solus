import { describe, expect, test } from 'bun:test'
import { SendOutbox } from '@solus/client-core/send-outbox'
import type { McpTask } from '@solus/contracts/integrations/mcp-task'
import type { ResourceWatch } from '@solus/contracts/integrations/resource-watch'
import { ConversationController } from '../../apps/mobile/solus-core/features/conversation/conversation-controller'
import { memoryKeyValueStore } from '../../apps/mobile/solus-core/platform/ports'
import { createHostWorld, FakeApi, flushPromises, healthFetch, type FakeTransport } from './helpers/native-mobile-fakes'
import { identityKeyFor } from './helpers/signing-host'

// The thread's MCP tasks and resource watches on the phone (docs/plans/mcp-first-class.md
// §11.5, §12.5) are the conversation controller's: one owner of the thread's host. The
// host sends one change event for each record and recovers a missed one by its list, so
// a row must not lose a change that came while the list was read, or one made while the
// phone was away.

const task = (status: McpTask['status'], updatedAt: number): McpTask => ({
  id: 'task-1', sessionId: 'thread-1', integrationName: 'Linear', tool: 'export', status, createdAt: 1, updatedAt,
})
const watch = (sessionId: string): ResourceWatch => ({
  id: `watch-${sessionId}`, sessionId, integrationName: 'Linear', uri: 'linear://issue/1', name: 'Issue 1', state: 'watching', wakes: 0, createdAt: 1, updatedAt: 1, expiresAt: 10,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function baseApi(): FakeApi {
  return new FakeApi()
    .on('describeSession', () => ({ lineage: null, meta: null }))
    .on('loadSessionPage', () => ({ messages: [], before: null }))
    .on('watchSession', () => ({ runtime: null }))
    .on('unwatchSession', () => undefined)
    .on('setSessionReadState', () => Date.now())
    .on('sessionSuggestions', () => [])
    .on('integrationResourceWatchList', () => [])
}

async function open(api: FakeApi) {
  const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
  await world.registry.load()
  await world.registry.savePaired({ id: 'inst-a', identityKey: identityKeyFor('inst-a'), label: 'A', url: 'http://a:1' }, 'ta')
  const connection = world.connections.connection('inst-a')!
  const transport = world.transports[0] as FakeTransport
  await transport.accept()
  const outboxStorage = memoryKeyValueStore()
  const controller = new ConversationController({
    hostId: 'inst-a',
    record: { sessionId: 'thread-1', provider: 'claude-code', projectPath: '/work/app', cwd: '/work/app', model: null, reasoningEffort: null, title: 'Fix it', customTitle: null },
  }, {
    connection,
    outbox: new SendOutbox(() => outboxStorage),
    runSettings: async () => ({ defaultPermissionMode: 'auto', defaultModels: {}, modelOptionsByProvider: {} }),
    organizationId: () => null,
    uuid: () => 'client-1',
    onChange: () => undefined,
  })
  return { transport, controller }
}

describe('native thread records feed', () => {
  test('a change that comes while the list is read is not lost', async () => {
    // WHY: the host started the task after it read the list, and sent its event before the
    // list arrived. Writing the older list over that change hides a running task until the next one.
    const firstList = deferred<McpTask[]>()
    const lists = [() => firstList.promise, () => [task('working', 2)]]
    const api = baseApi().on('mcpTaskList', () => lists.shift()!())
    const { transport, controller } = await open(api)
    void controller.load()
    await flushPromises()
    transport.emit('mcpTask.changed', { sessionId: 'thread-1', task: task('working', 2) })
    firstList.resolve([])
    await flushPromises()
    expect(controller.mcpTasks.list).toEqual([task('working', 2)])
    controller.close()
  })

  test('a reset of the host reads the list again', async () => {
    // WHY: an event sent while the phone was away is lost with the old socket; the host
    // recovers it only through the list, so a task that ended then would show as running.
    let hostTask = task('working', 2)
    const api = baseApi().on('mcpTaskList', () => [hostTask])
    const { transport, controller } = await open(api)
    await controller.load()
    await flushPromises()
    expect(controller.mcpTasks.list).toEqual([task('working', 2)])
    hostTask = task('completed', 3)
    await transport.accept(false)
    // The reload is one opening read, then the list: let it finish.
    for (let step = 0; step < 10 && api.callsOf('mcpTaskList').length < 2; step++) await flushPromises()
    await flushPromises()
    expect(controller.mcpTasks.list).toEqual([task('completed', 3)])
    controller.close()
  })

  test('a closed thread drops a read in flight and stops following its events', async () => {
    // WHY: a screen that is gone must not keep the host's records or tell a listener of them.
    const list = deferred<McpTask[]>()
    const api = baseApi().on('mcpTaskList', () => list.promise)
    const { transport, controller } = await open(api)
    void controller.load()
    await flushPromises()
    let notified = 0
    controller.mcpTasks.changes.subscribe(() => { notified += 1 })
    controller.close()
    list.resolve([task('working', 2)])
    transport.emit('mcpTask.changed', { sessionId: 'thread-1', task: task('completed', 3) })
    await flushPromises()
    expect(controller.mcpTasks.list).toEqual([])
    expect(notified).toBe(0)
  })

  test("each kind follows only its own session's events", async () => {
    // WHY: one host serves many sessions; another thread's watch is not a row of this one.
    const api = baseApi().on('mcpTaskList', () => [])
    const { transport, controller } = await open(api)
    await controller.load()
    await flushPromises()
    transport.emit('integration.resourceWatchChanged', { sessionId: 'thread-2', watch: watch('thread-2') })
    transport.emit('integration.resourceWatchChanged', { sessionId: 'thread-1', watch: watch('thread-1') })
    expect(controller.resourceWatches.list).toEqual([watch('thread-1')])
    expect(controller.mcpTasks.list).toEqual([])
    controller.close()
  })
})
