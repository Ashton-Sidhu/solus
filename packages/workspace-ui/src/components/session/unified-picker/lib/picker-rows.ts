import type { Task } from '@solus/contracts/task-types'
import type { SessionMeta, SessionSearchResult } from '@solus/contracts/types'
import type { SidebarSessionChild } from '../../../../contexts/workspace/session-sidebar.store.svelte'
import { taskPickerSections } from '../../../tasks/lib/task-picker-sections'
import type { ProjectFilterChoice } from '../../lib/task-list'

/** Where a task matched the query. Decides its rank and what its row shows. */
export type TaskMatchField = 'title' | 'body' | 'other'

/**
 * A rendered row. Tasks and their expanded sessions share one `entryIndex`
 * sequence, so the arrow keys walk past headers and ⏎ always means "the thing
 * under the cursor" whether that is a task or one of its sessions.
 *
 * A conversation row is a session found by what was said in it rather than by
 * its name. It may belong to a task; it is still listed on its own, because
 * the reader searched for the words, not the task.
 */
export type PickerRow =
  | {
      kind: 'header'
      key: string
      label: string
      count: number
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
    }
  | {
      kind: 'conversation'
      key: string
      entryIndex: number
      meta: SessionMeta
      /** The passage that matched, with the index's own ellipses. */
      snippet: string
      /** When the matching message was said; the row's date and the sort key. */
      ts: number
      /** The task this session is linked to, when one is; the row's byline. */
      task: Task | null
    }

/** A row the keyboard can land on: everything except a section header. */
export type PickerEntry = Exclude<PickerRow, { kind: 'header' }>

const NEWEST_FIRST = 'newest first'

/** The last path segment of the task's project, or "Inbox" when it has none. */
export function projectLabel(task: Task): string {
  if (!task.projectKey) return 'Inbox'
  return task.projectKey.replace(/\/$/, '').split('/').at(-1) || task.projectKey
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
 * Where the query hit a task, best field first, or null for no hit. The
 * fields are the ones the old task picker matched, kept so no result
 * disappears; the order is what a reader would rank them in.
 */
export function taskMatchField(task: Task, needle: string): TaskMatchField | null {
  if (!needle) return 'title'
  if (task.title.toLocaleLowerCase().includes(needle)) return 'title'
  if (task.body?.toLocaleLowerCase().includes(needle)) return 'body'
  const other = [task.shortId, task.id, task.projectKey, task.status]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase()
  return other.includes(needle) ? 'other' : null
}

export function sessionMatches(session: SidebarSessionChild, needle: string): boolean {
  return !needle || session.label.toLocaleLowerCase().includes(needle)
}

/** The passage of `text` around the first hit of `needle`, whitespace
 *  collapsed, with ellipses where it was cut. The row's second line. */
export function matchWindow(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const at = flat.toLocaleLowerCase().indexOf(needle)
  if (at < 0) return flat.slice(0, 100)
  const start = Math.max(0, at - 32)
  const end = Math.min(flat.length, at + needle.length + 72)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

export interface PickerRowsInput {
  tasks: Task[]
  query: string
  /** Scope the list to one project, or null to list every project. Every task
   *  has a project, so a scope is a plain equality test with no exception. */
  projectKey?: string | null
  sessionsFor: (task: Task) => SidebarSessionChild[]
  expandedTaskIds: ReadonlySet<string>
  /** Durable tasks currently visible in the session sidebar. */
  openTaskIds?: ReadonlySet<string>
  /** Durable tasks currently on the session sidebar's snoozed shelf. */
  snoozedTaskIds?: ReadonlySet<string>
  /** Sessions whose messages match the query, from every host searched. Only
   *  read under a query; an empty query has nothing to have matched. */
  conversations?: readonly SessionSearchResult[]
}

/**
 * Build the list.
 *
 * With no query the tasks sit in their lifecycle sections, newest first, and
 * a task shows its sessions only when the reader opened it.
 *
 * A query replaces that with three sections in a fixed order, each stating
 * its own rule: tasks the query hit, best field first; sessions whose name it
 * hit, newest first, flat, each naming its task; then conversations whose
 * words it hit, newest first. One row, one reason, one order.
 */
export interface PickerList {
  rows: PickerRow[]
  /** The rows the keyboard can land on, in order. */
  entries: PickerEntry[]
  /** Tasks listed, for the footer. */
  taskCount: number
  /** Sessions listed or folded under listed tasks, for the footer. */
  sessionCount: number
  /** Conversation hits listed, after those already shown as sessions. */
  conversationCount: number
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

/** The tasks the query and scope keep, and the sessions a query's words name. */
function keepMatches(input: PickerRowsInput, needle: string) {
  const scope = input.projectKey ?? null
  const kept: KeptTask[] = []
  const sessionHits: { task: Task; session: SidebarSessionChild }[] = []
  // Every task's sessions are read anyway; remember whose each is so a
  // conversation hit can name its task without a second pass.
  const taskBySessionId = new Map<string, Task>()
  let hiddenTaskCount = 0
  for (const task of input.tasks) {
    const sessions = input.sessionsFor(task)
    for (const session of sessions) {
      if (session.sessionId && !taskBySessionId.has(session.sessionId)) {
        taskBySessionId.set(session.sessionId, task)
      }
    }
    const matchedIn = taskMatchField(task, needle)
    const matchingSessions = needle
      ? sessions.filter((session) => sessionMatches(session, needle))
      : []
    if (!matchedIn && matchingSessions.length === 0) continue
    if (scope && task.projectKey !== scope) {
      hiddenTaskCount += 1
      continue
    }
    if (matchedIn) kept.push({ task, sessions, matchedIn })
    for (const session of matchingSessions) sessionHits.push({ task, session })
  }
  return { kept, sessionHits, taskBySessionId, hiddenTaskCount }
}

const MATCH_RANK = { title: 0, body: 1, other: 2 } satisfies Record<TaskMatchField, number>

export function buildPickerRows(input: PickerRowsInput): PickerList {
  const needle = input.query.trim().toLocaleLowerCase()
  const { kept, sessionHits, taskBySessionId, hiddenTaskCount } = keepMatches(input, needle)

  const rows: PickerRow[] = []
  const entries: PickerEntry[] = []
  const push = (row: PickerEntry) => {
    rows.push(row)
    entries.push(row)
  }

  const pushTask = (item: KeptTask, expanded: boolean, needle: string) => {
    const { task } = item
    const row: PickerEntry = {
      kind: 'task',
      key: `task:${task.id}`,
      entryIndex: entries.length,
      task,
      sessions: item.sessions,
      expanded,
    }
    if (needle) row.matchedIn = item.matchedIn
    if (needle && item.matchedIn === 'body') row.bodySnippet = matchWindow(task.body ?? '', needle)
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

  if (!needle) {
    for (const section of lifecycleSections(kept, input)) {
      rows.push({
        kind: 'header',
        key: `header:${section.key}`,
        label: section.label,
        count: section.items.length,
        hint: NEWEST_FIRST,
        accent: section.accent ?? false,
      })
      for (const item of section.items) {
        pushTask(item, input.expandedTaskIds.has(item.task.id), '')
      }
    }
    return {
      rows,
      entries,
      taskCount: kept.length,
      sessionCount: kept.reduce((sum, item) => sum + item.sessions.length, 0),
      conversationCount: 0,
      hiddenTaskCount,
    }
  }

  // Input order is newest first; a stable sort by field keeps it as the tiebreak.
  const rankedTasks = kept.toSorted(
    (a, b) => MATCH_RANK[a.matchedIn] - MATCH_RANK[b.matchedIn],
  )
  if (rankedTasks.length) {
    rows.push({
      kind: 'header',
      key: 'header:tasks',
      label: 'Tasks',
      count: rankedTasks.length,
      hint: 'best match first',
    })
    // Folded unless the reader opened it: the row is the evidence, and opening
    // every hit pushed the other sections below the fold.
    for (const item of rankedTasks) pushTask(item, input.expandedTaskIds.has(item.task.id), needle)
  }

  const rankedSessions = sessionHits.toSorted(
    (a, b) => b.session.lastActivityAt - a.session.lastActivityAt,
  )
  if (rankedSessions.length) {
    rows.push({
      kind: 'header',
      key: 'header:sessions',
      label: 'Sessions',
      count: rankedSessions.length,
      hint: NEWEST_FIRST,
    })
    rankedSessions.forEach(({ task, session }, index) => {
      push({
        kind: 'session',
        key: `session-hit:${task.id}:${session.sessionId ?? session.tabId ?? index}`,
        entryIndex: entries.length,
        task,
        session,
        nested: false,
        isLast: false,
      })
    })
  }

  const conversations = unlistedConversations(input.conversations ?? [], entries)
  if (conversations.length) {
    rows.push({
      kind: 'header',
      key: 'header:conversations',
      label: 'In conversations',
      count: conversations.length,
      hint: NEWEST_FIRST,
    })
    for (const result of conversations) {
      push({
        kind: 'conversation',
        key: `conversation:${result.session.serverId ?? ''}:${result.session.sessionId}`,
        entryIndex: entries.length,
        meta: result.session,
        snippet: result.snippet,
        ts: result.ts,
        task: taskBySessionId.get(result.session.sessionId) ?? null,
      })
    }
  }

  return {
    rows,
    entries,
    taskCount: rankedTasks.length,
    sessionCount: rankedSessions.length,
    conversationCount: conversations.length,
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
 * The hits worth their own row. A session already on screen is not listed a
 * second time; the reader can see it. One behind a folded task is not on
 * screen, so it is. Everything else the words found is kept, including
 * sessions no task ever claimed.
 */
function unlistedConversations(
  conversations: readonly SessionSearchResult[],
  listed: readonly PickerEntry[],
): SessionSearchResult[] {
  if (!conversations.length) return []
  const listedSessionIds = new Set(
    listed.flatMap((entry) => (entry.kind === 'session' ? entry.session.sessionId ?? [] : [])),
  )
  return conversations.filter((result) => !listedSessionIds.has(result.session.sessionId))
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
