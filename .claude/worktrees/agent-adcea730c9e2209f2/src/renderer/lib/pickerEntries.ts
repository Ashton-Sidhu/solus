import type { Session, SessionMeta, Tab } from '../../shared/types'
import {
  entryByline,
  entryFirstMessage,
  entryTimestamp,
  entryTitle,
  findOpenTabForSession,
  type PickerEntry,
} from './sessionUtils'

export type PickerRow =
  | { kind: 'header'; label: string }
  | { kind: 'entry'; entry: PickerEntry; entryIndex: number }

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
  const filtered = historySessions.filter(
    (meta) =>
      !findOpenTabForSession(
        meta.sessionId,
        lookup.tabs,
        lookup.sessions,
        lookup.tabOrder,
        meta.provider,
      ),
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

/**
 * Apply the search query (matches title, first message, or byline) then surface open
 * sessions first so they group under a dedicated "Open" header. Keyboard
 * selection indexes the returned array, so this ordering is the single source of
 * truth for both display and selection.
 */
export function filterEntries(entries: PickerEntry[], query: string): PickerEntry[] {
  const q = query.trim().toLowerCase()
  const base = q
    ? entries.filter(
        (e) =>
          entryTitle(e).toLowerCase().includes(q) ||
          entryFirstMessage(e).toLowerCase().includes(q) ||
          entryByline(e).toLowerCase().includes(q),
      )
    : entries
  return [
    ...base.filter((e) => e.kind === 'open'),
    ...base.filter((e) => e.kind === 'history'),
  ]
}

/**
 * Group filtered entries into rendered rows: open sessions first under "Open",
 * then history bucketed by recency. `entryIndex` is the running index of entry
 * rows only (headers excluded) so it lines up with keyboard selection.
 */
export function buildRows(
  filteredItems: PickerEntry[],
  timestampOf: (entry: PickerEntry) => number,
): PickerRow[] {
  if (filteredItems.length === 0) return []
  const now = new Date()
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime()
  const startOfYesterday = startOfToday - 86400000
  const startOfWeek = startOfToday - 6 * 86400000

  const buckets: Record<string, PickerEntry[]> = {
    Today: [],
    Yesterday: [],
    'This week': [],
    Earlier: [],
  }
  const openItems: PickerEntry[] = []

  for (const e of filteredItems) {
    if (e.kind === 'open') {
      openItems.push(e)
      continue
    }
    const ts = timestampOf(e)
    if (!ts) buckets.Earlier.push(e)
    else if (ts >= startOfToday) buckets.Today.push(e)
    else if (ts >= startOfYesterday) buckets.Yesterday.push(e)
    else if (ts >= startOfWeek) buckets['This week'].push(e)
    else buckets.Earlier.push(e)
  }

  const out: PickerRow[] = []
  let entryIndex = 0
  if (openItems.length > 0) {
    out.push({ kind: 'header', label: 'Open' })
    for (const e of openItems) {
      out.push({ kind: 'entry', entry: e, entryIndex })
      entryIndex++
    }
  }
  const order = ['Today', 'Yesterday', 'This week', 'Earlier'] as const
  for (const k of order) {
    const b = buckets[k]
    if (b.length === 0) continue
    out.push({ kind: 'header', label: k })
    for (const e of b) {
      out.push({ kind: 'entry', entry: e, entryIndex })
      entryIndex++
    }
  }
  return out
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

  #key(entry: PickerEntry): string {
    if (entry.kind === 'open') {
      return entry.session.agentSessionId
        ? `${entry.session.provider}:${entry.session.agentSessionId}`
        : `tab:${entry.tabId}`
    }
    return `${entry.meta.provider}:${entry.meta.sessionId}`
  }

  timestamp(entry: PickerEntry): number {
    const key = this.#key(entry)
    const cached = this.#ts.get(key)
    if (cached !== undefined) return cached
    const ts = entryTimestamp(entry)
    this.#ts.set(key, ts)
    return ts
  }

  sort(entries: PickerEntry[], settled: boolean): PickerEntry[] {
    const byTimestamp = [...entries].sort(
      (a, b) => this.timestamp(b) - this.timestamp(a),
    )
    if (!settled) return byTimestamp
    for (const entry of byTimestamp) {
      const key = this.#key(entry)
      if (!this.#order.has(key)) this.#order.set(key, this.#order.size)
    }
    return byTimestamp.sort(
      (a, b) => this.#order.get(this.#key(a))! - this.#order.get(this.#key(b))!,
    )
  }
}
