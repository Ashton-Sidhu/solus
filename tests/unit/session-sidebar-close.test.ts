import { describe, expect, test } from 'bun:test'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import { SessionSidebarStore } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'

type SidebarStoreHarness = Pick<SessionSidebarStore, 'closeTask'> & {
  closedTabIds: string[]
  closeTabs: (tabIds: string[]) => void
  catalogTasks: SidebarTask[]
  activeTasks: SidebarTask[]
  openedDraftCount: number
  openedDraftOptions: Array<{ freshTask?: boolean; via?: string; reveal?: boolean }>
  hasSettledBootLocation: boolean
  settleBootLocation: () => void
  session: unknown
}

function sidebarStoreForDismissal(): SidebarStoreHarness {
  const store = Object.create(SessionSidebarStore.prototype) as SidebarStoreHarness
  store.closedTabIds = []
  store.catalogTasks = []
  store.activeTasks = []
  store.openedDraftCount = 0
  store.openedDraftOptions = []
  store.hasSettledBootLocation = false
  // A conversation on screen is the case the composer fallback exists for; a
  // pane already showing a draft or a page needs nothing.
  store.session = {
    showsConversation: false,
    tasksStore: { loaded: true, tasks: [] },
    drafts: { openSessionDraft: (options: { freshTask?: boolean; via?: string; reveal?: boolean } = {}) => {
      store.openedDraftCount += 1
      store.openedDraftOptions.push(options)
    } },
  }
  store.closeTabs = (tabIds: string[]) => {
    store.closedTabIds.push(...tabIds)
  }
  return store
}

describe('session sidebar dismissal', () => {
  test('closing a running row unloads its session tab', () => {
    // WHY: a closed sidebar row must not still appear as an open session in
    // the picker. Its provider history remains durable and can be resumed.
    const store = sidebarStoreForDismissal()
    const task = {
      id: 'loose-tab',
      key: 'loose-tab',
      title: 'Background work',
      projectKey: '/repo',
      projectLabel: 'repo',
      groupKey: '/repo',
      branchName: null,
      serverId: null,
      status: 'running',
      attention: 'running',
      unread: false,
      createdAt: 0,
      runStartedAt: 1,
      tabIds: ['loose-tab'],
    } satisfies SidebarTask

    store.closeTask(task)

    expect(store.closedTabIds).toEqual(['loose-tab'])
  })

  test('ending the last active row composes a new prompt', () => {
    // WHY: closing a tab falls through to whichever tab sits beside it, and a
    // completed session can still hold one. Ending the column's last live row
    // must not land the user in work they already finished.
    const store = sidebarStoreForDismissal()
    ;(store.session as { showsConversation: boolean }).showsConversation = true
    store.activeTasks = []

    store.closeTask({
      id: 'root',
      lifecycle: 'active',
      tabIds: ['root-tab'],
    } as SidebarTask)

    expect(store.openedDraftOptions).toEqual([{ freshTask: true, via: 'click' }])
  })

  test('closing the final active tab composes a fresh draft', () => {
    // WHY: closeTabs can open the replacement draft before the row-specific
    // fallback runs. It must not inherit the completed tab that becomes the
    // registry fallback in that interval.
    const store = sidebarStoreForDismissal()
    Object.assign(store, {
      sessionRows: [],
      workingRows: [],
      sharedRows: [],
      snoozedTasks: [],
      completedTasks: [],
      activeTasks: [],
    })
    store.session = {
      activeTabId: 'root-tab',
      tabs: {},
      showsConversation: true,
      closeTab: () => {},
      selectTab: () => {},
      drafts: {
        // The draft is minted before the close, so it reads the closing
        // conversation's project, then opened once the tab is gone.
        createSessionDraft: (options: { freshTask?: boolean; via?: string }) => {
          store.openedDraftOptions.push(options)
          return { id: 'draft-1' }
        },
        openDraft: () => {},
      },
    }

    SessionSidebarStore.prototype.closeTabs.call(store, ['root-tab'])

    expect(store.openedDraftOptions).toEqual([{ freshTask: true, sourceId: 'root-tab', via: 'click' }])
  })

  test('ending a row while others are still live keeps the pane where it is', () => {
    // WHY: the composer fallback exists only for an emptied column. Yanking the
    // user off a conversation that still has live siblings would be a worse
    // interruption than the one it fixes.
    const store = sidebarStoreForDismissal()
    ;(store.session as { showsConversation: boolean }).showsConversation = true
    store.activeTasks = [{ id: 'other' } as SidebarTask]

    store.closeTask({
      id: 'root',
      lifecycle: 'active',
      tabIds: ['root-tab'],
    } as SidebarTask)

    expect(store.openedDraftCount).toBe(0)
  })

  test('tidying an already shelved row composes nothing', () => {
    // WHY: dismissing a completed row is housekeeping, not the end of live
    // work, so it must not move the user off whatever they were reading.
    const store = sidebarStoreForDismissal()
    ;(store.session as { showsConversation: boolean }).showsConversation = true
    store.activeTasks = []

    store.closeTask({
      id: 'root',
      lifecycle: 'completed',
      tabIds: ['root-tab'],
    } as SidebarTask)

    expect(store.openedDraftCount).toBe(0)
  })

})

describe('session sidebar boot location', () => {
  const bootStore = (): SidebarStoreHarness => {
    const store = sidebarStoreForDismissal()
    ;(store.session as { showsConversation: boolean }).showsConversation = true
    return store
  }

  test('launching with every task finished composes a prompt instead', () => {
    // WHY: the snapshot restores whichever conversation was last on screen, and
    // its task can have been completed since. Launching into finished work is
    // the same wrong landing that ending the last task avoids.
    const store = bootStore()
    store.activeTasks = []

    store.settleBootLocation()

    expect(store.openedDraftCount).toBe(1)
  })

  test('the boot composer does not change the restored route', () => {
    // WHY: launch must not steal the screen. Seeding a draft on an empty
    // workspace already opens quietly; landing on one has to match.
    const store = bootStore()
    store.activeTasks = []

    store.settleBootLocation()

    expect(store.openedDraftOptions).toEqual([{ freshTask: true, reveal: false }])
  })

  test('launching with live work restores that conversation', () => {
    // WHY: the restored location is what the user left open. An active row
    // means it is still live work, so boot must leave them in it.
    const store = bootStore()
    store.activeTasks = [{ id: 'live' } as SidebarTask]

    store.settleBootLocation()

    expect(store.openedDraftCount).toBe(0)
  })

  test('nothing is decided until the task store has answered', () => {
    // WHY: rows are empty while the snapshot loads, so deciding then would send
    // every launch to a draft and drop the restored conversation.
    const store = bootStore()
    ;(store.session as { tasksStore: { loaded: boolean } }).tasksStore.loaded = false
    store.activeTasks = []

    store.settleBootLocation()

    expect(store.openedDraftCount).toBe(0)
    expect(store.hasSettledBootLocation).toBe(false)
  })

  test('completing the last task later still lands on a draft', () => {
    // WHY: boot decides once. Opening a completed task afterwards is a
    // deliberate choice, and the run-time rule — not this one — owns what
    // happens when live work ends.
    const store = bootStore()
    store.activeTasks = [{ id: 'live' } as SidebarTask]
    store.settleBootLocation()

    store.activeTasks = []
    store.settleBootLocation()

    expect(store.openedDraftCount).toBe(0)
  })
})
