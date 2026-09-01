import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  flushDrafts,
  initDraftState,
  loadDismissedSidebarRowKeys,
  loadOpenSidebarTaskIds,
  loadDrafts,
  loadPersistedTabs,
  patchActiveDraft,
  persistDismissedSidebarRow,
  persistOpenSidebarTaskIds,
  persistSidebarRowSnoozes,
  loadSidebarRowSnoozes,
  removeDismissedSidebarRows,
  removePersistedTab,
  savePersistedTabsDebounced,
  type PersistedTabs,
} from '@solus/workspace-ui/contexts/workspace/tab-persistence'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

const originalWindow = (globalThis as any).window
const originalLocalStorage = (globalThis as any).localStorage

function sampleSnapshot(): PersistedTabs {
  return {
    version: 2,
    activeTabId: 'tab-1',
    tabOrder: ['tab-1'],
    tabs: [{
      tabId: 'tab-1',
      sessionId: 'session-1',
      title: 'Local work',
      titleCustom: false,
      serverId: 'local',
      agentSessionId: null,
      provider: null,
      handoffFrom: { provider: 'codex', sessionId: 'previous-session' },
      workingDirectory: '/repo',
      additionalDirs: [],
      gitContext: null,
      worktreeBaseBranch: null,
      worktreeRequested: false,
      taskServerId: 'local',
      modelConfig: {} as any,
      permissionMode: 'ask',
      hasUnread: false,
    }],
    location: 'chat/session-1~local',
  }
}

describe('tab persistence server scoping', () => {
  let storage: MemoryStorage

  beforeEach(() => {
    storage = new MemoryStorage()
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
    Object.defineProperty(globalThis, 'window', {
      value: {
        location: { search: '?mode=editor' },
        solus: { getPlatform: () => 'darwin' },
      },
      configurable: true,
    })
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true })
    Object.defineProperty(globalThis, 'localStorage', { value: originalLocalStorage, configurable: true })
  })

  test('does not adopt a retired per-installation snapshot', () => {
    // WHY: the dispatch client has one client-wide namespace. Keeping the old
    // host-scoped read would make the boot host ambient again.
    const snapshot = sampleSnapshot()
    storage.setItem('solus-open-tabs:local-install:editor', JSON.stringify(snapshot))

    expect(loadPersistedTabs()).toBeNull()
    expect(storage.getItem('solus-open-tabs:editor')).toBeNull()
    expect(storage.getItem('solus-open-tabs:local-install:editor')).toBe(JSON.stringify(snapshot))
  })

  test('every boot host reads the same client-wide tab set', () => {
    // WHY: tabs each name their own host; which host the boot chose must not
    // decide which conversations reappear.
    const snapshot = sampleSnapshot()
    savePersistedTabsDebounced(snapshot)
    removePersistedTab('none', 'tab-1')

    expect(loadPersistedTabs()).not.toBeNull()
  })

  test('a snoozed row with no task survives a refresh, and an elapsed one does not', () => {
    // WHY: a conversation the user never made a task has nowhere durable to
    // keep a wake time, so this key is the whole feature — losing it on refresh
    // would put the row back in the list the user just cleared it from.
    // An elapsed snooze has already done its job; keeping it grows the key
    // without changing any row.
    const now = 1_000_000
    persistSidebarRowSnoozes(new Map([
      ['tab-live', { until: now + 60_000, note: 'check the deploy' }],
      ['tab-elapsed', { until: now - 1, note: null }],
    ]))

    expect(loadSidebarRowSnoozes(now)).toEqual(
      new Map([['tab-live', { until: now + 60_000, note: 'check the deploy' }]]),
    )
  })

  test('rejects an incomplete snapshot instead of guessing its selection', () => {
    const snapshot = sampleSnapshot()
    const { activeTabId: _activeTabId, tabOrder: _tabOrder, ...partialSnapshot } = snapshot
    storage.setItem('solus-open-tabs:editor', JSON.stringify(partialSnapshot))

    expect(loadPersistedTabs()).toBeNull()
  })

  test('writes drafts to the client-wide key — the draft follows its tab, not a host', () => {
    initDraftState(loadDrafts())

    patchActiveDraft('tab-1', 'tab draft', 'active draft')
    flushDrafts()

    expect(storage.getItem('solus-tab-drafts:editor')).toBe(JSON.stringify({
      activeInputText: 'active draft',
      tabs: { 'tab-1': 'tab draft' },
    }))
    expect(storage.getItem('solus-tab-drafts:local-install:editor')).toBeNull()
  })

  test('removes a closed tab from the queued snapshot immediately', () => {
    const snapshot = sampleSnapshot()
    snapshot.activeTabId = 'tab-2'
    snapshot.tabOrder.push('tab-2')
    snapshot.tabs.push({ ...snapshot.tabs[0], tabId: 'tab-2', title: 'Other work' })

    savePersistedTabsDebounced(snapshot)
    removePersistedTab('tab-1', 'tab-2')

    expect(loadPersistedTabs()).toEqual({
      ...snapshot,
      tabOrder: ['tab-2'],
      tabs: [snapshot.tabs[1]],
    })
  })

  test('removes a closed tab from the last flushed snapshot immediately', () => {
    const snapshot = sampleSnapshot()
    snapshot.activeTabId = 'tab-2'
    snapshot.tabOrder.push('tab-2')
    snapshot.tabs.push({ ...snapshot.tabs[0], tabId: 'tab-2', title: 'Other work' })
    storage.setItem('solus-open-tabs:editor', JSON.stringify(snapshot))

    removePersistedTab('tab-1', 'tab-2')

    expect(loadPersistedTabs()).toEqual({
      ...snapshot,
      tabOrder: ['tab-2'],
      tabs: [snapshot.tabs[1]],
    })
  })

  test('persists dismissed sidebar tasks in the client-wide window scope', () => {

    persistDismissedSidebarRow('root-task')
    persistDismissedSidebarRow('root-task')
    persistDismissedSidebarRow('task:child-task')

    expect(loadDismissedSidebarRowKeys()).toEqual(['root-task', 'task:child-task'])
    expect(storage.getItem('solus-dismissed-sidebar-tasks:editor')).toBe(
      JSON.stringify(['root-task', 'task:child-task']),
    )
  })

  test('restores selected sidebar rows without restoring unrelated rows', () => {
    // WHY: the task picker reverses dismissal for one task tree. It must not
    // reopen other tasks the user deliberately removed from the sidebar.
    persistDismissedSidebarRow('root-task')
    persistDismissedSidebarRow('session:attempt')
    persistDismissedSidebarRow('unrelated-task')

    removeDismissedSidebarRows(['root-task', 'session:attempt'])

    expect(loadDismissedSidebarRowKeys()).toEqual(['unrelated-task'])
  })

  test('persists the task rows opened by this client', () => {
    // WHY: host task data is shared, but each client must restore only its own
    // open sidebar rows after a cold start.
    expect(loadOpenSidebarTaskIds()).toBeNull()

    persistOpenSidebarTaskIds(['task-one', 'task-two'])

    expect(loadOpenSidebarTaskIds()).toEqual(['task-one', 'task-two'])
  })
})
