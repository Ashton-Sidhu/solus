import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  flushDrafts,
  initDraftState,
  loadDismissedSidebarRowKeys,
  loadDrafts,
  loadPersistedTabs,
  patchActiveDraft,
  persistDismissedSidebarRow,
  removePersistedTab,
  savePersistedTabsDebounced,
  setTabPersistenceServerInstallationId,
  type PersistedTabs,
} from '../../src/renderer/contexts/workspace/tab-persistence'

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
    version: 1,
    activeTabId: 'tab-1',
    tabOrder: ['tab-1'],
    tabs: [{
      tabId: 'tab-1',
      title: 'Local work',
      agentSessionId: null,
      provider: null,
      handoffFrom: { provider: 'codex', sessionId: 'previous-session' },
      workingDirectory: '/repo',
      additionalDirs: [],
      gitContext: null,
      worktreeBaseBranch: null,
      modelConfig: {} as any,
      permissionMode: 'ask',
      hasUnread: false,
    }],
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
    setTabPersistenceServerInstallationId(null, { migrateLegacy: false })
  })

  afterEach(() => {
    setTabPersistenceServerInstallationId(null, { migrateLegacy: false })
    Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true })
    Object.defineProperty(globalThis, 'localStorage', { value: originalLocalStorage, configurable: true })
  })

  test('migrates existing desktop snapshots into the local installation key', () => {
    const snapshot = sampleSnapshot()
    storage.setItem('solus-open-tabs:editor', JSON.stringify(snapshot))

    setTabPersistenceServerInstallationId('local-install', { migrateLegacy: true })

    expect(loadPersistedTabs()).toEqual(snapshot)
    expect(storage.getItem('solus-open-tabs:local-install:editor')).toBe(JSON.stringify(snapshot))
    expect(storage.getItem('solus-open-tabs:editor')).toBeNull()
  })

  test('does not migrate legacy snapshots for a non-migration server scope', () => {
    storage.setItem('solus-open-tabs:editor', JSON.stringify(sampleSnapshot()))

    setTabPersistenceServerInstallationId('remote-install', { migrateLegacy: false })

    expect(loadPersistedTabs()).toBeNull()
    expect(storage.getItem('solus-open-tabs:editor')).not.toBeNull()
  })

  test('writes drafts under the active installation key so servers do not share input text', () => {
    setTabPersistenceServerInstallationId('local-install', { migrateLegacy: true })
    initDraftState(loadDrafts())

    patchActiveDraft('tab-1', 'tab draft', 'active draft')
    flushDrafts()

    expect(storage.getItem('solus-tab-drafts:local-install:editor')).toBe(JSON.stringify({
      activeInputText: 'active draft',
      tabs: { 'tab-1': 'tab draft' },
    }))
    expect(storage.getItem('solus-tab-drafts:editor')).toBeNull()
  })

  test('removes a closed tab from the queued snapshot immediately', () => {
    const snapshot = sampleSnapshot()
    snapshot.activeTabId = 'tab-2'
    snapshot.tabOrder.push('tab-2')
    snapshot.tabs.push({ ...snapshot.tabs[0], tabId: 'tab-2', title: 'Other work' })
    setTabPersistenceServerInstallationId('local-install', { migrateLegacy: true })

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
    setTabPersistenceServerInstallationId('local-install', { migrateLegacy: true })
    storage.setItem('solus-open-tabs:local-install:editor', JSON.stringify(snapshot))

    removePersistedTab('tab-1', 'tab-2')

    expect(loadPersistedTabs()).toEqual({
      ...snapshot,
      tabOrder: ['tab-2'],
      tabs: [snapshot.tabs[1]],
    })
  })

  test('persists dismissed sidebar tasks in the active server and window scope', () => {
    setTabPersistenceServerInstallationId('local-install', { migrateLegacy: true })

    persistDismissedSidebarRow('root-task')
    persistDismissedSidebarRow('root-task')
    persistDismissedSidebarRow('task:child-task')

    expect(loadDismissedSidebarRowKeys()).toEqual(['root-task', 'task:child-task'])
    expect(storage.getItem('solus-dismissed-sidebar-tasks:local-install:editor')).toBe(
      JSON.stringify(['root-task', 'task:child-task']),
    )

    setTabPersistenceServerInstallationId('remote-install', { migrateLegacy: false })
    expect(loadDismissedSidebarRowKeys()).toEqual([])
  })
})
