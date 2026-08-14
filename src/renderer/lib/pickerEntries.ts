import type { Session, SessionMeta, Tab } from '../../shared/types'
import {
  entryByline,
  entryFirstMessage,
  entryTimestamp,
  entryTitle,
  type PickerEntry,
} from './sessionUtils'

/** Tab/session maps needed to detect which history sessions are already open. */
export interface SessionLookup {
  tabs: Record<string, Tab>
  sessions: Record<string, Session>
  tabOrder: string[]
}

/**
 * Turn raw history metadata into picker entries: drop sessions already open in a
 * tab, then collapse worktree duplicates onto their non-worktree twin (same first
 * message) so a session and its worktree don't both show.
 */
export function dedupeHistoryEntries(
  historySessions: SessionMeta[],
  lookup: SessionLookup,
): PickerEntry[] {
  // Index the open tabs once instead of scanning tabOrder per history row —
  // this runs inside a reactive getter on every streamed history batch, so the
  // per-row scan made the whole pass O(history × tabs).
  const openSessionKeys = new Set<string>()
  for (const tabId of lookup.tabOrder) {
    const tab = lookup.tabs[tabId]
    if (!tab) continue
    const session = lookup.sessions[tab.sessionId]
    const provider = session?.run.provider
    if (!provider) continue
    openSessionKeys.add(`${provider}:${tab.sessionId}`)
    if (session.agentSessionId) openSessionKeys.add(`${provider}:${session.agentSessionId}`)
  }
  const filtered = historySessions.filter(
    (meta) => !openSessionKeys.has(`${meta.provider}:${meta.sessionId}`),
  )
  const nonWorktreeMessages = new Set(
    filtered
      .filter((meta) => !meta.isWorktree && meta.firstMessage)
      .map((meta) => meta.firstMessage),
  )

  return filtered
    .filter(
      (meta) =>
        !meta.isWorktree ||
        !meta.firstMessage ||
        !nonWorktreeMessages.has(meta.firstMessage),
    )
    .map((meta) => ({ kind: 'history' as const, meta }))
}

/** Stable identity for a picker entry, independent of the wrapper object that
 *  dedupe/derive recreate on every pass: an open tab keyed by its agent
 *  session (or tab id before one exists), a history session keyed by
 *  provider+sessionId. */
function entryKey(entry: PickerEntry): string {
  if (entry.kind === 'open') {
    return entry.session.agentSessionId
      ? `${entry.session.run.provider}:${entry.session.agentSessionId}`
      : `tab:${entry.tabId}`
  }
  return `${entry.meta.provider}:${entry.meta.sessionId}`
}

function buildSearchText(entry: PickerEntry): string {
  return `${entryTitle(entry)}\n${entryFirstMessage(entry)}\n${entryByline(entry)}`.toLowerCase()
}

type SearchCacheRecord =
  | { kind: 'open'; tabTitle: string; messageCount: number; byline: string; searchText: string }
  | { kind: 'history'; meta: SessionMeta; searchText: string }

/**
 * Caches each entry's lowercased "title + first message + byline" blob so
 * filtering on every keystroke only runs a substring search against it,
 * rather than re-deriving and re-lowercasing the underlying (possibly very
 * long) first message text every time. Keyed by stable identity rather than
 * the `PickerEntry` wrapper, since dedupe recreates that wrapper on every
 * pass.
 *
 * A history entry's cache stays valid as long as its `SessionMeta` reference
 * is unchanged (history only gets new meta objects from an actual rescan). An
 * open entry's tab/session objects are mutated in place, so reference
 * equality can't detect a rename, a new message, or a working-directory swap
 * (e.g. resuming into a worktree); instead it stays valid while the tab
 * title, message count, and byline — all cheap to read — are unchanged.
 */
export class SearchTextCache {
  #cache = new Map<string, SearchCacheRecord>()

  get size(): number {
    return this.#cache.size
  }

  get(entry: PickerEntry): string {
    const key = entryKey(entry)
    const cached = this.#cache.get(key)
    if (entry.kind === 'history') {
      if (cached?.kind === 'history' && cached.meta === entry.meta) return cached.searchText
      const searchText = buildSearchText(entry)
      this.#cache.set(key, { kind: 'history', meta: entry.meta, searchText })
      return searchText
    }
    const tabTitle = entry.session.title
    const messageCount = entry.session.messages.length
    const byline = entryByline(entry)
    if (
      cached?.kind === 'open' &&
      cached.tabTitle === tabTitle &&
      cached.messageCount === messageCount &&
      cached.byline === byline
    ) {
      return cached.searchText
    }
    const searchText = buildSearchText(entry)
    this.#cache.set(key, { kind: 'open', tabTitle, messageCount, byline, searchText })
    return searchText
  }

  /**
   * Warm the cache for every entry in one pass — called on the empty-query
   * (all-entries) render so the first keystroke never pays for building
   * search text from scratch. Also prunes records for entries no longer in
   * `entries` (closed tabs, sessions that fell out of history) so the cache
   * doesn't grow unbounded across reopens.
   */
  prepare(entries: PickerEntry[]) {
    const liveKeys = new Set<string>()
    for (const entry of entries) {
      liveKeys.add(entryKey(entry))
      this.get(entry)
    }
    if (this.#cache.size > liveKeys.size) {
      for (const key of this.#cache.keys()) {
        if (!liveKeys.has(key)) this.#cache.delete(key)
      }
    }
  }
}

/**
 * Apply the search query (matches title, first message, or byline) — the single
 * source of truth for both display and keyboard selection order. A single pass
 * over `entries` that preserves whatever order the caller (`FrozenEntryOrder`)
 * already produced; it does not repartition open entries ahead of history.
 */
export function filterEntries(
  entries: PickerEntry[],
  query: string,
  searchCache: SearchTextCache,
): PickerEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries
  return entries.filter((entry) => searchCache.get(entry).includes(q))
}

/**
 * Holds the picker's sort order stable while it's open.
 *
 * Two things would otherwise make rows jump under the cursor:
 *  - an open session's live timestamp ticking as messages stream, and
 *  - a new entry appearing mid-session (e.g. a background resume).
 *
 * `timestamp()` freezes each entry's timestamp on first sight. `sort()` orders
 * newest-first by that frozen timestamp; once `settled` it also freezes the
 * resulting position, so any entry seen later appends to the end instead of
 * sorting into the middle. `reset()` clears both when the picker reopens or its
 * project scope changes.
 */
export class FrozenEntryOrder {
  #ts = new Map<string, number>()
  #order = new Map<string, number>()

  reset() {
    this.#ts.clear()
    this.#order.clear()
  }

  timestamp(entry: PickerEntry): number {
    const key = entryKey(entry)
    const cached = this.#ts.get(key)
    if (cached !== undefined) return cached
    const ts = entryTimestamp(entry)
    this.#ts.set(key, ts)
    return ts
  }

  sort(entries: PickerEntry[], settled: boolean): PickerEntry[] {
    // Decorate once — entryKey builds a string, so calling it inside a
    // comparator allocates O(n log n) keys per pass instead of O(n). The picker
    // re-sorts on every history scan batch, so the comparators stay pure
    // number lookups.
    const decorated = entries.map((entry) => {
      const key = entryKey(entry)
      let frozenTimestamp = this.#ts.get(key)
      if (frozenTimestamp === undefined) {
        frozenTimestamp = entryTimestamp(entry)
        this.#ts.set(key, frozenTimestamp)
      }
      return { entry, key, frozenTimestamp }
    })
    decorated.sort((a, b) => b.frozenTimestamp - a.frozenTimestamp)
    if (settled) {
      for (const item of decorated) {
        if (!this.#order.has(item.key)) this.#order.set(item.key, this.#order.size)
      }
      decorated.sort((a, b) => this.#order.get(a.key)! - this.#order.get(b.key)!)
    }
    return decorated.map((item) => item.entry)
  }
}
