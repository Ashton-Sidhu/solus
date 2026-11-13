import { isChat } from '@solus/contracts/chat'
import { CHAT_LABEL } from '../../../../lib/paths'
import { isRecordResultType, listsSessions, PICKER_RESULT_LABELS, type PickerRecordResultType, type PickerResultType } from './picker-result-types'
import type { Task } from '@solus/contracts/task-types'
import type { SessionMeta, SessionSearchResult } from '@solus/contracts/types'
import { plainSnippet } from '@solus/contracts/search-snippet'
import type { SidebarSessionChild } from '../../../../contexts/workspace/session-sidebar.store.svelte'
import type { PreviewHitTarget } from '../../../../lib/preview.svelte'
import { PR_LIST_ROW_HEIGHT } from '../../../prs/lib/prs-list-view'
import { taskPickerSections } from '../../../tasks/lib/task-picker-sections'
import { isDone } from '../../../tasks/lib/tasks-list-view'
import { taskRef } from '../../../tasks/lib/tasks-api'
import { SearchQuery } from '@solus/contracts/search-query'
import { flattenedLower, matchWindow, PICKER_SORT_HINTS, type PickerSort } from './picker-search'
import { activityScore, compareRelevance, nameScore, topHits, type Relevance, type TopHits } from './picker-relevance'
import { matchActions, rankRecords, recordKey, recordTimestamp, RECORD_SECTION_ORDER, type PickerAction, type PickerRecord, type RankedRecord } from './picker-records'
import { activeSince, keepsArchive, keepsHost, keepsSession, keepsTask, NO_PICKER_FILTERS, type PickerFilters } from './picker-filters'
import {
  compareListings,
  matchedSessions,
  sessionIdentity,
  unclaimedSessions,
  type MatchedSessions,
  type SessionListing,
  type TaskSession,
} from './picker-session-listings'
import { hostPathBaseName } from '@solus/contracts/host-path'

/** The empty query: lists that ignore what is typed. */
const NO_QUERY = new SearchQuery('')

export { sessionIdentity } from './picker-session-listings'

/** Where a task matched the query. Decides its rank and what its row shows. */
export type TaskMatchField = 'title' | 'body' | 'id' | 'comment'

/** Where a query's words were found in a session: the evidence its row shows
 *  and the passage its preview opens on. */
export interface ConversationHit {
  target?: import('@solus/contracts/session-search').SessionSearchTarget
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
 * A rendered row. Every row the keyboard can land on shares one `entryIndex`
 * sequence, so the arrow keys walk past headers and ⏎ always means "the thing
 * under the cursor" whatever kind it is.
 *
 * A conversation row is a session no task claims: found by what was said in
 * it, or listed among the newest while the box is empty. A session a task does
 * claim is a session row whether its name or its words matched; the hit, when
 * there is one, rides on the row. A record row is a work, a pull request, an
 * automation, a project or an action (`picker-records.ts`).
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
      /** Under a query, the words found in the session's messages. Absent when
       *  only its name matched. */
      hit?: ConversationHit
      additionalMatches?: ConversationHit[]
      hitServerId?: string
      reason?: import('@solus/contracts/session-search').SessionSearchReason
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
      reason?: import('@solus/contracts/session-search').SessionSearchReason
    }
  | {
      kind: 'record'
      key: string
      entryIndex: number
      record: PickerRecord
      /** Under a query, the passage that holds the words when the title does not. */
      passage?: string
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

/** A row that is one session: a task's, or one no task claims. */
export type PickerSessionEntry = Extract<PickerEntry, { kind: 'session' | 'conversation' }>

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
  // A chat's folder is named for its session id, which is no place to show.
  if (meta.place === 'chat') return CHAT_LABEL
  return hostPathBaseName(meta.projectRoot || meta.cwd || '') || '~'
}

/**
 * Where the query hit a task, best field first, or null for no hit. Every
 * word has to start a token of one field — the rule the hosts' index applies
 * to a message — so "auth flow" finds "Flow for auth" in either section and
 * a session and a task never disagree about what a query means. The id is
 * the reference a person reads (`owner/repo#123`, `PROJ-12`); a status or a
 * project path matched every task that shared it, which was noise, not a hit.
 */
export function taskMatchField(task: Task, search: SearchQuery, commentPassage?: string): TaskMatchField | null {
  if (search.isEmpty) return 'title'
  if (search.matchName(task.title)) return 'title'
  if (task.body && search.holdsEveryWord(task.body)) return 'body'
  if (task.reference && search.matchName(task.reference)) return 'id'
  // The hosts found the words across the task's comments (unified-search.md §7).
  return commentPassage ? 'comment' : null
}

export function sessionMatches(session: SidebarSessionChild, search: SearchQuery): boolean {
  return search.isEmpty || !!search.matchName(session.label)
}

export interface PickerRowsInput {
  tasks: Task[]
  query: string
  /** Which kinds of result the picker lists. */
  resultType?: PickerResultType
  /** How each section under a query is ordered. Relevance by default. */
  sort?: PickerSort
  sessionsFor: (task: Task) => SidebarSessionChild[]
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
  /** The works, pull requests, automations and projects in the scope. */
  records?: readonly PickerRecord[]
  /** The commands the list ends with when it lists every type. */
  actions?: readonly PickerAction[]
  /** What the reader narrowed the list to. None by default. */
  filters?: PickerFilters
  /** The clock recency is scored against. Now by default. */
  now?: number
}

/**
 * Build the list (docs/plans/unified-search.md, "Search types").
 *
 * With no query, every type opens on Recents: the newest sessions and works,
 * a short list of what the reader last worked on, then the actions. Tasks,
 * pull requests, automations and projects are not in Recents: other people
 * change them, so their dates do not say what the reader did. Each type's own
 * list holds all of its rows: every session, the tasks in their lifecycle
 * sections, and each kind of record newest first.
 *
 * A query replaces that with sections in a fixed order, each stating its
 * own rule: tasks the query hit; then sessions it hit by name, flat, one row
 * per session; then each kind of record; then In messages, the sessions only a
 * host found. The names are matched here on each keystroke, and the hosts
 * answer later, so a host's answer adds a passage to a row already listed but
 * never moves it: what it alone found is listed below. A matching session
 * remains visible even if its task matches. Every section takes the reader's
 * order: best match first, or newest.
 *
 * Best match first also lifts the best few rows found by name into Top hits,
 * above the sections. Without it the best session sat under every task
 * that matched at all, however weakly: the reader who typed a session's name
 * had to scroll past the task section to reach it. A row is listed once.
 */
export interface PickerList {
  rows: PickerRow[]
  /** The rows the keyboard can land on, in order. */
  entries: PickerEntry[]
  /** Tasks listed, for the footer. */
  taskCount: number
  /** Sessions listed, and those the hosts hold beyond the pages read, for
   *  the footer. */
  sessionCount: number
  /** Works, pull requests, automations and projects listed, for the footer. */
  recordCount: number
}

/** How many rows Recents holds: a glance, not a list to read through. */
export const RECENTS_SHOWN = 10

/**
 * Row heights, in CSS pixels, for the virtualiser.
 *
 * The list is virtualised, so a row's height has to be known before it is
 * painted; these are the same numbers the row markup sets, and a change to one
 * has to move with the other. An action has one line, a pull request has the
 * height of its row on the pull requests page, and every other row the
 * keyboard lands on has two lines.
 */
export function pickerRowHeight(row: PickerRow): number {
  if (row.kind === 'header' || row.kind === 'more') return 32
  if (row.kind !== 'record') return 44
  // A pull request is drawn by the row of the pull requests page, at its height.
  if (row.record.type === 'pullRequest') return PR_LIST_ROW_HEIGHT
  return row.record.type === 'action' ? 36 : 44
}

interface KeptTask {
  task: Task
  sessions: SidebarSessionChild[]
  matchedIn: TaskMatchField
}

/** Where a kept task matched, as a tier and a score (`picker-relevance.ts`). */
function taskRelevance(item: KeptTask, search: SearchQuery, now: number): Relevance {
  const { task } = item
  const activity = activityScore(task.updatedAt, now, isDone(task))
  if (item.matchedIn === 'title') return { tier: 'name', score: nameScore(task.title, search) + activity }
  // "PROJ-4" names PROJ-4 itself; that PROJ-40 also starts with it is incidental.
  if (item.matchedIn === 'id' && flattenedLower(taskRef(task)) === search.words.join(' ')) return { tier: 'id', score: activity }
  return { tier: 'evidence', score: activity }
}

/** The filters the reader chose, and the instant Updated keeps rows from. */
function narrowing(input: PickerRowsInput) {
  const filters = input.filters ?? NO_PICKER_FILTERS
  return { filters, since: activeSince(filters, input.now ?? Date.now()) }
}

/** Remember whose each session is, the first task first, so a host's hit can
 *  find its task without a second pass. */
function rememberOwners(owners: Map<string, TaskSession>, task: Task, sessions: readonly SidebarSessionChild[]): void {
  for (const session of sessions) {
    if (!session.sessionId) continue
    const key = sessionIdentity(session)
    if (!owners.has(key)) owners.set(key, { task, session })
  }
}

/** The tasks the query keeps, and the sessions a query's words name. A task
 *  belongs to no project, so the project scope keeps every task. With an empty
 *  box, the list of every type holds no task rows: it opens on Recents. */
function keepMatches(input: PickerRowsInput, type: PickerResultType, search: SearchQuery) {
  const kept: KeptTask[] = []
  const nameHits: TaskSession[] = []
  // Every task's sessions are read anyway; remember whose each is so a
  // conversation hit can find its task without a second pass.
  const ownerBySessionId = new Map<string, TaskSession>()
  const { filters, since } = narrowing(input)
  const listsTaskRows = type === 'tasks' || (type === 'all' && !search.isEmpty)
  for (const task of input.tasks) {
    const sessions = input.sessionsFor(task).filter((session) => session.sessionId || session.tabId)
    rememberOwners(ownerBySessionId, task, sessions)
    const matchedIn = !listsTaskRows || !keepsTask(task, filters, since)
      ? null
      : taskMatchField(task, search, input.commentPassages?.get(task.id))
    const matchingSessions = listsSessions(type)
      ? sessions.filter((session) => sessionMatches(session, search) && keepsSession(session, session.lastActivityAt, filters, since))
      : []
    if (!matchedIn && matchingSessions.length === 0) continue
    if (matchedIn) kept.push({ task, sessions, matchedIn })
    for (const session of matchingSessions) nameHits.push({ task, session })
  }
  return { kept, nameHits, ownerBySessionId }
}

/** A task this relevant. */
type RankedTask = KeptTask & { relevance: Relevance }

/** A row Top hits can lift: a task, a session, or a record. */
type TopRow = RankedTask | SessionListing | RankedRecord

/** The task a liftable row is, or belongs to. Null for a session no task claims and for a record. */
function taskIdOfTopRow(row: TopRow): string | null {
  if ('record' in row) return null
  if ('matchedIn' in row) return row.task.id
  return row.kind === 'session' ? row.task.id : null
}

/** A session whose task is already lifted, or whose task already has a session
 *  lifted: the task's row opens that session, and two rows with one name spend
 *  a place the reader needed. */
function repeatsLiftedTask(row: TopRow, lifted: readonly TopRow[]): boolean {
  if ('record' in row || 'matchedIn' in row) return false
  const taskId = taskIdOfTopRow(row)
  return taskId !== null && lifted.some((other) => taskIdOfTopRow(other) === taskId)
}

/** The list under construction: rows in order, and the ones the keyboard lands on. */
function rowWriter(input: PickerRowsInput) {
  const rows: PickerRow[] = []
  const entries: PickerEntry[] = []
  const push = (row: PickerEntry) => {
    rows.push(row)
    entries.push(row)
  }
  const header = (row: Extract<PickerRow, { kind: 'header' }>) => rows.push(row)

  const task = (item: KeptTask, search: SearchQuery) => {
    const { task } = item
    const row: PickerEntry = {
      kind: 'task',
      key: `task:${task.id}`,
      entryIndex: entries.length,
      task,
      sessions: item.sessions,
    }
    if (!search.isEmpty) row.matchedIn = item.matchedIn
    if (!search.isEmpty && item.matchedIn === 'body') row.bodySnippet = matchWindow(task.body ?? '', search)
    if (!search.isEmpty && item.matchedIn === 'comment') row.bodySnippet = matchWindow(plainSnippet(input.commentPassages?.get(task.id) ?? ''), search)
    push(row)
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
        reason: listing.reason,
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
    }
    if (listing.hit) row.hit = listing.hit
    row.additionalMatches = listing.additionalMatches
    row.hitServerId = listing.hitServerId
    row.reason = listing.reason
    push(row)
  }

  const record = (ranked: Pick<RankedRecord, 'record' | 'passage'>) => {
    const row: PickerEntry = { kind: 'record', key: recordKey(ranked.record), entryIndex: entries.length, record: ranked.record }
    if (ranked.passage) row.passage = ranked.passage
    push(row)
  }

  /** The commands the list ends with. They have no order to state. */
  const actions = (actions: readonly PickerAction[]) => {
    if (!actions.length) return
    header({ kind: 'header', key: 'header:actions', label: 'Actions', count: actions.length, hint: '' })
    for (const action of actions) record({ record: { type: 'action', action } })
  }

  return {
    rows,
    entries,
    header,
    end: (row: Extract<PickerRow, { kind: 'more' }>) => rows.push(row),
    task,
    listing,
    record,
    actions,
  }
}

export function buildPickerRows(input: PickerRowsInput): PickerList {
  const search = new SearchQuery(input.query)
  const type = input.resultType ?? 'all'
  const writer = rowWriter(input)
  if (isRecordResultType(type)) return recordList(input, type, search, writer)
  const matches = keepMatches(input, type, search)
  if (type === 'all' && search.isEmpty) return recentList(input, matches, writer)
  if (!search.isEmpty || type === 'sessions') return queryList(input, type, search, matches, writer)

  const { kept } = matches
  for (const section of lifecycleSections(kept)) {
    writer.header({
      kind: 'header',
      key: `header:${section.key}`,
      label: section.label,
      count: section.items.length,
      hint: PICKER_SORT_HINTS.recency,
    })
    for (const item of section.items) writer.task(item, NO_QUERY)
  }
  return {
    rows: writer.rows,
    entries: writer.entries,
    taskCount: kept.length,
    sessionCount: 0,
    recordCount: 0,
  }
}

/** Every session, a task's or not, as listings, newest first. */
function everySession(
  input: PickerRowsInput,
  { nameHits, ownerBySessionId }: ReturnType<typeof keepMatches>,
  now: number,
): SessionListing[] {
  const { named } = matchedSessions(nameHits, [], [], ownerBySessionId, 'recency', NO_QUERY, now)
  named.push(...unclaimedSessions(input.recentSessions ?? [], ownerBySessionId, narrowing(input).filters, now))
  return named.sort(compareListings('recency'))
}

/** The list of every type while the box is empty: Recents, then the actions. */
function recentList(
  input: PickerRowsInput,
  matches: ReturnType<typeof keepMatches>,
  writer: ReturnType<typeof rowWriter>,
): PickerList {
  const now = input.now ?? Date.now()
  const { since } = narrowing(input)
  const works = (input.records ?? []).filter((record) => record.type === 'work' && (since === undefined || recordTimestamp(record) >= since))
  const recents = [
    ...everySession(input, matches, now).map((listing) => ({ ts: listing.ts, listing, record: null })),
    ...works.map((record) => ({ ts: recordTimestamp(record), listing: null, record })),
  ].sort((a, b) => b.ts - a.ts).slice(0, RECENTS_SHOWN)
  if (recents.length) {
    writer.header({
      kind: 'header',
      key: 'header:recents',
      label: 'Recents',
      count: recents.length,
      hint: PICKER_SORT_HINTS.recency,
    })
  }
  for (const { listing, record } of recents) {
    if (listing) writer.listing(listing)
    else writer.record({ record })
  }
  writer.actions(input.actions ?? [])
  const sessionCount = recents.filter((recent) => recent.listing).length
  return {
    rows: writer.rows,
    entries: writer.entries,
    taskCount: 0,
    sessionCount,
    recordCount: recents.length - sessionCount,
  }
}

/** What a section of records is called. With an empty box the pull requests
 *  listed are the open ones; a query asks the code host for every state. */
function recordSectionLabel(type: PickerRecordResultType, search: SearchQuery): string {
  return type === 'pullRequests' && search.isEmpty ? 'Open pull requests' : PICKER_RESULT_LABELS[type]
}

/** One section of records. */
function writeRecordsSection(
  writer: ReturnType<typeof rowWriter>,
  type: PickerRecordResultType,
  ranked: readonly RankedRecord[],
  search: SearchQuery,
  sort: PickerSort,
): void {
  if (!ranked.length) return
  writer.header({
    kind: 'header',
    key: `header:${type}`,
    label: recordSectionLabel(type, search),
    count: ranked.length,
    // Projects have no date: with an empty box they keep the order of every project list.
    hint: type === 'projects' && search.isEmpty ? '' : PICKER_SORT_HINTS[sort],
  })
  ranked.forEach(writer.record)
}

/** The list of one kind of record: all of them newest first, or the ones a query keeps. */
function recordList(
  input: PickerRowsInput,
  type: PickerRecordResultType,
  search: SearchQuery,
  writer: ReturnType<typeof rowWriter>,
): PickerList {
  const sort = !search.isEmpty ? input.sort ?? 'relevance' : 'recency'
  const ranked = rankRecords(input.records ?? [], search, sort, input.now ?? Date.now(), narrowing(input).since).get(type) ?? []
  writeRecordsSection(writer, type, ranked, search, sort)
  return { rows: writer.rows, entries: writer.entries, taskCount: 0, sessionCount: 0, recordCount: ranked.length }
}

const NO_TOP_HITS: TopHits<TopRow> = { order: [], lifted: new Set() }

/** The sessions of a list under a query: the ones this client found by name,
 *  and the ones only a host found. With an empty box, every session. */
function queriedSessions(
  input: PickerRowsInput,
  type: PickerResultType,
  search: SearchQuery,
  matches: ReturnType<typeof keepMatches>,
  sort: PickerSort,
  now: number,
): MatchedSessions {
  if (search.isEmpty) return { named: everySession(input, matches, now), inMessages: [] }
  if (!listsSessions(type)) return { named: [], inMessages: [] }
  const { filters } = narrowing(input)
  return matchedSessions(
    matches.nameHits,
    unclaimedSessions(input.recentSessions ?? [], matches.ownerBySessionId, filters, now),
    // A host's record can open on another machine, so the Host filter is
    // checked against the machine each hit opens on.
    (input.conversations ?? []).filter((result) => keepsHost(result.session.serverId, filters) && keepsArchive(result.session.archived, filters)),
    matches.ownerBySessionId,
    sort,
    search,
    now,
  )
}

/** The rows lifted above the sections, each drawn as the kind it is. */
function writeTopHits(writer: ReturnType<typeof rowWriter>, top: TopHits<TopRow>, search: SearchQuery): void {
  if (!top.order.length) return
  writer.header({
    kind: 'header',
    key: 'header:top',
    label: 'Top hits',
    count: top.order.length,
    hint: PICKER_SORT_HINTS.relevance,
  })
  for (const hit of top.order) {
    if ('record' in hit) writer.record(hit)
    else if ('matchedIn' in hit) writer.task(hit, search)
    else writer.listing(hit)
  }
}

/** The list under a query — or every session, when only sessions are listed. */
function queryList(
  input: PickerRowsInput,
  type: PickerResultType,
  search: SearchQuery,
  matches: ReturnType<typeof keepMatches>,
  writer: ReturnType<typeof rowWriter>,
): PickerList {
  const { kept } = matches
  const sort = !search.isEmpty ? input.sort ?? 'relevance' : 'recency'
  const now = input.now ?? Date.now()
  const { since } = narrowing(input)
  // Input order is newest first. Relevance ranks with a stable sort, so
  // recency stays the tiebreak; recency keeps the input order as it is.
  const scoredTasks: RankedTask[] = kept.map((item) => ({ ...item, relevance: taskRelevance(item, search, now) }))
  const rankedTasks = sort === 'relevance'
    ? scoredTasks.toSorted((a, b) => compareRelevance(a.relevance, b.relevance))
    : scoredTasks
  const { named: listings, inMessages } = queriedSessions(input, type, search, matches, sort, now)
  const remaining = listsSessions(type) && !search.isEmpty ? input.conversationsRemaining ?? 0 : 0
  const recordsByType = type === 'all' ? rankRecords(input.records ?? [], search, sort, now, since) : new Map<PickerRecordResultType, RankedRecord[]>()
  const recordSections = RECORD_SECTION_ORDER.map((recordType) => ({ recordType, ranked: recordsByType.get(recordType) ?? [] }))

  // Only rows this client found by name are ranked into Top hits and the
  // sections under it: a host's answer comes later and must not move them.
  const top = sort === 'relevance'
    ? topHits<TopRow>([rankedTasks, listings, ...recordSections.map((section) => section.ranked)], repeatsLiftedTask)
    : NO_TOP_HITS
  writeTopHits(writer, top, search)

  const restTasks = rankedTasks.filter((item) => !top.lifted.has(item))
  if (restTasks.length) {
    writer.header({
      kind: 'header',
      key: 'header:tasks',
      label: 'Tasks',
      count: restTasks.length,
      hint: PICKER_SORT_HINTS[sort],
    })
    for (const item of restTasks) writer.task(item, search)
  }

  writeSessionsSection(writer, 'sessions', 'Sessions', listings.filter((listing) => !top.lifted.has(listing)), 0, sort)
  for (const { recordType, ranked } of recordSections) {
    writeRecordsSection(writer, recordType, ranked.filter((record) => !top.lifted.has(record)), search, sort)
  }
  // Before In messages: that section has no end until the hosts' last page.
  if (type === 'all') writer.actions(matchActions(input.actions ?? [], search))
  writeSessionsSection(writer, 'messages', 'In messages', inMessages, remaining, sort)

  return {
    rows: writer.rows,
    entries: writer.entries,
    taskCount: rankedTasks.length,
    sessionCount: listings.length + inMessages.length + remaining,
    recordCount: recordSections.reduce((sum, section) => sum + section.ranked.length, 0),
  }
}

/** A section of sessions, and the end row that reads the matches the hosts
 *  hold beyond the pages read. */
function writeSessionsSection(
  writer: ReturnType<typeof rowWriter>,
  key: string,
  label: string,
  listings: readonly SessionListing[],
  remaining: number,
  sort: PickerSort,
): void {
  if (!listings.length && !remaining) return
  writer.header({
    kind: 'header',
    key: `header:${key}`,
    label,
    // Every match the hosts hold, read or not: the count is not a cap.
    count: listings.length + remaining,
    hint: PICKER_SORT_HINTS[sort],
  })
  listings.forEach(writer.listing)
  if (remaining) writer.end({ kind: 'more', key: `more:${key}`, remaining })
}

interface LifecycleSection {
  key: string
  label: string
  items: KeptTask[]
}

/** The sections of an unqueried list: every task by lifecycle, as the Tasks
 *  page names them. */
function lifecycleSections(kept: readonly KeptTask[]): LifecycleSection[] {
  const byTaskId = new Map(kept.map((item) => [item.task.id, item]))
  return taskPickerSections(kept.map((item) => item.task)).map((section) => ({
    key: section.key,
    label: section.label,
    items: section.tasks.map((task) => byTaskId.get(task.id)!),
  }))
}

/**
 * The host and message a row's preview opens on. Null when the row has no
 * hit — its name or its task matched — or no host to ask; the preview then
 * shows the session's ends as it always has.
 */
export function previewHitTarget(entry: PickerEntry | null): PreviewHitTarget | null {
  if (!entry || entry.kind === 'task' || entry.kind === 'record') return null
  if (entry.kind === 'conversation') {
    const serverId = entry.meta.serverId
    return serverId && entry.hit
      ? { serverId, sessionId: entry.meta.sessionId, messageId: entry.hit.messageId, ...(entry.hit.target ? { target: entry.hit.target } : {}) }
      : null
  }
  const { sessionId } = entry.session
  const serverId = entry.hitServerId ?? entry.session.serverId
  return entry.hit && serverId && sessionId
    ? { serverId, sessionId, messageId: entry.hit.messageId, ...(entry.hit.target ? { target: entry.hit.target } : {}) }
    : null
}

/** The row the keyboard's cursor is on, or -1 when the list is empty. */
export function selectedRowIndex(rows: readonly PickerRow[], selectedIndex: number): number {
  return rows.findIndex((row) => 'entryIndex' in row && row.entryIndex === selectedIndex)
}

const COUNT_NOUNS = {
  sessions: ['session', 'sessions'],
  tasks: ['task', 'tasks'],
  works: ['work', 'works'],
  pullRequests: ['pull request', 'pull requests'],
  automations: ['automation', 'automations'],
  projects: ['project', 'projects'],
} satisfies Record<Exclude<PickerResultType, 'all'>, [string, string]>

/** The total under the list. Recents is a selection, not a count, so the list
 *  of every type says nothing until a query gives it results to count. */
export function pickerCountLabel(list: PickerList, type: PickerResultType, isQueried: boolean): string {
  const total = list.taskCount + list.sessionCount + list.recordCount
  if (type === 'all') return isQueried ? `${total} ${total === 1 ? 'result' : 'results'}` : ''
  const [one, many] = COUNT_NOUNS[type]
  return `${total} ${total === 1 ? one : many}`
}

export function pickerSessionTitle(row: PickerSessionEntry): string {
  return row.kind === 'session' ? row.session.label : conversationTitle(row.meta)
}

/** The task a session row belongs to, for its byline. Null for a session
 *  no task claims, and for one named after its task: the name already says it. */
export function pickerSessionTaskTitle(row: PickerSessionEntry): string | null {
  if (row.kind !== 'session') return null
  return flattenedLower(row.task.title) === flattenedLower(row.session.label) ? null : row.task.title
}

/** The folder the session ran in. A task has no folder of its own: its
 *  session names one. */
export function pickerSessionProject(row: PickerSessionEntry): string {
  if (row.kind !== 'session') return conversationProjectLabel(row.meta)
  const projectKey = row.session.projectKey
  if (isChat(projectKey)) return CHAT_LABEL
  return (projectKey && hostPathBaseName(projectKey)) || '~'
}

/** The host the session ran on. */
export function pickerSessionServerId(row: PickerSessionEntry): string | null | undefined {
  return row.kind === 'session' ? row.session.serverId : row.meta.serverId
}

export function pickerSessionActivity(row: PickerSessionEntry): number {
  return row.kind === 'session'
    ? row.session.lastActivityAt || row.task.updatedAt
    : Date.parse(row.meta.lastTimestamp) || row.hit?.ts || 0
}
