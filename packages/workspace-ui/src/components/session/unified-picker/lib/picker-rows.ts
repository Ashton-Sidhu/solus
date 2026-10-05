import { isChat } from '@solus/contracts/chat'
import { CHAT_LABEL } from '../../../../lib/paths'
import type { PickerResultType } from './picker-preferences'
import type { Task } from '@solus/contracts/task-types'
import type { SessionMeta, SessionSearchResult } from '@solus/contracts/types'
import { plainSnippet } from '@solus/contracts/search-snippet'
import type { SidebarSessionChild } from '../../../../contexts/workspace/session-sidebar.store.svelte'
import type { PreviewHitTarget } from '../../../../lib/preview.svelte'
import { taskPickerSections } from '../../../tasks/lib/task-picker-sections'
import { isDone } from '../../../tasks/lib/tasks-list-view'
import type { ProjectFilterChoice } from '../../lib/task-list'
import {
  firstWordIndex,
  flattenedLower,
  matchesEveryWord,
  PICKER_SORT_HINTS,
  queryWords,
  type PickerSort,
} from './picker-search'
import { activityScore, compareRelevance, nameScore, topHits, type Relevance } from './picker-relevance'
import { activeSince, keepsSession, keepsTask, NO_PICKER_FILTERS, type PickerFilters } from './picker-filters'
import {
  compareListings,
  matchedSessions,
  sessionIdentity,
  unclaimedSessions,
  type SessionListing,
  type SessionOwner,
  type TaskSession,
} from './picker-session-listings'

export { sessionIdentity } from './picker-session-listings'

/** Where a task matched the query. Decides its rank and what its row shows. */
export type TaskMatchField = 'title' | 'body' | 'id' | 'comment'

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
 * A conversation row is a session no task claims: found by what was said in
 * it, or listed among the newest while the box is empty. A session a task does
 * claim is a session row whether its name or its words matched; the hit, when
 * there is one, rides on the row.
 */
export type PickerRow =
  | {
      kind: 'header'
      key: string
      label: string
      count: number
      /** How the section is ordered, stated so the reader never has to guess. */
      hint: string
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
      additionalMatches?: ConversationHit[]
      hitServerId?: string
    }
  | {
      kind: 'conversation'
      key: string
      entryIndex: number
      meta: SessionMeta
      /** Absent for a session listed by its date or found by its name. */
      hit?: ConversationHit
      additionalMatches?: ConversationHit[]
      hitServerId?: string
    }
  | {
      /** The end of a list the hosts answer in pages. When it comes into view
       *  the next page is read; the keyboard reaches it by reaching the end. */
      kind: 'more'
      key: string
      /** Sessions that match and are not listed yet. */
      remaining: number
    }

/** A row the keyboard can land on: everything except a section header and the list's end. */
export type PickerEntry = Exclude<PickerRow, { kind: 'header' | 'more' }>

/**
 * Whether a task row is a group the reader opens: any task with a session,
 * unless the query matched the task itself.
 */
export function isTaskGroup(row: Extract<PickerRow, { kind: 'task' }>): boolean {
  return !row.matchedIn && row.sessions.length > 0
}

/** The last path segment of the task's project, or "Inbox" when it has none. */
export function projectLabel(task: Task): string {
  if (!task.projectKey) return 'Inbox'
  if (isChat(task.projectKey)) return CHAT_LABEL
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
 * still be nameable, which is the case that sent the user looking here. Every
 * known project follows, task or not: a project whose work is all sessions
 * must still be a scope.
 */
export function pickerProjectChoices(
  tasks: readonly Task[],
  current: { projectKey: string; label: string } | null,
  knownProjects: readonly { projectKey: string; label: string }[] = [],
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
  for (const project of knownProjects) {
    if (!choices.has(project.projectKey)) choices.set(project.projectKey, { ...project, count: 0 })
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
export function taskMatchField(task: Task, words: readonly string[], commentPassage?: string): TaskMatchField | null {
  if (!words.length) return 'title'
  if (matchesEveryWord(task.title, words)) return 'title'
  if (task.body && matchesEveryWord(task.body, words)) return 'body'
  const shortId = taskShortIdLabel(task)
  if (shortId && matchesEveryWord(shortId, words)) return 'id'
  // The hosts found the words across the task's comments (unified-search.md §7).
  return commentPassage ? 'comment' : null
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
  /** Which kinds of result the picker lists. */
  resultType?: PickerResultType
  /** Scope the list to one project, or null to list every project. Every task
   *  has a project, so a scope is a plain equality test with no exception. */
  projectKey?: string | null
  /** How each section under a query is ordered. Relevance by default. */
  sort?: PickerSort
  sessionsFor: (task: Task) => SidebarSessionChild[]
  expandedTaskIds: ReadonlySet<string>
  /** Durable tasks currently visible in the session sidebar. */
  openTaskIds?: ReadonlySet<string>
  /** Sessions that match the query, from every host searched, in the pages
   *  read so far. Only read under a query. */
  conversations?: readonly SessionSearchResult[]
  /** Matching sessions the hosts hold beyond the pages read. The list ends
   *  with a row that reads them. */
  conversationsRemaining?: number
  /** Every session on every host. Only read with an empty query, where the
   *  ones no task claims are listed beside the tasks. */
  recentSessions?: readonly SessionMeta[]
  /** Task id → the passage of its comment that holds the query's words. */
  commentPassages?: ReadonlyMap<string, string>
  /** What the reader narrowed the list to. None by default. */
  filters?: PickerFilters
  /** The clock recency is scored against. Now by default. */
  now?: number
}

/**
 * Build the list.
 *
 * With no query, tasks and the sessions no task claims are peers: one Recent
 * section, newest first, and a task shows its sessions only when the reader
 * opened it. Listing tasks alone, a session made without a task
 * (task-conversation.md §8) could only be found by a query. The Tasks result
 * type keeps the tasks in their lifecycle sections.
 *
 * A query replaces that with two sections in a fixed order, each stating its
 * own rule: tasks the query hit; then sessions it hit by name or by
 * what was said in them, flat, one row per session with its best evidence. A
 * matching session remains visible even if its task matches. Tasks do not
 * expand under a query. Both sections take the reader's order: best match first, or newest.
 *
 * Best match first also lifts the best few rows of both kinds into Top hits,
 * above the two sections. Without it the best session sat under every task
 * that matched at all, however weakly: the reader who typed a session's name
 * had to scroll past the task section to reach it. A row is listed once.
 */
export interface PickerList {
  rows: PickerRow[]
  /** The rows the keyboard can land on, in order. */
  entries: PickerEntry[]
  /** Tasks listed, for the footer. */
  taskCount: number
  /** Sessions listed or folded under listed tasks, and those the hosts hold
   *  beyond the pages read, for the footer. */
  sessionCount: number
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
 * has to move with the other. The last session under a task carries the nest's
 * bottom padding so the spine can stop short of the next task. A flat session
 * row is a two-line row like a task's.
 */
export function pickerRowHeight(row: PickerRow): number {
  if (row.kind === 'header' || row.kind === 'more') return 32
  if (row.kind === 'task' || row.kind === 'conversation') return 44
  if (!row.nested) return 44
  return row.isLast ? 36 : 32
}

interface KeptTask {
  task: Task
  sessions: SidebarSessionChild[]
  matchedIn: TaskMatchField
}

/** Where a kept task matched, as a tier and a score (`picker-relevance.ts`). */
function taskRelevance(item: KeptTask, words: readonly string[], now: number): Relevance {
  const { task } = item
  const activity = activityScore(task.updatedAt, now, isDone(task))
  if (item.matchedIn === 'title') return { tier: 'name', score: nameScore(task.title, words) + activity }
  // "T-4" names T-4 itself; that T-40 also starts with it is incidental.
  if (item.matchedIn === 'id' && flattenedLower(taskShortIdLabel(task)) === words.join(' ')) return { tier: 'id', score: activity }
  return { tier: 'evidence', score: activity }
}

/** The filters the reader chose, and the instant Updated keeps rows from. */
function narrowing(input: PickerRowsInput) {
  const filters = input.filters ?? NO_PICKER_FILTERS
  return { filters, since: activeSince(filters, input.now ?? Date.now()) }
}

/** Remember whose each session is, an in-scope task first, so a host's hit
 *  can find its task without a second pass. */
function rememberOwners(owners: Map<string, SessionOwner>, task: Task, sessions: readonly SidebarSessionChild[], inScope: boolean): void {
  for (const session of sessions) {
    if (!session.sessionId) continue
    const key = sessionIdentity(session)
    const held = owners.get(key)
    if (!held || (!held.inScope && inScope)) owners.set(key, { task, session, inScope })
  }
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
  const { filters, since } = narrowing(input)
  for (const task of input.tasks) {
    const sessions = input.sessionsFor(task).filter((session) => session.sessionId || session.tabId)
    const inScope = !scope || task.projectKey === scope
    rememberOwners(ownerBySessionId, task, sessions, inScope)
    const matchedIn = input.resultType === 'sessions' || !keepsTask(task, filters, since)
      ? null
      : taskMatchField(task, words, input.commentPassages?.get(task.id))
    const matchingSessions = input.resultType !== 'tasks' && (words.length || input.resultType === 'sessions')
      ? sessions.filter((session) => sessionMatches(session, words) && keepsSession(session.provider, session.lastActivityAt, filters, since))
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

/** A task this relevant. */
type RankedTask = KeptTask & { relevance: Relevance }

/** The list under construction: rows in order, and the ones the keyboard lands on. */
function rowWriter(input: PickerRowsInput) {
  const rows: PickerRow[] = []
  const entries: PickerEntry[] = []
  const push = (row: PickerEntry) => {
    rows.push(row)
    entries.push(row)
  }

  const task = (item: KeptTask, expanded: boolean, words: readonly string[]) => {
    const { task } = item
    const row: PickerEntry = {
      kind: 'task',
      key: `task:${task.id}`,
      entryIndex: entries.length,
      task,
      sessions: input.resultType === 'tasks' ? [] : item.sessions,
      expanded: !words.length && input.resultType !== 'tasks' && expanded,
    }
    if (words.length) row.matchedIn = item.matchedIn
    if (words.length && item.matchedIn === 'body') row.bodySnippet = matchWindow(task.body ?? '', words)
    if (words.length && item.matchedIn === 'comment') row.bodySnippet = matchWindow(plainSnippet(input.commentPassages?.get(task.id) ?? ''), words)
    push(row)
    if (!expanded || words.length || input.resultType === 'tasks') return
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

  const listing = (listing: SessionListing) => {
    if (listing.kind === 'conversation') {
      push({
        kind: 'conversation',
        key: `session:${sessionIdentity(listing.meta)}`,
        entryIndex: entries.length,
        meta: listing.meta,
        hit: listing.hit,
        additionalMatches: listing.additionalMatches,
        hitServerId: listing.hitServerId,
      })
      return
    }
    const { task, session } = listing
    const row: PickerEntry = {
      kind: 'session',
      key: `session:${sessionIdentity(session)}`,
      entryIndex: entries.length,
      task,
      session,
      nested: false,
      isLast: false,
    }
    if (listing.hit) row.hit = listing.hit
    row.additionalMatches = listing.additionalMatches
    row.hitServerId = listing.hitServerId
    push(row)
  }

  return {
    rows,
    entries,
    header: (row: Extract<PickerRow, { kind: 'header' }>) => rows.push(row),
    end: (row: Extract<PickerRow, { kind: 'more' }>) => rows.push(row),
    task,
    listing,
  }
}

export function buildPickerRows(input: PickerRowsInput): PickerList {
  const words = queryWords(input.query)
  const matches = keepMatches(input, words)
  const { kept, hiddenTaskCount } = matches
  const writer = rowWriter(input)
  if (words.length || input.resultType === 'sessions') return queryList(input, words, matches, writer)
  if (input.resultType !== 'tasks') return recentList(input, matches, writer)

  for (const section of lifecycleSections(kept, input)) {
    writer.header({
      kind: 'header',
      key: `header:${section.key}`,
      label: section.label,
      count: section.items.length,
      hint: PICKER_SORT_HINTS.recency,
    })
    for (const item of section.items) {
      writer.task(item, input.expandedTaskIds.has(item.task.id), [])
    }
  }
  return {
    rows: writer.rows,
    entries: writer.entries,
    taskCount: kept.length,
    sessionCount: 0,
    hiddenTaskCount,
  }
}

/** The unqueried list: tasks and unclaimed sessions in one section, newest first. */
function recentList(
  input: PickerRowsInput,
  { kept, ownerBySessionId, hiddenTaskCount }: ReturnType<typeof keepMatches>,
  writer: ReturnType<typeof rowWriter>,
): PickerList {
  const sessions = unclaimedSessions(input.recentSessions ?? [], ownerBySessionId, input.filters ?? NO_PICKER_FILTERS, input.now ?? Date.now())
  const items = [
    ...kept.map((item) => ({ ts: item.task.updatedAt, item, listing: null })),
    ...sessions.map((listing) => ({ ts: listing.ts, item: null, listing })),
  ].sort((a, b) => b.ts - a.ts)
  if (items.length) {
    writer.header({
      kind: 'header',
      key: 'header:recent',
      label: 'Recent',
      count: items.length,
      hint: PICKER_SORT_HINTS.recency,
    })
  }
  for (const { item, listing } of items) {
    if (item) writer.task(item, input.expandedTaskIds.has(item.task.id), [])
    else writer.listing(listing!)
  }
  return {
    rows: writer.rows,
    entries: writer.entries,
    taskCount: kept.length,
    sessionCount: kept.reduce((sum, item) => sum + item.sessions.length, 0) + sessions.length,
    hiddenTaskCount,
  }
}

/** The list under a query — or every session, when only sessions are listed. */
function queryList(
  input: PickerRowsInput,
  words: readonly string[],
  { kept, nameHits, ownerBySessionId, hiddenTaskCount }: ReturnType<typeof keepMatches>,
  writer: ReturnType<typeof rowWriter>,
): PickerList {
  const sort = words.length ? input.sort ?? 'relevance' : 'recency'
  const now = input.now ?? Date.now()
  // Input order is newest first. Relevance ranks with a stable sort, so
  // recency stays the tiebreak; recency keeps the input order as it is.
  const scoredTasks: RankedTask[] = kept.map((item) => ({ ...item, relevance: taskRelevance(item, words, now) }))
  const rankedTasks = sort === 'relevance'
    ? scoredTasks.toSorted((a, b) => compareRelevance(a.relevance, b.relevance))
    : scoredTasks
  const listings = input.resultType === 'tasks' ? [] : matchedSessions(
    nameHits,
    words.length ? input.conversations ?? [] : [],
    ownerBySessionId,
    sort,
    words,
    now,
  )
  if (!words.length) {
    listings.push(...unclaimedSessions(input.recentSessions ?? [], ownerBySessionId, input.filters ?? NO_PICKER_FILTERS, input.now ?? Date.now()))
    listings.sort(compareListings(sort))
  }
  const remaining = remainingSessions(input, words)

  // Matching sessions have their own rows; expanding a task here would repeat them.
  const top = topHits(sort === 'relevance' ? rankedTasks : [], listings, (listing) => listing.kind === 'session' ? listing.task.id : null)
  if (top.order.length) {
    writer.header({
      kind: 'header',
      key: 'header:top',
      label: 'Top hits',
      count: top.order.length,
      hint: PICKER_SORT_HINTS.relevance,
    })
    for (const hit of top.order) {
      if ('matchedIn' in hit) writer.task(hit, false, words)
      else writer.listing(hit)
    }
  }

  const restTasks = rankedTasks.filter((item) => !top.tasks.has(item))
  if (restTasks.length) {
    writer.header({
      kind: 'header',
      key: 'header:tasks',
      label: 'Tasks',
      count: restTasks.length,
      hint: PICKER_SORT_HINTS[sort],
    })
    for (const item of restTasks) writer.task(item, false, words)
  }

  writeSessionsSection(writer, listings.filter((listing) => !top.sessions.has(listing)), remaining, sort)

  return {
    rows: writer.rows,
    entries: writer.entries,
    taskCount: rankedTasks.length,
    sessionCount: listings.length + remaining,
    hiddenTaskCount,
  }
}

/** Matching sessions the hosts hold beyond the pages read, when the list shows sessions under a query. */
function remainingSessions(input: PickerRowsInput, words: readonly string[]): number {
  if (input.resultType === 'tasks' || !words.length) return 0
  return input.conversationsRemaining ?? 0
}

/** The Sessions section: the listings not lifted into Top hits, and the end
 *  row that reads the matches the hosts hold beyond the pages read. */
function writeSessionsSection(writer: ReturnType<typeof rowWriter>, listings: readonly SessionListing[], remaining: number, sort: PickerSort): void {
  if (!listings.length && !remaining) return
  writer.header({
    kind: 'header',
    key: 'header:sessions',
    label: 'Sessions',
    // Every match the hosts hold, read or not: the count is not a cap.
    count: listings.length + remaining,
    hint: PICKER_SORT_HINTS[sort],
  })
  listings.forEach(writer.listing)
  if (remaining) writer.end({ kind: 'more', key: 'more:sessions', remaining })
}

interface LifecycleSection {
  key: string
  label: string
  items: KeptTask[]
}

/**
 * The sections of an unqueried list: what the sidebar has open, then every
 * other task by lifecycle, as the Tasks page names them.
 */
function lifecycleSections(kept: readonly KeptTask[], input: PickerRowsInput): LifecycleSection[] {
  const openTaskIds = input.openTaskIds ?? new Set<string>()
  const open = kept.filter(
    (item) => item.task.status === 'in_progress' && openTaskIds.has(item.task.id),
  )
  const liftedTaskIds = new Set(open.map((item) => item.task.id))
  const byTaskId = new Map(kept.map((item) => [item.task.id, item]))
  return [
    ...(open.length ? [{ key: 'sidebar-open', label: 'Open', items: open }] : []),
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
    return serverId && entry.hit
      ? { serverId, sessionId: entry.meta.sessionId, messageId: entry.hit.messageId }
      : null
  }
  const { sessionId } = entry.session
  const serverId = entry.hitServerId ?? entry.session.serverId
  return entry.hit && serverId && sessionId
    ? { serverId, sessionId, messageId: entry.hit.messageId }
    : null
}

/** The row the keyboard's cursor is on, or -1 when the list is empty. */
export function selectedRowIndex(rows: readonly PickerRow[], selectedIndex: number): number {
  return rows.findIndex((row) => 'entryIndex' in row && row.entryIndex === selectedIndex)
}

/**
 * Where `→` goes: a collapsed task opens, an open one steps into its first
 * session. Null when the key has nothing to do.
 */
export function expandTarget(
  entry: PickerEntry | undefined,
): { action: 'expand'; taskId: string } | { action: 'step' } | null {
  if (entry?.kind !== 'task' || !isTaskGroup(entry)) return null
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


export function pickerSessionTitle(row: Exclude<PickerEntry, { kind: 'task' }>): string {
  return row.kind === 'session' ? row.session.label : conversationTitle(row.meta)
}

/** The task a flat session row belongs to, for its byline. Null for a session
 *  no task claims, and for one named after its task: the name already says it. */
export function pickerSessionTaskTitle(row: Exclude<PickerEntry, { kind: 'task' }>): string | null {
  if (row.kind !== 'session') return null
  return flattenedLower(row.task.title) === flattenedLower(row.session.label) ? null : row.task.title
}

export function pickerSessionProject(row: Exclude<PickerEntry, { kind: 'task' }>): string {
  return row.kind === 'session' ? projectLabel(row.task) : conversationProjectLabel(row.meta)
}

export function pickerSessionActivity(row: Exclude<PickerEntry, { kind: 'task' }>): number {
  return row.kind === 'session'
    ? row.session.lastActivityAt || row.task.updatedAt
    : Date.parse(row.meta.lastTimestamp) || row.hit?.ts || 0
}
