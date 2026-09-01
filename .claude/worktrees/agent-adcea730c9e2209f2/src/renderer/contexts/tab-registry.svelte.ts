import { SvelteMap } from 'svelte/reactivity'
import type { InputState, Session, Tab } from '../../shared/types'
import { branchKeyFor } from '../lib/sessionUtils'
import { makeInputState } from './session.factories'

export class TabRegistry {
  tabs = $state<Record<string, Tab>>({})
  sessions = $state<Record<string, Session>>({})
  tabOrder = $state<string[]>([])
  activeTabId = $state('')
  activeInput = $state<InputState>(makeInputState())
  lastActiveTabByBranch = new SvelteMap<string, string>()

  get activeTab(): Tab | undefined {
    return this.tabs[this.activeTabId]
  }

  get activeSession(): Session | undefined {
    return this.sessionFor(this.activeTabId)
  }

  get currentInput(): InputState {
    return this.activeTab?.input ?? this.activeInput
  }

  sessionFor(tabId: string): Session | undefined {
    const tab = this.tabs[tabId]
    return tab ? this.sessions[tab.sessionId] : undefined
  }

  resolveTab(tabId: string): { sess: Session; tab: Tab } | null {
    const sess = this.sessionFor(tabId)
    const tab = this.tabs[tabId]
    return sess && tab ? { sess, tab } : null
  }

  setActiveTab(tabId: string): void {
    this.activeTabId = tabId
    const key = branchKeyFor(this.sessionFor(tabId))
    if (key && this.lastActiveTabByBranch.get(key) !== tabId) {
      this.lastActiveTabByBranch.set(key, tabId)
    }
  }

  lastActiveTabForBranch(branchKey: string): string | null {
    const tabId = this.lastActiveTabByBranch.get(branchKey)
    if (!tabId) return null
    if (!this.tabs[tabId]) return null
    const sess = this.sessionFor(tabId)
    if (branchKeyFor(sess) !== branchKey) return null
    if (sess?.loadingHistory) return null
    return tabId
  }

  addTabToOrder(tabId: string): void {
    if (!this.tabOrder.includes(tabId)) this.tabOrder.push(tabId)
  }

  reorderTab(tabId: string, targetTabId: string): void {
    if (tabId === targetTabId) return
    const from = this.tabOrder.indexOf(tabId)
    if (from === -1 || this.tabOrder.indexOf(targetTabId) === -1) return
    this.tabOrder.splice(from, 1)
    const insertAt = this.tabOrder.indexOf(targetTabId)
    this.tabOrder.splice(insertAt, 0, tabId)
  }

  pruneTabOrder(): void {
    const seen = new Set<string>()
    for (let i = 0; i < this.tabOrder.length; i += 1) {
      const tabId = this.tabOrder[i]
      if (!this.tabs[tabId] || seen.has(tabId)) {
        this.tabOrder.splice(i, 1)
        i -= 1
        continue
      }
      seen.add(tabId)
    }
  }

  forEachSiblingTab(tabId: string, fn: (siblingId: string) => void): void {
    const tab = this.tabs[tabId]
    if (!tab) return
    for (const siblingId of this.tabOrder) {
      if (siblingId === tabId) continue
      const siblingTab = this.tabs[siblingId]
      if (siblingTab?.sessionId === tab.sessionId) fn(siblingId)
    }
  }
}
