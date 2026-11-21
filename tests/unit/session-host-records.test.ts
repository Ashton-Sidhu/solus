import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { McpTask } from '@solus/contracts/integrations/mcp-task'
import type { ResourceWatch } from '@solus/contracts/integrations/resource-watch'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()
mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))
const { McpTasksStore, ResourceWatchesStore } = await import('@solus/workspace-ui/contexts/mcp/session-host-records.svelte')

/**
 * A session's MCP tasks and resource watches on desktop and web
 * (docs/plans/mcp-first-class.md §11.5, §12.5): read from the host that runs
 * the session, kept current by its change events, and never shown from a host
 * that is not ready, so no row keeps a state the host may no longer have.
 */

const task: McpTask = { id: 't1', sessionId: 's1', integrationName: 'Reports', tool: 'create_report', status: 'working', createdAt: 1_000, updatedAt: 1_000 }
const watch: ResourceWatch = {
  id: 'w1', sessionId: 's1', integrationName: 'Docs', uri: 'docs://notes', name: 'Release notes', state: 'watching',
  wakes: 0, createdAt: 1_000, updatedAt: 1_000, expiresAt: 86_401_000,
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => connections.reset())

describe('session host records', () => {
  test('a followed session shows its host list, then each change of one record in place', async () => {
    connections.registerHost('host-a', { mcpTaskList: async () => [task] })
    const store = new McpTasksStore()
    store.follow('host-a', 's1')
    await flush()
    expect(store.recordsOf('s1')).toEqual([task])

    connections.emit('host-a', 'mcpTask.changed', { sessionId: 's1', task: { ...task, status: 'completed', updatedAt: 2_000 } })
    connections.emit('host-a', 'mcpTask.changed', { sessionId: 's1', task: { ...task, id: 't2' } })
    // WHY: a change replaces the row of its id and keeps the order, so a row does not jump when its state moves.
    expect(store.recordsOf('s1').map((record) => [record.id, record.status])).toEqual([['t1', 'completed'], ['t2', 'working']])
  })

  test('a change from a host that does not run the session is not shown', async () => {
    connections.registerHost('host-a', { mcpTaskList: async () => [] })
    connections.registerHost('host-b', { mcpTaskList: async () => [] })
    const store = new McpTasksStore()
    store.follow('host-a', 's1')
    await flush()
    connections.emit('host-b', 'mcpTask.changed', { sessionId: 's1', task })
    expect(store.recordsOf('s1')).toEqual([])
  })

  test('a change before the first list arrives reads the whole list again', async () => {
    let reads = 0
    connections.registerHost('host-a', { integrationResourceWatchList: async () => { reads++; return [watch] } })
    const store = new ResourceWatchesStore()
    store.follow('host-a', 's1')
    connections.emit('host-a', 'integration.resourceWatchChanged', { sessionId: 's1', watch })
    await flush()
    expect(reads).toBe(2)
    expect(store.recordsOf('s1')).toEqual([watch])
  })

  test('a host that is not ready shows no records, drops a read in flight, and reads again when it is ready', async () => {
    let answer: (list: ResourceWatch[]) => void = () => {}
    let reads = 0
    connections.registerHost('host-a', {
      integrationResourceWatchList: () => { reads++; return new Promise<ResourceWatch[]>((resolve) => { answer = resolve }) },
    })
    const store = new ResourceWatchesStore()
    store.follow('host-a', 's1')
    connections.emitReadiness('host-a', 'reconnecting')
    answer([watch])
    await flush()
    expect(store.recordsOf('s1')).toEqual([])

    connections.emitReadiness('host-a', 'ready')
    answer([{ ...watch, wakes: 2 }])
    await flush()
    expect(reads).toBe(2)
    expect(store.recordsOf('s1').map((record) => record.wakes)).toEqual([2])
  })

  test('an equal list after a reconnect keeps the list it holds', async () => {
    connections.registerHost('host-a', { mcpTaskList: async () => [{ ...task }] })
    const store = new McpTasksStore()
    store.follow('host-a', 's1')
    await flush()
    const first = store.recordsOf('s1')
    connections.emitReadiness('host-a', 'ready')
    await flush()
    // WHY: a read again that changed nothing must not draw each row again.
    expect(store.recordsOf('s1')).toBe(first)
  })

  test('a host with no list method shows no rows, as a session without records does', async () => {
    connections.registerHost('host-a', { mcpTaskList: async () => { throw new Error('Unknown method') } })
    const store = new McpTasksStore()
    store.follow('host-a', 's1')
    await flush()
    expect(store.recordsOf('s1')).toEqual([])
    expect(store.recordsOf(null)).toEqual([])
  })

  test('a row command goes to the host that runs the session, and fails for a session not followed here', async () => {
    const stops: string[] = []
    connections.registerHost('host-a', { integrationResourceWatchList: async () => [watch] })
    connections.registerHost('host-b', {
      integrationResourceWatchList: async () => [watch],
      integrationResourceWatchStop: async (request: { id: string }) => { stops.push(`host-b:${request.id}`) },
    })
    const store = new ResourceWatchesStore()
    store.follow('host-a', 's1')
    // The session moved to another host.
    store.follow('host-b', 's1')
    await store.stop(watch)
    expect(stops).toEqual(['host-b:w1'])
    await expect(store.stop({ id: 'w9', sessionId: 's9' })).rejects.toThrow('This session is not shown here.')
  })
})
