// Merge queue: sequentially merge a set of open PRs, pausing on conflicts so
// an agent (or the user) can resolve them in the PR's worktree, then resuming.
// One queue runs at a time, owned by the main process; the renderer mirrors
// state via the `merge-queue-update` broadcast topic.

export type MergeMethod = 'merge' | 'squash' | 'rebase'

/** 'manual' preserves the order PRs were queued in; 'auto' reorders so the
 *  least-entangled PRs (fewest changed-file overlaps with the rest) go first. */
export type MergeOrderMode = 'auto' | 'manual'

export type MergeQueueEntryStatus =
  | 'pending'
  | 'merging'
  /** Local merge of the base branch hit conflicts; the queue is paused on this
   *  entry until the worktree's merge concludes (or the entry is skipped). */
  | 'conflicts'
  | 'merged'
  | 'skipped'
  | 'failed'

export interface MergeQueueEntry {
  number: number
  title: string
  status: MergeQueueEntryStatus
  /** Why the entry ended up skipped/failed (fork PR, API rejection, …). */
  detail?: string
  /** Conflicted paths while status is 'conflicts'. */
  conflictFiles?: string[]
  /** PR worktree checkout — set once conflict resolution needs a workspace. */
  worktreePath?: string
  /** Local review branch in that worktree (`solus/pr-N`). */
  branch?: string
  /** The PR's base branch, for the resolution session's git context. */
  baseRef?: string
}

export type MergeQueueRunStatus =
  | 'running'
  /** Paused on a 'conflicts' entry, waiting for the merge to be concluded. */
  | 'waiting'
  | 'done'
  | 'cancelled'

export interface MergeQueueState {
  /** Repo root the queue runs against. */
  repoRoot: string
  status: MergeQueueRunStatus
  method: MergeMethod
  entries: MergeQueueEntry[]
  /** Index of the entry currently being processed; -1 once the queue ends. */
  currentIndex: number
}

export interface MergeQueueStartItem {
  number: number
  title: string
}

export interface MergeQueueStartOptions {
  order: MergeOrderMode
  method?: MergeMethod
}

export interface MergeQueueStartResult {
  success: boolean
  error?: string
}
