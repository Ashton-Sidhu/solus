import type { Task } from '@solus/contracts/task-types'
import type { SessionMeta, SessionSearchResult } from '@solus/contracts/types'
import { snippetWindow } from '@solus/contracts/search-snippet'
import type { SidebarSessionChild } from '../../../../contexts/workspace/session-sidebar.store.svelte'
import type { PreviewHitTarget } from '../../../../lib/preview.svelte'
import { taskPickerSections } from '../../../tasks/lib/task-picker-sections'
import type { ProjectFilterChoice } from '../../lib/task-list'
import {
  firstWordIndex,
  matchesEveryWord,
  PICKER_SORT_HINTS,
  queryWords,
  type PickerSort,
} from './picker-search'

/** Where a task matched the query. Decides its rank and what its row shows. */
export type TaskMatchField = 'title' | 'body' | 'id'

/** Where a query's words were found in a session: the evidence its row shows
 *  and the passage its preview opens on. */
export interface ConversationHit {
  /** The indexed message the words were found in. */
  messageId: number
  /** The passage that matched, cut around its first hit, with the index's
   *  markers still on the matched words. Render it through `snippetRuns`. */
  snippet: string
  /** When it was said; the row's date and its recency sort key. */
  ts: number
  /** The index's score. Lower is better; the relevance sort key. */
  rank: number
}

/**
 * A rendered row. Tasks and their expanded sessions share one `entryIndex`
 * sequence, so the arrow keys walk past headers and ⏎ always means "the thing
 * under the cursor" whether that is a task or one of its sessions.
 *
 * A conversation row is a session no task claims, found by what was said in
 * it. A session a task does claim is a session row whether its name or its
 * words matched; the hit, when there is one, rides on the row.
 */
export type PickerRow =
  | {
      kind: 'header'
      key: string
      label: string
      count: number
      /** The count is a cap the hosts stopped at, not everything that matched. */
      capped?: boolean
      /** How the section is ordered, stated so the reader never has to guess. */
      hint: string
      accent?: boolean
    }
  | {
      kind: 'task'
      key: string
      entryIndex: number
      task: Task
      sessions: SidebarSessionChild[]
      expanded: boolean
      /** Under a query, why this task is listed. */
      matchedIn?: TaskMatchField
      /** The passage of the body the query hit, when the title did not. */
      bodySnippet?: string
    }
  | {
      kind: 'session'
      key: string
      entryIndex: number
      task: Task
      session: SidebarSessionChild
      /** Drawn under its task with a spine. A query lists sessions flat instead. */
      nested: boolean
      /** Ends the spine at this row rather than running it into the next task. */
      isLast: boolean
      /** Under a query, the words found in the session's messages. Absent when
       *  only its name matched. */
      hit?: ConversationHit
    }
  | {
      kind: 'conversation'
      key: string
      entryIndex: number
      meta: SessionMeta
      hit: ConversationHit
    }

/** A row the keyboard can land on: everything except a section header. */
export type PickerEntry = Exclude<PickerRow, { kind: 'header' }>

/** The last path segment of the task's project, or "Inbox" when it has none. */
export function projectLabel(task: Task): string {
  if (!task.projectKey) return 'Inbox'
  return task.projectKey.replace(/\/$/, '').split('/').at(-1) || task.projectKey
}

/** The task's human id as it is shown everywhere: `T-<n>`. Empty for a task
 *  that has none yet. */
export function taskShortIdLabel(task: Task): string {
  return task.shortId === undefined ? '' : `T-${task.shortId}`
}

/** What a conversation row is called: the name the user or the agent gave the
 *  session, else its opening message, else its slug. */
export function conversationTitle(meta: SessionMeta): string {
  return (
    meta.customTitle
    || meta.firstMessage?.replace(/\s+/g, ' ')
    || meta.slug
    || 'Unnamed session'
  )
}

/** The folder a conversation ran in: its repo root, else its directory. */
export function conversationProjectLabel(meta: SessionMeta): string {
  const dir = (meta.projectRoot || meta.cwd || '').replace(/\/$/, '')
  return dir.split('/').at(-1) || '~'
}

/**
 * Every project the picker can scope to, with how many tasks each holds.
 *
 * Built from the picker's own list rather than from the sidebar's columns: a
 * project can hold plenty of work and still have no sidebar row on this
 * client, and a scope you cannot reach is not a scope. The composer's own
 * project leads and is always offered — a fresh project with no task yet must
 * still be nameable, which is the case that sent the user looking here.
 */
export function pickerProjectChoices(
  tasks: readonly Task[],
  current: { projectKey: string; label: string } | null,
): ProjectFilterChoice[] {
  const choices = new Map<string, ProjectFilterChoice>()
  if (current) choices.set(current.projectKey, { ...current, count: 0 })
  for (const task of tasks) {
    // Narrowing only: the contract still types the key as optional, though
    // nothing writes a task without one.
    const projectKey = task.projectKey
    if (!projectKey) continue
    const existing = choices.get(projectKey)
    if (existing) existing.count += 1
    else choices.set(projectKey, { projectKey, label: projectLabel(task), count: 1 })
  }
  return [...choices.values()]
}

/**
 * Where the query hit a task, best field first, or null for no hit. Every
 * word has to start a token of one field — the rule the hosts' index applies
 * to a message — so "auth flow" finds "Flow for auth" in either section and
 * a session and a task never disagree about what a query means. The id is
 * the human `T-<n>`; a status or a project path matched every task that
 * shared it, which was noise, not a hit.
 */
export function taskMatchField(task: Task, words: readonly string[]): TaskMatchField | null {
  if (!words.length) return 'title'
  if (matchesEveryWord(task.title, words)) return 'title'
  if (task.body && matchesEveryWord(task.body, words)) return 'body'
  const shortId = taskShortIdLabel(task)
  return shortId && matchesEveryWord(shortId, words) ? 'id' : null
}

export function sessionMatches(session: SidebarSessionChild, words: readonly string[]): boolean {
  return !words.length || matchesEveryWord(session.label, words)
}

/** The passage of `text` around the earliest word of the query, whitespace
 *  collapsed, with ellipses where it was cut. The row's second line. */
export function matchWindow(text: string, words: readonly string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const at = firstWordIndex(flat, words)
  if (at < 0) return flat.slice(0, 100)
  const start = Math.max(0, at - 32)
  const end = Math.min(flat.length, at + 72)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

export interface PickerRowsInput {
  tasks: Task[]
  query: string
  /** Scope the list to one project, or null to list every project. Every task
   *  has a project, so a scope is a plain equality test with no exception. */
  projectKey?: string | null
  /** How each section under a query is ordered. Relevance by default. */
  sort?: PickerSort
  sessionsFor: (task: Task) => SidebarSessionChild[]
  expandedTaskIds: ReadonlySet<string>
  /** Durable tasks currently visible in the session sidebar. */
  openTaskIds?: ReadonlySet<string>
  /** Durable tasks currently on the session sidebar's snoozed shelf. */
  snoozedTaskIds?: ReadonlySet<string>
  /** Sessions whose messages match the query, from every host searched. Only
   *  read under a query; an empty query has nothing to have matched. */
  conversations?: readonly SessionSearchResult[]
  /** A host stopped at its result cap, so `conversations` is not every hit. */
  conversationsCapped?: boolean
}

/**
 * Build the list.
 *
 * With no query the tasks sit in their lifecycle sections, newest first, and
 * a task shows its sessions only when the reader opened it.
 *
 * A query replaces that with two sections in a fixed order, each stating its
 * own rule: tasks the query hit, folded; then sessions it hit by name or by
 * what was said in them, flat, one row per session with its best evidence. A
 * session of a listed task is not repeated below it — the task row is its way
 * in. Both sections take the reader's order: best match first, or newest.
 */
export interface PickerList {
  rows: PickerRow[]
  /** The rows the keyboard can land on, in order. */
  entries: PickerEntry[]
  /** Tasks listed, for the footer. */
  taskCount: number
  /** Sessions listed or folded under listed tasks, for the footer. */
  sessionCount: number
  /** The session count is where the hosts stopped, not where the hits end. */
  sessionsCapped: boolean
  /** Tasks the query kept but the project scope removed. Zero when unscoped.
   *  The scope control states this so widening is a known quantity rather than
   *  a guess. */
  hiddenTaskCount: number
}

/**
 * Row heights, in CSS pixels, for the virtualiser.
 *
 * The list is virtualised, so a row's height has to be known before it is
 * painted; these are the same numbers the row markup sets, and a change to one
 * has to move with the other. The touch column is the phone's 44px-target
 * geometry; the pointer column is the desktop overlay's. The last session under
 * a task carries the nest's bottom padding so the spine can stop short of the
 * next task. A flat session row is a two-line row like a task's.
 */
export function pickerRowHeight(row: PickerRow, touch: boolean): number {
  if (row.kind === 'header') return touch ? 34 : 32
  if (row.kind === 'task' || row.kind === 'conversation') return touch ? 58 : 44
  if (!row.nested) return touch ? 58 : 44
  if (touch) return 50
  return row.isLast ? 36 : 32
}

interface KeptTask {
  task: Task
  sessions: SidebarSessionChild[]
  matchedIn: TaskMatchField
}

interface TaskSession {
  task: Task
  session: SidebarSessionChild
}

/** The task a session belongs to, and whether that task is in scope. */
interface SessionOwner extends TaskSession {
  inScope: boolean
}

/** The tasks the query and scope keep, and the sessions a query's words name. */
function keepMatches(input: PickerRowsInput, words: readonly string[]) {
  const scope = input.projectKey ?? null
  const kept: KeptTask[] = []
  const nameHits: TaskSession[] = []
  // Every task's sessions are read anyway; remember whose each is so a
  // conversation hit can find its task without a second pass.
  const ownerBySessionId = new Map<string, SessionOwner>()
  let hiddenTaskCount = 0
  for (const task of input.tasks) {
    const sessions = input.sessionsFor(task)
    const inScope = !scope || task.projectKey === scope
    for (const session of sessions) {
      if (session.sessionId && !ownerBySessionId.has(session.sessionId)) {
        ownerBySessionId.set(session.sessionId, { task, session, inScope })
      }
    }
    const matchedIn = taskMatchField(task, words)
    const matchingSessions = words.length
      ? sessions.filter((session) => sessionMatches(session, words))
      : []
    if (!matchedIn && matchingSessions.length === 0) continue
    if (!inScope) {
      hiddenTaskCount += 1
      continue
    }
    if (matchedIn) kept.push({ task, sessions, matchedIn })
    for (const session of matchingSessions) nameHits.push({ task, session })
  }
  return { kept, nameHits, ownerBySessionId, hiddenTaskCount }
}

/** One listing of the Sessions section, before it is given its row index. A
 *  name hit is the better claim on relevance — it is the session's title — so
 *  the listing remembers it even once a content hit takes the row. */
type SessionListing =
  | {
      kind: 'session'
      task: Task
      session: SidebarSessionChild
      hit?: ConversationHit
      ts: number
      nameMatched: boolean
    }
  | { kind: 'conversation'; meta: SessionMeta; hit: ConversationHit; ts: number; nameMatched: false }

function conversationHit(result: SessionSearchResult): ConversationHit {
  return {
    messageId: result.messageId,
    snippet: snippetWindow(result.snippet),
    ts: result.ts,
    rank: result.rank,
  }
}

/** Name hits first, then the index's score, then the date; or the date alone. */
function compareListings(sort: PickerSort) {
  return (a: SessionListing, b: SessionListing): number => {
    if (sort === 'relevance') {
      if (a.nameMatched !== b.nameMatched) return a.nameMatched ? -1 : 1
      const rankA = a.hit?.rank ?? Number.POSITIVE_INFINITY
      const rankB = b.hit?.rank ?? Number.POSITIVE_INFINITY
      if (rankA !== rankB) return rankA - rankB
    }
    return b.ts - a.ts
  }
}

/**
 * The sessions the query hit, one listing each.
 *
 * A name hit and a content hit on the same session are one listing carrying
 * the content hit: the passage is the better evidence, and its date is when
 * the words were said. A session of a task already listed above is left out —
 * the task row folds it — as is one of a task the scope removed, which the
 * host's own scope may not have caught.
 */
function matchedSessions(
  nameHits: readonly TaskSession[],
  conversations: readonly SessionSearchResult[],
  ownerBySessionId: ReadonlyMap<string, SessionOwner>,
  listedTaskIds: ReadonlySet<string>,
  sort: PickerSort,
): SessionListing[] {
  const byKey = new Map<string, SessionListing>()
  for (const { task, session } of nameHits) {
    if (listedTaskIds.has(task.id)) continue
    const key = session.sessionId ?? `tab:${session.tabId}`
    byKey.set(key, { kind: 'session', task, session, ts: session.lastActivityAt, nameMatched: true })
  }
  for (const result of conversations) {
    const sessionId = result.session.sessionId
    const hit = conversationHit(result)
    const owner = ownerBySessionId.get(sessionId)
    if (owner) {
      if (!owner.inScope || listedTaskIds.has(owner.task.id)) continue
      const nameMatched = byKey.get(sessionId)?.nameMatched ?? false
      byKey.set(sessionId, {
        kind: 'session', task: owner.task, session: owner.session, hit, ts: result.ts, nameMatched,
      })
    } else if (!byKey.has(sessionId)) {
      byKey.set(sessionId, { kind: 'conversation', meta: result.session, hit, ts: result.ts, nameMatched: false })
    }
  }
  return [...byKey.values()].sort(compareListings(sort))
}

const MATCH_RANK = { title: 0, body: 1, id: 2 } satisfies Record<TaskMatchField, number>

export function buildPickerRows(input: PickerRowsInput): PickerList {
  const words = queryWords(input.query)
  const sort = input.sort ?? 'relevance'
  const { kept, nameHits, ownerBySessionId, hiddenTaskCount } = keepMatches(input, words)

  const rows: PickerRow[] = []
  const entries: PickerEntry[] = []
  const push = (row: PickerEntry) => {
    rows.push(row)
    entries.push(row)
  }

  const pushTask = (item: KeptTask, expanded: boolean, words: readonly string[]) => {
    const { task } = item
    const row: PickerEntry = {
      kind: 'task',
      key: `task:${task.id}`,
      entryIndex: entries.length,
      task,
      sessions: item.sessions,
      expanded,
    }
    if (words.length) row.matchedIn = item.matchedIn
    if (words.length && item.matchedIn === 'body') row.bodySnippet = matchWindow(task.body ?? '', words)
    push(row)
    if (!expanded) return
    item.sessions.forEach((session, index) => {
      push({
        kind: 'session',
        key: `session:${task.id}:${session.sessionId ?? session.tabId ?? index}`,
        entryIndex: entries.length,
        task,
        session,
        nested: true,
        isLast: index === item.sessions.length - 1,
      })
    })
  }

  if (!words.length) {
    for (const section of lifecycleSections(kept, input)) {
      rows.push({
        kind: 'header',
        key: `header:${section.key}`,
        label: section.label,
        count: section.items.length,
        hint: PICKER_SORT_HINTS.recency,
        accent: section.accent ?? false,
      })
      for (const item of section.items) {
        pushTask(item, input.expandedTaskIds.has(item.task.id), [])
      }
    }
    return {
      rows,
      entries,
      taskCount: kept.length,
      sessionCount: kept.reduce((sum, item) => sum + item.sessions.length, 0),
      sessionsCapped: false,
      hiddenTaskCount,
    }
  }

  // Input order is newest first. Relevance ranks by field with a stable sort,
  // so recency stays the tiebreak; recency keeps the input order as it is.
  const rankedTasks = sort === 'relevance'
    ? kept.toSorted((a, b) => MATCH_RANK[a.matchedIn] - MATCH_RANK[b.matchedIn])
    : kept
  if (rankedTasks.length) {
    rows.push({
      kind: 'header',
      key: 'header:tasks',
      label: 'Tasks',
      count: rankedTasks.length,
      hint: PICKER_SORT_HINTS[sort],
    })
    // Folded unless the reader opened it: the row is the evidence, and opening
    // every hit pushed the other sections below the fold.
    for (const item of rankedTasks) pushTask(item, input.expandedTaskIds.has(item.task.id), words)
  }

  const listings = matchedSessions(
    nameHits,
    input.conversations ?? [],
    ownerBySessionId,
    new Set(rankedTasks.map((item) => item.task.id)),
    sort,
  )
  const sessionsCapped = !!input.conversationsCapped
  if (listings.length) {
    rows.push({
      kind: 'header',
      key: 'header:sessions',
      label: 'Sessions',
      count: listings.length,
      capped: sessionsCapped,
      hint: PICKER_SORT_HINTS[sort],
    })
    listings.forEach((listing, index) => {
      if (listing.kind === 'conversation') {
        push({
          kind: 'conversation',
          key: `conversation:${listing.meta.serverId ?? ''}:${listing.meta.sessionId}`,
          entryIndex: entries.length,
          meta: listing.meta,
          hit: listing.hit,
        })
        return
      }
      const { task, session } = listing
      const row: PickerEntry = {
        kind: 'session',
        key: `session-hit:${task.id}:${session.sessionId ?? session.tabId ?? index}`,
        entryIndex: entries.length,
        task,
        session,
        nested: false,
        isLast: false,
      }
      if (listing.hit) row.hit = listing.hit
      push(row)
    })
  }

  return {
    rows,
    entries,
    taskCount: rankedTasks.length,
    sessionCount: listings.length,
    sessionsCapped,
    hiddenTaskCount,
  }
}

interface LifecycleSection {
  key: string
  label: string
  items: KeptTask[]
  accent?: boolean
}

/**
 * The sections of an unqueried list: what the sidebar has open, what it has
 * snoozed, then every other task by lifecycle, as the Tasks page names them.
 */
function lifecycleSections(kept: readonly KeptTask[], input: PickerRowsInput): LifecycleSection[] {
  const openTaskIds = input.openTaskIds ?? new Set<string>()
  const snoozedTaskIds = input.snoozedTaskIds ?? new Set<string>()
  const open = kept.filter(
    (item) => item.task.status === 'in_progress' && openTaskIds.has(item.task.id),
  )
  const snoozed = kept.filter((item) => snoozedTaskIds.has(item.task.id))
  const liftedTaskIds = new Set([...open, ...snoozed].map((item) => item.task.id))
  const byTaskId = new Map(kept.map((item) => [item.task.id, item]))
  return [
    ...(open.length ? [{ key: 'sidebar-open', label: 'Open', items: open }] : []),
    ...(snoozed.length
      ? [{ key: 'sidebar-snoozed', label: 'Snoozed', items: snoozed, accent: true }]
      : []),
    ...taskPickerSections(
      kept.map((item) => item.task).filter((task) => !liftedTaskIds.has(task.id)),
    ).map((section) => ({
      key: section.key,
      label: section.label,
      items: section.tasks.map((task) => byTaskId.get(task.id)!),
    })),
  ]
}

/**
 * The host and message a row's preview opens on. Null when the row has no
 * hit — its name or its task matched — or no host to ask; the preview then
 * shows the session's ends as it always has.
 */
export function previewHitTarget(entry: PickerEntry | null): PreviewHitTarget | null {
  if (!entry || entry.kind === 'task') return null
  if (entry.kind === 'conversation') {
    const serverId = entry.meta.serverId
    return serverId
      ? { serverId, sessionId: entry.meta.sessionId, messageId: entry.hit.messageId }
      : null
  }
  const { serverId, sessionId } = entry.session
  return entry.hit && serverId && sessionId
    ? { serverId, sessionId, messageId: entry.hit.messageId }
    : null
}

/** The row the keyboard's cursor is on, or -1 when the list is empty. */
export function selectedRowIndex(rows: readonly PickerRow[], selectedIndex: number): number {
  return rows.findIndex((row) => row.kind !== 'header' && row.entryIndex === selectedIndex)
}

/**
 * Where `→` goes: a collapsed task opens, an open one steps into its first
 * session. Null when the key has nothing to do.
 */
export function expandTarget(
  entry: PickerEntry | undefined,
): { action: 'expand'; taskId: string } | { action: 'step' } | null {
  if (entry?.kind !== 'task' || entry.sessions.length === 0) return null
  return entry.expanded ? { action: 'step' } : { action: 'expand', taskId: entry.task.id }
}

/**
 * Where `←` goes: a nested session returns to its task, an open task closes.
 * The parent index is looked up in the built list, so it can never point at
 * a row the query has since removed.
 */
export function collapseTarget(
  entries: readonly PickerEntry[],
  selectedIndex: number,
): { action: 'select'; entryIndex: number } | { action: 'collapse'; taskId: string } | null {
  const entry = entries[selectedIndex]
  if (!entry) return null
  if (entry.kind === 'session') {
    if (!entry.nested) return null
    const parentIndex = entries.findIndex(
      (candidate) => candidate.kind === 'task' && candidate.task.id === entry.task.id,
    )
    return parentIndex >= 0 ? { action: 'select', entryIndex: parentIndex } : null
  }
  if (entry.kind === 'conversation') return null
  return entry.expanded ? { action: 'collapse', taskId: entry.task.id } : null
}
