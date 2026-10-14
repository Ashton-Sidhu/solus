import { expect, spyOn, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { serverConnections } from '@solus/client-core/server-connections'
import { ACTIVE_SESSION_STATE } from '@solus/contracts/session-state'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import { SessionSidebarStore } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'

// The X on a row (docs/plans/session-archive.md): a started session's row
// archives the session on its host, for every device. A task's row and a
// session that has not started only leave this client.

type Harness = Pick<SessionSidebarStore, 'removeRow'> & {
  session: unknown
  closeTask(row: SidebarTask): void
}

function row(fields: Partial<SidebarTask>): SidebarTask {
  return { key: 'row', id: 'row', tabIds: [], title: 'Row', ...fields } as SidebarTask
}

test('the X archives a started session on its host and closes its tab', async () => {
  const archived: Array<[string, boolean]> = []
  const api = spyOn(serverConnections, 'apiFor').mockReturnValue(asHostApi({
    sessionSetArchived: async (sessionId, isArchived) => {
      archived.push([sessionId, isArchived])
      return { ...ACTIVE_SESSION_STATE, archivedAt: 1 }
    },
  }))
  const events = spyOn(serverConnections, 'eventsFor').mockReturnValue(new HostEventSubscriber())
  const store = Object.create(SessionSidebarStore.prototype) as Harness
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
