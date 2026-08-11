import type { AgentId, ContextUsage, GitCheckout, ModelConfig, SessionHandoffLineage, SessionSpec, SessionStatus, StartInfo } from '../../../shared/types'
import { localApi } from '@client-core/local-api'

// Tab state is scoped first by server installation, then by Electron window
// mode. The web client has one window, so it only gets the server scope.
// Legacy unscoped Electron keys seed the local editor installation; the pill
// starts fresh unless it has its own legacy mode-scoped key.
const LEGACY_TABS_KEY = 'solus-open-tabs'
const LEGACY_DRAFTS_KEY = 'solus-tab-drafts'
const DISMISSED_SIDEBAR_TASKS_KEY = 'solus-dismissed-sidebar-tasks'
// Last successful start() payload, scoped to the server installation (+ window
// mode) exactly like the tab snapshot so a different server never reads a stale
// environment. Applied optimistically on boot, then reconciled with fresh data.
const START_CACHE_KEY = 'solus-start-cache'
/** Prompts written but not yet sent, with the target they would run against. */
const SESSION_DRAFTS_KEY = 'solus-session-drafts'

let activeInstallationId: string | null = null
let shouldMigrateLegacyKeys = false

export function setTabPersistenceServerInstallationId(
  installationId: string | null | undefined,
  opts: { migrateLegacy?: boolean } = {},
): void {
  const normalized = installationId?.trim()
  activeInstallationId = normalized ? encodeURIComponent(normalized) : null
  shouldMigrateLegacyKeys = opts.migrateLegacy === true
}

function modeSuffix(): string {
  try {
    if (localApi.getPlatform() === 'web') return ''
    return new URLSearchParams(window.location.search).get('mode') === 'editor' ? ':editor' : ':pill'
  } catch {
    return ''
  }
}

function serverSuffix(): string {
  return activeInstallationId ? `:${activeInstallationId}` : ''
}

function storageKey(base: string): string {
  return base + serverSuffix() + modeSuffix()
}

function legacyMigrationKeys(base: string): string[] {
  if (!activeInstallationId || !shouldMigrateLegacyKeys) return []
  const suffix = modeSuffix()
  const keys = [base + suffix]
  if (suffix === ':editor') keys.push(base)
  return [...new Set(keys)].filter((key) => key !== storageKey(base))
}

function readStorageWithMigration(base: string): string | null {
  const key = storageKey(base)
  const raw = localStorage.getItem(key)
  if (raw) return raw

  for (const legacyKey of legacyMigrationKeys(base)) {
    const legacyRaw = localStorage.getItem(legacyKey)
    if (!legacyRaw) continue
    localStorage.setItem(key, legacyRaw)
    localStorage.removeItem(legacyKey)
    return legacyRaw
  }

  return null
}

export interface PersistedTab {
  tabId: string
  /** The renderer session this tab shows. Persisted because a chat route names
   *  a session, not a tab: without it the id would be re-minted on every boot
   *  and a restored split-chat pane would point at nothing. Missing in legacy
   *  snapshots, which mint one on restore. */
  sessionId?: string
  title: string
  /** Missing in legacy snapshots — an unnamed tab is free to be auto-named. */
  titleCustom?: boolean
  /** Saved-server registry id used for routing. Missing in legacy snapshots means local. */
  serverId?: string
  /** Stable server identity used to recover from a changed registry id after re-pairing. */
  serverInstallationId?: string
  agentSessionId: string | null
  provider: AgentId | null
  handoffFrom?: SessionHandoffLineage
  workingDirectory: string
  /** Stable sidebar grouping path for a checkout dispatched to another host. */
  projectGroupPath?: string | null
  additionalDirs: string[]
  gitContext: GitCheckout | null
  worktreeBaseBranch: string | null
  /** Missing in legacy snapshots, where the resolved base branch stands in. */
  worktreeRequested?: boolean
  /** The host that owns this run's task record. Missing in legacy snapshots,
   *  which restore it as the run's own host — a session that never dispatched. */
  taskServerId?: string
  modelConfig: ModelConfig
  permissionMode: string
  hasUnread: boolean
  /** Where a composer's first prompt will go. A started session reads its task
   *  from `task_session_links` instead, so this only ever matters for a tab that
   *  has yet to dispatch — which, now that composers are ordinary tabs, is a tab
   *  that survives a refresh and must come back under the same task. */
  pendingTaskId?: string | null
  pendingParentTaskId?: string | null
  /** The user's explicit "No task" for this composer, which is a choice and not
   *  an absence — restoring it as "mint one" would silently overrule them. */
  taskCreationDisabled?: boolean
  /** Provider history may omit the synthetic terminal error emitted live. */
  terminalFailure?: { content: string; timestamp: number } | null
  /** Neither provider's transcript carries token counts, so a resumed session
   *  would report an empty window until its next turn. Kept here and refreshed
   *  by the first usage report after resume. */
  contextUsage?: ContextUsage | null
  /** Lightweight live state restored before transcripts. This lets every sidebar
   * row show its status and turn clock on the first frame. */
  status?: SessionStatus
  currentTurnStartedAt?: number | null
}

export interface PersistedTabs {
  version: 1
  activeTabId: string
  tabOrder: string[]
  tabs: PersistedTab[]
  /** The serialized location — which routes were in which panes. Rides the same
   *  debounced write as the tabs, so there is one writer, not two. Absent in
   *  snapshots written before the workspace had a location. */
  location?: string
}

export function loadPersistedTabs(): PersistedTabs | null {
  try {
    const raw = readStorageWithMigration(LEGACY_TABS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed?.version !== 1 || !Array.isArray(parsed.tabs)) return null

    // Keep recoverable tabs even when an older or interrupted writer omitted
    // the selection fields. Rejecting the whole snapshot here makes startup
    // treat a real prior session as an empty workspace and open a composer.
    const persistedTabIds = parsed.tabs
      .map((tab: unknown) => (typeof (tab as { tabId?: unknown })?.tabId === 'string'
        ? (tab as { tabId: string }).tabId
        : null))
      .filter((tabId: string | null): tabId is string => !!tabId)
    const persistedTabIdSet = new Set(persistedTabIds)
    const tabOrder = Array.isArray(parsed.tabOrder)
      ? parsed.tabOrder.filter((tabId: unknown): tabId is string =>
          typeof tabId === 'string' && persistedTabIdSet.has(tabId))
      : []
    for (const tabId of persistedTabIds) {
      if (!tabOrder.includes(tabId)) tabOrder.push(tabId)
    }
    const activeTabId = typeof parsed.activeTabId === 'string'
      && persistedTabIdSet.has(parsed.activeTabId)
      ? parsed.activeTabId
      : tabOrder[0] ?? ''

    return { ...parsed, activeTabId, tabOrder } as PersistedTabs
  } catch {
    return null
  }
}

export function savePersistedTabs(snapshot: PersistedTabs): void {
  try {
    localStorage.setItem(storageKey(LEGACY_TABS_KEY), JSON.stringify(snapshot))
  } catch {}
}

// ─── Open session drafts ───
// A draft has no tab and no session, so it persists on its own key rather than
// riding a tab snapshot with nowhere to put it. Losing one on reload would lose
// a prompt the user had already written.

export interface PersistedSessionDrafts {
  version: 1
  /** Open order, so a restored workspace re-enters the one it left on. */
  order: string[]
  drafts: Record<string, SessionSpec>
}

export function loadPersistedSessionDrafts(): PersistedSessionDrafts | null {
  try {
    const raw = localStorage.getItem(storageKey(SESSION_DRAFTS_KEY))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed?.version !== 1 || !Array.isArray(parsed.order) || !parsed.drafts) return null
    return parsed as PersistedSessionDrafts
  } catch {
    return null
  }
}

// Drafts change on every keystroke, so the write is coalesced exactly like the
// tab snapshot: it only has to survive a reload, and a short debounce loses
// nothing but the writes.
let draftsTimer: ReturnType<typeof setTimeout> | null = null
let pendingSessionDrafts: PersistedSessionDrafts | null = null
let pendingSessionDraftsKey: string | null = null

export function savePersistedSessionDraftsDebounced(snapshot: PersistedSessionDrafts): void {
  pendingSessionDrafts = snapshot
  pendingSessionDraftsKey = storageKey(SESSION_DRAFTS_KEY)
  if (draftsTimer) return
  draftsTimer = setTimeout(flushPersistedSessionDrafts, 400)
}

/** Write any pending draft snapshot now — call on page hide so nothing is lost. */
export function flushPersistedSessionDrafts(): void {
  if (draftsTimer) {
    clearTimeout(draftsTimer)
    draftsTimer = null
  }
  if (!pendingSessionDrafts || !pendingSessionDraftsKey) return
  try {
    localStorage.setItem(pendingSessionDraftsKey, JSON.stringify(pendingSessionDrafts))
  } catch {}
  pendingSessionDrafts = null
  pendingSessionDraftsKey = null
}

// ─── Cached start() payload ───
// Optimistic boot cache for the primary host's start(). Lets the renderer paint
// staticInfo + agent metadata before the real RPC resolves; reconciled on fresh.

export function loadCachedStart(): StartInfo | null {
  try {
    const raw = localStorage.getItem(storageKey(START_CACHE_KEY))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    // Minimal shape guard — enough to trust it as a StartInfo before applying.
    if (typeof parsed?.version !== 'string' || !Array.isArray(parsed.agents)) return null
    return parsed as StartInfo
  } catch {
    return null
  }
}

export function saveCachedStart(info: StartInfo): void {
  try {
    localStorage.setItem(storageKey(START_CACHE_KEY), JSON.stringify(info))
  } catch {}
}

// The structural snapshot effect re-runs on git-context / unread / model changes
// (several fire mid-turn), and each run maps every tab + serialises to localStorage
// synchronously with the reactive tick. Coalesce the writes — the snapshot only
// needs to survive refresh/restart, so a short debounce loses nothing.
let tabsTimer: ReturnType<typeof setTimeout> | null = null
let pendingTabs: PersistedTabs | null = null
let pendingTabsKey: string | null = null

export function savePersistedTabsDebounced(snapshot: PersistedTabs): void {
  pendingTabs = snapshot
  pendingTabsKey = storageKey(LEGACY_TABS_KEY)
  if (tabsTimer) return
  tabsTimer = setTimeout(flushPersistedTabs, 400)
}

/** Write any pending tab snapshot immediately — call on page hide so nothing is lost. */
export function flushPersistedTabs(): void {
  if (tabsTimer) {
    clearTimeout(tabsTimer)
    tabsTimer = null
  }
  if (!pendingTabs || !pendingTabsKey) return
  try {
    localStorage.setItem(pendingTabsKey, JSON.stringify(pendingTabs))
  } catch {}
  pendingTabs = null
  pendingTabsKey = null
}

/** Remove a closed tab from both the queued snapshot and localStorage now.
 *  Closing is destructive UI state: if the renderer refreshes before the
 *  structural persistence effect runs, the tab must not be restored. */
export function removePersistedTab(tabId: string, activeTabId: string): void {
  const key = storageKey(LEGACY_TABS_KEY)
  const remove = (snapshot: PersistedTabs): PersistedTabs => ({
    ...snapshot,
    activeTabId,
    tabOrder: snapshot.tabOrder.filter((id) => id !== tabId),
    tabs: snapshot.tabs.filter((tab) => tab.tabId !== tabId),
  })

  if (pendingTabs && pendingTabsKey === key) {
    pendingTabs = remove(pendingTabs)
    flushPersistedTabs()
    return
  }

  try {
    const raw = localStorage.getItem(key)
    if (!raw) return
    const snapshot = JSON.parse(raw) as PersistedTabs
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.tabs) || !Array.isArray(snapshot.tabOrder)) return
    localStorage.setItem(key, JSON.stringify(remove(snapshot)))
  } catch {}
}

/** Durable tasks outlive their tabs, so closing a task row needs its own persisted
 *  view-state marker or the task and its linked child sessions return on refresh. */
export function loadDismissedSidebarRowKeys(): string[] {
  try {
    const raw = localStorage.getItem(storageKey(DISMISSED_SIDEBAR_TASKS_KEY))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((taskId): taskId is string => typeof taskId === 'string')
  } catch {
    return []
  }
}

/** Persist a dismissal synchronously because closing is destructive view state and
 *  must survive a refresh before Svelte's structural persistence effect runs. */
export function persistDismissedSidebarRow(rowKey: string): void {
  try {
    const rowKeys = new Set(loadDismissedSidebarRowKeys())
    rowKeys.add(rowKey)
    localStorage.setItem(storageKey(DISMISSED_SIDEBAR_TASKS_KEY), JSON.stringify([...rowKeys]))
  } catch {}
}

export function clearDismissedSidebarRowKeys(): void {
  try {
    localStorage.removeItem(storageKey(DISMISSED_SIDEBAR_TASKS_KEY))
  } catch {}
}

// Unsent input drafts live in their own key, written on a debounce. They change
// per-keystroke, so coalescing the writes keeps the structural snapshot above
// synchronous and stops the persist effect from re-running on every keypress.
export interface TabDrafts {
  activeInputText: string
  tabs: Record<string, string>
}

export function loadDrafts(): TabDrafts | null {
  try {
    const raw = readStorageWithMigration(LEGACY_DRAFTS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed?.activeInputText !== 'string' || typeof parsed?.tabs !== 'object') return null
    return parsed as TabDrafts
  } catch {
    return null
  }
}

// Internal mutable map populated from loadDrafts() so the persist effect only
// needs to update the active tab's entry per keystroke rather than re-reading
// every tab's input text each time.
let liveDraftTabs: Record<string, string> = {}
let liveActiveInputText = ''
let draftsDirty = false
let liveDraftsKey: string | null = null

export function initDraftState(initial: TabDrafts | null): void {
  liveDraftsKey = storageKey(LEGACY_DRAFTS_KEY)
  liveDraftTabs = { ...initial?.tabs ?? {} }
  liveActiveInputText = initial?.activeInputText ?? ''
}

export function patchActiveDraft(activeTabId: string, tabText: string, activeInputText: string): void {
  liveDraftTabs[activeTabId] = tabText
  liveActiveInputText = activeInputText
  draftsDirty = true
  scheduleDraftFlush()
}

/** Drop a closed tab's draft so the persisted map doesn't grow unbounded. Marks
 *  the store dirty + schedules a flush so the removal actually reaches storage —
 *  the per-keystroke `patchActiveDraft` only ever touches the active tab, so
 *  without this a closed tab's text would be re-persisted on every later flush. */
export function removeDraft(tabId: string): void {
  if (!(tabId in liveDraftTabs)) return
  delete liveDraftTabs[tabId]
  draftsDirty = true
  scheduleDraftFlush()
}

let draftTimer: ReturnType<typeof setTimeout> | null = null

function scheduleDraftFlush() {
  if (draftTimer) return
  draftTimer = setTimeout(flushDrafts, 400)
}

// Keep the old signature so existing callers compile without change, but
// prefer patchActiveDraft for per-keystroke updates.
export function saveDraftsDebounced(drafts: TabDrafts): void {
  liveDraftsKey = storageKey(LEGACY_DRAFTS_KEY)
  liveDraftTabs = { ...drafts.tabs }
  liveActiveInputText = drafts.activeInputText
  draftsDirty = true
  scheduleDraftFlush()
}

/** Write any pending drafts immediately — call on page hide so nothing is lost. */
export function flushDrafts(): void {
  if (draftTimer) {
    clearTimeout(draftTimer)
    draftTimer = null
  }
  if (!draftsDirty) return
  try {
    localStorage.setItem(liveDraftsKey ?? storageKey(LEGACY_DRAFTS_KEY), JSON.stringify({ activeInputText: liveActiveInputText, tabs: liveDraftTabs }))
  } catch {}
  draftsDirty = false
}
