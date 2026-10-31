import { expect, mock, spyOn, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { serverConnections } from '@solus/client-core/server-connections'
import { EMPTY_SESSION_VIEW, UNSETTLED_SESSION_STATE } from '@solus/contracts/session-state'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import { SessionSidebarStore } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'

const undos: Array<{ message: string; onUndo: () => void }> = []
mock.module('@solus/workspace-ui/lib/toasts', () => ({
  toasts: { undo: (message: string, onUndo: () => void) => { undos.push({ message, onUndo }) }, error: () => {} },
}))

// The X on a row (docs/plans/session-archive.md): a started session's row
// archives the session in this person's list, at its home, on every device. A task's row and a
// session that has not started only leave this client.

type Harness = Pick<SessionSidebarStore, 'removeRow'> & {
  session: unknown
  closeTask(row: SidebarTask): void
}

/** A store with no reactive fields: the rows the list holds are given. */
function harness<T extends Harness>(rows: SidebarTask[] = []): T {
  const store = Object.create(SessionSidebarStore.prototype) as T
  Object.defineProperty(store, 'catalogTasks', { value: rows })
  return store
}

function row(fields: Partial<SidebarTask>): SidebarTask {
  return { key: 'row', id: 'row', tabIds: [], title: 'Row', ...fields } as SidebarTask
}

test('the X archives a started session on its host and closes its tab', async () => {
  const archived: Array<[string, boolean]> = []
  const api = spyOn(serverConnections, 'apiFor').mockReturnValue(asHostApi({
    sessionUpdate: async (sessionId, change) => {
      archived.push([sessionId, change.archived === true])
      return { state: UNSETTLED_SESSION_STATE, view: { ...EMPTY_SESSION_VIEW, archivedAt: 1 } }
    },
  }))
  const events = spyOn(serverConnections, 'eventsFor').mockReturnValue(new HostEventSubscriber())
  const store = harness()
  const closed: string[] = []
  store.closeTask = (closing) => closed.push(closing.key)
  store.session = {
    sessionFor: (tabId: string) => tabId === 'started-tab'
      ? { id: 'started', agentSessionId: 'provider-thread' }
      : { id: 'draft', agentSessionId: null },
    serverIdFor: () => 'host',
    tasksStore: { peek: () => undefined },
  }
  try {
    store.removeRow(row({ key: 'started-row', tabIds: ['started-tab'] }))
    store.removeRow(row({ key: 'listed-row', sessionId: 'listed', serverId: 'host' }))
    store.removeRow(row({ key: 'task-row', taskId: 'task-1' }))
    store.removeRow(row({ key: 'draft-row', tabIds: ['draft-tab'] }))
    await Promise.resolve()
    expect(closed).toEqual(['started-row', 'listed-row', 'task-row', 'draft-row'])
    expect(archived).toEqual([['started', true], ['listed', true]])
  } finally { api.mockRestore(); events.mockRestore() }
})

// The check settles a session for every person, so a mis-tap needs a way back:
// the same Undo that archive and snooze offer, on desktop, web, and mobile.
test('the check settles a session and its Undo makes the session active again', async () => {
  const settled: Array<[string, boolean]> = []
  const api = spyOn(serverConnections, 'apiFor').mockReturnValue(asHostApi({
    sessionUpdate: async (sessionId, change) => {
      settled.push([sessionId, change.settled === true])
      return {}
    },
  }))
  const events = spyOn(serverConnections, 'eventsFor').mockReturnValue(new HostEventSubscriber())
  undos.length = 0
  const store = harness<Harness & {
    canShelve(row: SidebarTask): boolean
    completeTask(row: SidebarTask): Promise<void>
  }>()
  store.canShelve = () => true
  store.closeTask = () => {}
  store.session = { tasksStore: { peek: () => undefined } }
  try {
    await store.completeTask(row({ key: 'listed-row', sessionId: 'listed', serverId: 'host', lifecycle: 'active' }))
    expect(settled).toEqual([['listed', true]])
    expect(undos.map((entry) => entry.message)).toEqual(['Session marked as completed.'])
    undos[0]!.onUndo()
    await Promise.resolve()
    expect(settled).toEqual([['listed', true], ['listed', false]])
  } finally { api.mockRestore(); events.mockRestore() }
})

// A session that delegated work is finished with its delegated sessions. When
// the person marks it done or archives it, its delegated sessions go with it:
// left behind, they lose the row they nest under and show as rows of their own.
test('the check and the X apply to every session the row delegated, and Undo returns them too', async () => {
  const changes: string[] = []
  const api = spyOn(serverConnections, 'apiFor').mockReturnValue(asHostApi({
    sessionUpdate: async (sessionId, change) => {
      changes.push(`${sessionId}:${change.settled ?? ''}${change.archived ?? ''}`)
      return {}
    },
  }))
  const events = spyOn(serverConnections, 'eventsFor').mockReturnValue(new HostEventSubscriber())
  undos.length = 0
  const parent = row({ key: 'parent-row', id: 'parent-row', tabIds: ['parent-tab'], lifecycle: 'active' })
  const child = row({ key: 'child-row', id: 'child-row', tabIds: ['child-tab'], lifecycle: 'active' })
  const grandchild = row({ key: 'grandchild-row', id: 'grandchild-row', tabIds: ['grandchild-tab'], lifecycle: 'active' })
  const unrelated = row({ key: 'unrelated-row', id: 'unrelated-row', tabIds: ['unrelated-tab'], lifecycle: 'active' })
  const sessions: Record<string, { id: string; agentSessionId: string; parentSessionId?: string }> = {
    'parent-tab': { id: 'parent', agentSessionId: 'thread' },
    'child-tab': { id: 'child', agentSessionId: 'thread', parentSessionId: 'parent' },
    'grandchild-tab': { id: 'grandchild', agentSessionId: 'thread', parentSessionId: 'child' },
    'unrelated-tab': { id: 'unrelated', agentSessionId: 'thread' },
  }
  const store = harness<Harness & {
    canShelve(row: SidebarTask): boolean
    canArchive(row: SidebarTask): boolean
    completeTask(row: SidebarTask): Promise<void>
  }>([parent, unrelated, child, grandchild])
  const closed: string[] = []
  store.canShelve = () => true
  store.canArchive = () => true
  store.closeTask = (closing) => closed.push(closing.key)
  store.session = {
    sessionFor: (tabId: string) => sessions[tabId],
    serverIdFor: () => 'host',
    tasksStore: { peek: () => undefined },
  }
  try {
    await store.completeTask(parent)
    expect(closed).toEqual(['child-row', 'grandchild-row', 'parent-row'])
    expect(changes).toEqual(['parent:true', 'child:true', 'grandchild:true'])
    undos.at(-1)!.onUndo()
    await Promise.resolve()
    expect(changes.slice(3)).toEqual(['parent:false', 'child:false', 'grandchild:false'])

    closed.length = 0
    changes.length = 0
    store.removeRow(parent)
    await Promise.resolve()
    expect(closed).toEqual(['child-row', 'grandchild-row', 'parent-row'])
    expect(changes).toEqual(['parent:true', 'child:true', 'grandchild:true'])
  } finally { api.mockRestore(); events.mockRestore() }
})
