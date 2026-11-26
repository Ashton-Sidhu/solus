import { managedWorktreeState, type ManagedWorktree, type ManagedWorktreeGroup, type ManagedWorktreeState } from '@solus/contracts/git-types'
import { formatResourceBytes } from '@solus/client-core/host-resource-watch'
import { relativeTime } from '../../../lib/relative-time'

/** A status filter: every worktree, or one state. */
export type WorktreeStatusFilter = 'all' | ManagedWorktreeState

export const WORKTREE_STATUS_FILTERS: ReadonlyArray<{ value: WorktreeStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'safe', label: 'Safe to delete' },
  { value: 'unsaved', label: 'Unsaved work' },
  { value: 'in_use', label: 'In use' },
]

/** In a group: what can go first, then what loses work, then what a session uses. */
const STATE_ORDER = { safe: 0, unsaved: 1, in_use: 2 } satisfies Record<ManagedWorktreeState, number>

export interface WorktreeGroupView {
  group: ManagedWorktreeGroup
  /** Every worktree of the group, for its count and size. */
  all: ManagedWorktree[]
  /** The worktrees that the status filter shows. */
  shown: ManagedWorktree[]
}

const matchesStatus = (worktree: ManagedWorktree, status: WorktreeStatusFilter) =>
  status === 'all' || managedWorktreeState(worktree) === status

/**
 * The groups that the filters show, in the order of their newest worktree.
 * With a status filter, a group with no match is left out.
 */
export function worktreeGroups(worktrees: readonly ManagedWorktree[], groupKey: string, status: WorktreeStatusFilter): WorktreeGroupView[] {
  const groups = new Map<string, WorktreeGroupView>()
  for (const worktree of worktrees) {
    if (groupKey !== 'all' && worktree.group.key !== groupKey) continue
    let view = groups.get(worktree.group.key)
    if (!view) groups.set(worktree.group.key, view = { group: worktree.group, all: [], shown: [] })
    view.all.push(worktree)
    if (matchesStatus(worktree, status)) view.shown.push(worktree)
  }
  for (const view of groups.values()) {
    view.shown.sort((a, b) => STATE_ORDER[managedWorktreeState(a)] - STATE_ORDER[managedWorktreeState(b)])
  }
  return [...groups.values()].filter((view) => status === 'all' || view.shown.length > 0)
}

/** The choices of the project filter, with their counts. */
export function worktreeGroupOptions(worktrees: readonly ManagedWorktree[]): Array<ManagedWorktreeGroup & { count: number }> {
  const options = new Map<string, ManagedWorktreeGroup & { count: number }>()
  for (const worktree of worktrees) {
    const option = options.get(worktree.group.key)
    if (option) option.count++
    else options.set(worktree.group.key, { ...worktree.group, count: 1 })
  }
  return [...options.values()]
}

/** How many worktrees of the project filter each status filter shows. */
export function statusCount(worktrees: readonly ManagedWorktree[], groupKey: string, status: WorktreeStatusFilter): number {
  return worktrees.filter((worktree) => (groupKey === 'all' || worktree.group.key === groupKey) && matchesStatus(worktree, status)).length
}

/** One choice of a group in the Filters menu (`ListFilterGroup`). */
export interface WorktreeFilterOption<T extends string> {
  value: T
  label: string
  count: number
}

/** The Project group of the Filters menu: all projects, then each project or codebase. */
export function projectFilterOptions(worktrees: readonly ManagedWorktree[]): WorktreeFilterOption<string>[] {
  return [
    { value: 'all', label: 'All projects', count: worktrees.length },
    ...worktreeGroupOptions(worktrees).map((option) => ({ value: option.key, label: option.name, count: option.count })),
  ]
}

/** The Status group of the Filters menu, counted in the chosen project. */
export function statusFilterOptions(worktrees: readonly ManagedWorktree[], groupKey: string): WorktreeFilterOption<WorktreeStatusFilter>[] {
  return WORKTREE_STATUS_FILTERS.map((filter) => ({ ...filter, count: statusCount(worktrees, groupKey, filter.value) }))
}

/** What the row says about the worktree: the state in words, then when it changed last. */
export function worktreeStatusText(worktree: ManagedWorktree): string {
  switch (managedWorktreeState(worktree)) {
    case 'in_use': return 'A turn is running'
    case 'unsaved': return worktree.hasUncommittedWork ? 'Has uncommitted work' : 'Has unmerged commits'
    case 'safe': return 'No unsaved work'
  }
}

/** The idle sessions bound to it: Delete takes their working folder. */
export function idleSessions(worktree: ManagedWorktree): ManagedWorktree['sessions'] {
  return worktree.sessions.filter((session) => !session.isBusy)
}

export function lastUsedText(worktree: ManagedWorktree, now = Date.now()): string {
  return worktree.lastModified ? `last used ${relativeTime(worktree.lastModified, now)}` : ''
}

/** The sizes of `worktrees` that are known, added. Null until one is known. */
export function totalSize(worktrees: readonly ManagedWorktree[], sizes: ReadonlyMap<string, number | null>): number | null {
  let total: number | null = null
  for (const worktree of worktrees) {
    const bytes = sizes.get(worktree.path)
    if (bytes !== undefined && bytes !== null) total = (total ?? 0) + bytes
  }
  return total
}

/** What the confirmation says: what is lost, what is deleted, and the space it frees. */
export function deleteConfirmText(worktree: ManagedWorktree, bytes: number | null | undefined): string {
  const lost = [
    worktree.hasUncommittedWork ? 'its uncommitted work' : null,
    worktree.hasUnmergedCommits ? 'the commits that are only on its branch' : null,
  ].filter(Boolean)
  const sentences = [
    lost.length ? `You lose ${lost.join(' and ')}.` : 'No work is lost.',
    ...idleSessions(worktree).map((session) => `“${session.title}” is open. It loses its working folder; its conversation stays.`),
    worktree.branch
      ? `The branch ${worktree.branch} is deleted${worktree.kind === 'task_folder' ? ' in each repository' : ''}.`
      : null,
    bytes !== undefined && bytes !== null ? `Frees ${formatResourceBytes(bytes)}.` : null,
  ]
  return sentences.filter(Boolean).join(' ')
}

export function keptBranchNotice(worktree: ManagedWorktree, error: string): string {
  return `Deleted ${worktree.title}. The branch ${worktree.branch ?? ''} stays: ${error}`
}
