import { describe, expect, test } from 'bun:test'
import type { Session, Tab } from '@solus/contracts/types'
import type { SidebarLinkedTask, SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import { SessionSidebarStore } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'
import { folderLocation } from '@solus/workspace-ui/contexts/workspace/run-location'

type SessionRowHarness = {
  buildSessionRow: (tabId: string, session: Session, tab: Tab, linkedTask: SidebarLinkedTask | undefined) => SidebarTask
  session: {
    sessionFor: (tabId: string) => Session | undefined
    environment: { environmentFor: () => { repoRoot: string; cwd: string; branch: string; isolated: boolean } }
  }
  planStore: { plans: {} }
  lifecycleNow: number
}

type AcknowledgeHarness = Pick<SessionSidebarStore, 'acknowledgeRow'> & {
  snoozeRow: (rowKey: string, until: number | null) => void
}

describe('session sidebar unread state', () => {
  test('a session row reads its own unread output, whether or not it is linked to a task', () => {
    // WHY: every sidebar row is one session. A link to a task names the task
    // on a chip; it does not move the session's unread state anywhere else.
    const linked = session('linked')
    const tab: Tab = { id: 'tab-1', sessionId: linked.id, hasUnread: true }
    // SAFETY: the test supplies the inputs read by this one row builder.
    const store = Object.create(SessionSidebarStore.prototype) as SessionRowHarness
    store.session = {
      sessionFor: () => linked,
      environment: { environmentFor: () => ({ repoRoot: '/repo', cwd: '/repo', branch: 'main', isolated: false }) },
    }
    store.planStore = { plans: {} }
    store.lifecycleNow = 10
    const chip = { taskId: 'task-1', title: 'Ship the release' }

    const row = store.buildSessionRow(tab.id, linked, tab, chip)
    expect(row.unread).toBe(true)
    expect(row.tabIds).toEqual([tab.id])
    expect(row.linkedTask).toEqual(chip)

    tab.hasUnread = false
    expect(store.buildSessionRow(tab.id, linked, tab, undefined).unread).toBe(false)
  })

  test('opening a row clears its snooze only when the row is woken', () => {
    // WHY: the wake clear exists to drop a woken mark. Writing it on every
    // click makes the host invalidate every session surface for no visible
    // change.
    const woken: Array<[string, number | null]> = []
    // SAFETY: the test calls one prototype method and supplies what it reads.
    const store = Object.create(SessionSidebarStore.prototype) as AcknowledgeHarness
    store.snoozeRow = (rowKey, until) => { woken.push([rowKey, until]) }
    const row = { key: 'tab-1', woke: false } as SidebarTask

    store.acknowledgeRow(row)
    expect(woken).toEqual([])

    row.woke = true
    store.acknowledgeRow(row)
    expect(woken).toEqual([['tab-1', null]])
  })
})

function session(id: string): Session {
  return {
    id,
    status: 'completed',
    task: { kind: 'none' },
    agentSessionId: id,
    run: { location: folderLocation({ serverId: 'host-a', path: '/repo' }) },
    permissionQueue: [],
    questionQueue: [],
    messages: [],
  } as unknown as Session
}
