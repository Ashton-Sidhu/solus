import type { ListProjectOption } from '../../ui/list-page/list-page'
import type { DraftRow } from './draft-list'
import { draftItem, sectionItems, taskItem, type SidebarListItem } from './sidebar-list-items'
import type { SidebarTask } from './task-list'

/**
 * The sidebar's project view (docs/plans/sidebar-project-view.md): the
 * person's open sessions and drafts in one folder per project. A draft leads
 * its folder, because it is the prompt the person is about to send there. The
 * Shared with you, Snoozed, and Completed sections stay below, as in the
 * status view. There is no Working section: a busy session stays in its
 * project's folder, and its row shows that it works.
 */
export interface SidebarFolder {
  /** The project's group key (`SidebarTask.groupKey`). */
  key: string
  /** The project's row, when the workspace knows it: the path of one checkout
   *  and its host. Null for a project the workspace cannot name. */
  project: ListProjectOption | null
  label: string
  /** The folder's sessions and drafts together. */
  count: number
  isOpen: boolean
  /** The folder is closed and hides a session that needs the person. */
  hasHiddenAttention: boolean
}

/** A row that wants the person: unread output, a question, a plan, or an error. */
export function needsAttention(row: Pick<SidebarTask, 'unread' | 'status'>): boolean {
  return row.unread || row.status === 'question' || row.status === 'plan' || row.status === 'error'
}

/**
 * A folder's sessions, the one the person last sent a prompt to first. A
 * session they have not sent to here goes by when it started. A reply, a wake,
 * or an automation's prompt does not move a row, so the list does not move
 * under the pointer while agents work.
 */
export function sortBySent(rows: readonly SidebarTask[], sentAt: (row: SidebarTask) => number): SidebarTask[] {
  const at = new Map(rows.map((row) => [row, Math.max(row.createdAt, sentAt(row))]))
  return rows.toSorted((a, b) => at.get(b)! - at.get(a)! || a.id.localeCompare(b.id))
}

export interface ProjectFolderInput {
  /** The person's own open sessions, working or not, already scoped by the
   *  project filter and the search. */
  sessions: readonly SidebarTask[]
  /** Unsent prompts, scoped by the project filter (`draftRows`). */
  drafts: readonly DraftRow[]
  /** Every project in the column's order (`SessionSidebarStore.projectFilterChoices`). */
  projects: readonly ListProjectOption[]
  isFolderOpen: (folderKey: string) => boolean
  sentAt: (row: SidebarTask) => number
  /** The row a closed folder still shows: the one holding the conversation on screen. */
  shelfRevealTaskId: string | null
}

export interface ProjectFolderRows {
  folder: SidebarFolder
  /** The folder's drafts, in the order they were opened. A closed folder shows none. */
  drafts: DraftRow[]
  rows: SidebarTask[]
}

/** One folder per project that has an open session or a draft, in project
 *  order. One pass over the rows; a project the workspace cannot name comes
 *  last, under the name its rows carry. */
export function buildProjectFolders(input: ProjectFolderInput): ProjectFolderRows[] {
  const rowsByKey = new Map<string, SidebarTask[]>()
  for (const row of input.sessions) {
    const rows = rowsByKey.get(row.groupKey)
    if (rows) rows.push(row)
    else rowsByKey.set(row.groupKey, [row])
  }
  const draftsByKey = new Map<string, DraftRow[]>()
  for (const draft of input.drafts) {
    const drafts = draftsByKey.get(draft.groupKey)
    if (drafts) drafts.push(draft)
    else draftsByKey.set(draft.groupKey, [draft])
  }
  const projectByKey = new Map(input.projects.map((project) => [project.key, project]))
  const usedKeys = new Set([...rowsByKey.keys(), ...draftsByKey.keys()])
  const orderedKeys = [
    ...input.projects.map((project) => project.key).filter((key) => usedKeys.has(key)),
    ...[...usedKeys].filter((key) => !projectByKey.has(key)),
  ]
  return orderedKeys.map((key) => {
    const rows = sortBySent(rowsByKey.get(key) ?? [], input.sentAt)
    const drafts = draftsByKey.get(key) ?? []
    const isOpen = input.isFolderOpen(key)
    const shown = isOpen ? rows : rows.filter((row) => row.id === input.shelfRevealTaskId)
    const project = projectByKey.get(key) ?? null
    return {
      folder: {
        key,
        project,
        label: project?.label ?? rows[0]?.projectLabel ?? drafts[0].projectLabel,
        count: rows.length + drafts.length,
        isOpen,
        hasHiddenAttention: !isOpen && rows.some((row) => row.id !== input.shelfRevealTaskId && needsAttention(row)),
      },
      drafts: isOpen ? drafts : [],
      rows: shown,
    }
  })
}

export interface ProjectListInput extends ProjectFolderInput {
  shared: readonly SidebarTask[]
  snoozed: readonly SidebarTask[]
  completed: readonly SidebarTask[]
  isSharedOpen: boolean
  isSnoozedOpen: boolean
  isCompletedOpen: boolean
}

/** The project view as one list, so a row that changes place animates as the
 *  status view's rows do (docs/plans/sidebar-motion.md). */
export function buildProjectListItems(input: ProjectListInput): SidebarListItem[] {
  const items: SidebarListItem[] = []
  for (const { folder, drafts, rows } of buildProjectFolders(input)) {
    items.push({ kind: 'folder', key: `folder:${folder.key}`, folder })
    for (const draft of drafts) items.push({ ...draftItem(draft), folderKey: folder.key })
    for (const row of rows) items.push({ ...taskItem(row, 'sessions'), folderKey: folder.key })
  }
  items.push(
    ...sectionItems('shared', input.shared, input.isSharedOpen, input.shelfRevealTaskId),
    ...sectionItems('snoozed', input.snoozed, input.isSnoozedOpen, input.shelfRevealTaskId),
    ...sectionItems('completed', input.completed, input.isCompletedOpen, input.shelfRevealTaskId),
  )
  return items
}
