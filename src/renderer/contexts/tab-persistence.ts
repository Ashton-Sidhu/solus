import type { AgentId, ModelConfig, TabGitContext } from '../../shared/types'

// Tab state is scoped first by server installation, then by Electron window
// mode. The web client has one window, so it only gets the server scope.
// Legacy unscoped Electron keys seed the local editor installation; the pill
// starts fresh unless it has its own legacy mode-scoped key.
const LEGACY_TABS_KEY = 'solus-open-tabs'
const LEGACY_DRAFTS_KEY = 'solus-tab-drafts'

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
    if (window.solus.getPlatform() === 'web') return ''
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
  title: string
  agentSessionId: string | null
  provider: AgentId | null
  workingDirectory: string
  additionalDirs: string[]
  gitContext: TabGitContext | null
  worktreeBaseBranch: string | null
  modelConfig: ModelConfig
  permissionMode: string
  hasUnread: boolean
}

export interface PersistedTabs {
  version: 1
  activeTabId: string
  tabOrder: string[]
  tabs: PersistedTab[]
}

export function loadPersistedTabs(): PersistedTabs | null {
  try {
    const raw = readStorageWithMigration(LEGACY_TABS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (
      parsed?.version !== 1 ||
      !Array.isArray(parsed.tabs) ||
      typeof parsed.activeTabId !== 'string' ||
      !Array.isArray(parsed.tabOrder)
    ) return null
    return parsed as PersistedTabs
  } catch {
    return null
  }
}

export function savePersistedTabs(snapshot: PersistedTabs): void {
  try {
    localStorage.setItem(storageKey(LEGACY_TABS_KEY), JSON.stringify(snapshot))
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
