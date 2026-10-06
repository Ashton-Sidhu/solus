import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { TaskSnooze } from '@solus/contracts/task-types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()

mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))

let TaskSnoozesStore: typeof import('@solus/workspace-ui/contexts/tasks/task-snoozes.store.svelte')['TaskSnoozesStore']

beforeAll(async () => {
  ;({ TaskSnoozesStore } = await import('@solus/workspace-ui/contexts/tasks/task-snoozes.store.svelte'))
})

beforeEach(() => connections.reset())

/** A host that answers the reader's snoozes from `held`, as the server does. */
function hostHolding(held: Map<string, TaskSnooze>) {
  return {
    tasksSnoozes: async () => [...held.values()],
    tasksSnooze: async (taskId: string, until: number | null) => {
      if (until === null) held.delete(taskId)
      else held.set(taskId, { taskId, snoozedUntil: until })
      return held.get(taskId) ?? null
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the reader’s task snoozes', () => {
  test('reads the snoozes again when the host reconnects or says they changed', async () => {
    // WHY: the host holds the snooze. A client that reconnects, or a second
    // device of the same person, must show what the host holds now.
    const held = new Map<string, TaskSnooze>([['t1', { taskId: 't1', snoozedUntil: 1_000 }]])
    connections.registerPrimary('host-a', hostHolding(held))
    const store = new TaskSnoozesStore()
    store.start()
    await settle()
    expect(store.get('t1')?.snoozedUntil).toBe(1_000)

    // Another device woke it; this one hears only that its own snoozes changed.
    held.delete('t1')
    connections.emit('host-a', 'tasks.snoozesChanged', {})
    await settle()
    expect(store.get('t1')).toBeUndefined()

    // Snoozed again while this client was offline: the reconnect reads it.
    held.set('t1', { taskId: 't1', snoozedUntil: 2_000 })
    connections.emitPhase('host-a', 'connected')
    await settle()
    expect(store.get('t1')?.snoozedUntil).toBe(2_000)
  })

  test('a wake is not undone by a read that started before it', async () => {
    // WHY: waking early must hold. A slow read from before the wake would
    // otherwise put the task back to sleep on screen.
    const held = new Map<string, TaskSnooze>([['t1', { taskId: 't1', snoozedUntil: 5_000 }]])
    let releaseRead: () => void = () => {}
    const host = hostHolding(held)
    connections.registerPrimary('host-a', host)
    const store = new TaskSnoozesStore()
    store.start()
    await settle()

    const before = [...held.values()]
    host.tasksSnoozes = () => new Promise((resolve) => { releaseRead = () => resolve(before) })
    connections.emit('host-a', 'tasks.snoozesChanged', {})
    await store.snooze('host-a', 't1', null)
    releaseRead()
    await settle()
    expect(store.get('t1')).toBeUndefined()
  })
})
