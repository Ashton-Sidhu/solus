import { SvelteMap } from 'svelte/reactivity'
import { hostKey } from '@solus/client-core/host-key'
import type { Prompt, Session, Tab } from '@solus/contracts/types'
import { branchKeyFor } from '../../lib/sessionUtils'
import { makePrompt } from './session.factories'

export class TabRegistry {
  tabs = $state<Record<string, Tab>>({})
  sessions = $state<Record<string, Session>>({})
  tabOrder = $state<string[]>([])
  activeTabId = $state('')
  /** The prompt with nowhere to go: no tab is selected, so there is no session
   *  to address. Handed to the first session that gets created. */
  activeInput = $state<Prompt>(makePrompt())
  lastActiveTabByBranch = new SvelteMap<string, string>()

  /**
   * The resolver: which tabs are listening to which session.
   *
   * Every "where is this session showing?" question goes through this one index
   * rather than scanning `tabOrder` with a hand-written predicate. A session may
   * have no tab (a headless agent, a draft that just dispatched) or several (a
   * split chat), and both answers are ordinary here — which is the whole point
   * of addressing work by session and resolving to tabs only to show it.
   */
  get tabIdsBySession(): Map<string, string[]> {
    const index = new Map<string, string[]>()
    for (const tabId of this.tabOrder) {
      const sessionId = this.tabs[tabId]?.sessionId
      if (!sessionId) continue
      const listening = index.get(sessionId)
      if (listening) listening.push(tabId)
      else index.set(sessionId, [tabId])
    }
    return index
  }

  /**
   * The same index against the *provider's* id rather than ours. A resumed or
   * forked conversation is the same agent session under a new renderer id, so a
   * work item or task link — which only ever knows the provider's id — resolves
   * through here.
   *
   * Keys are host-scoped: a dispatched session gives a second host a clone
   * under the same provider id, and those are two conversations, not one.
   */
  get tabIdsByAgentSession(): Map<string, string[]> {
    const index = new Map<string, string[]>()
    for (const tabId of this.tabOrder) {
      const session = this.sessionFor(tabId)
      if (!session) continue
      for (const agentId of [session.agentSessionId, session.forkedFromSessionId]) {
        if (!agentId) continue
        const key = hostKey(session.run.serverId, agentId)
        const listening = index.get(key)
        if (listening) {
          if (!listening.includes(tabId)) listening.push(tabId)
        } else index.set(key, [tabId])
      }
    }
    return index
  }

  get activeTab(): Tab | undefined {
    return this.tabs[this.activeTabId]
  }

  get activeSession(): Session | undefined {
    return this.sessionFor(this.activeTabId)
  }

  get currentInput(): Prompt {
    return this.activeSession?.prompt ?? this.activeInput
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
    const tab = this.tabs[tabId]
    if (tab) tab.hasUnread = false
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
}
