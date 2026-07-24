/** Raw combined `git diff` patch for the requested scope. */
export interface DiffResult {
  patch: string
}

export interface ReviewCheckpoint {
  prNumber: number
  /** PR head that was submitted to the provider for review. */
  headSha: string
  /** Exact merge-base used to render the reviewed PR diff. */
  base: string
  reviewedAt: string
}

export interface InterdiffHunk {
  id: string
  filePath: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  patch: string
}

export interface ReviewThreadHunkMatch {
  thread: import('./providers').ReviewThread
  hunk: InterdiffHunk | null
}

export interface PrInterdiffResult {
  checkpoint: ReviewCheckpoint | null
  state: 'none' | 'unchanged' | 'changed' | 'invalid'
  invalidReason?: 'base-changed' | 'old-head-unavailable'
  /** Unified patch rendered by the Diff tab. Invalid checkpoints return the full PR patch. */
  patch: string
  isFullDiff: boolean
  /** Convenience alias for the reviewed checkpoint head. */
  oldHead: string | null
  currentHead: string
  currentBase: string
  commentMatches: ReviewThreadHunkMatch[]
}

/** Per-file add/delete tally from `git diff --numstat`, for the changed-files
 *  list. Cheaper than shipping the whole patch just to count lines. */
export interface ChangedFileStat {
  path: string
  additions: number
  deletions: number
}

export type DiffScope =
  | { kind: 'session' }
  | { kind: 'turn'; index: number }
  | { kind: 'working-tree' }
  // PR review: merge-base(base, head)…live worktree. `baseSha` is the target
  // merge-base captured at checkout. An own-delta scope supplies the live
  // parent's head; main resolves its merge-base with the checked-out child.
  | { kind: 'pr'; baseSha: string; ownDeltaBaseSha?: string; parentPr?: number }

export type DiffRequest = {
  scope: DiffScope
  livePaths?: string[]
  /** Context lines per hunk (`git diff --unified`). Omit for the default 3. */
  contextLines?: number
}

/** A context so large every hunk swallows the whole file, so the parsed patch's
 *  addition/deletion line arrays are the complete new/old file contents. That is
 *  what lets the diff panel expand the unchanged gaps between hunks. */
export const FULL_CONTEXT_LINES = 1_000_000

export interface GitStateOptions {
  /** Include worktree line totals and any existing pull-request URL. These
   *  require a full worktree scan and potentially a network-backed CLI call. */
  includeDetails?: boolean
  /** Ignore network-backed detail caches for explicit manual/post-action refresh. */
  bypassCache?: boolean
}

export interface TurnSnapshot {
  index: number
  sha: string
  timestamp: number
  partial: boolean
  userMessagePreview: string
  filesChanged: number
  additions: number
  deletions: number
}

export interface WorktreePRResult {
  success: boolean
  url?: string
  error?: string
}

export interface GitCommitPushResult {
  success: boolean
  outcome: 'pushed' | 'committed-only' | 'unchanged' | 'failed'
  committed: boolean
  pushed: boolean
  error?: string
}

export interface GitSyncResult {
  success: boolean
  outcome: 'synced' | 'conflicted' | 'failed'
  error?: string
}

export interface UncommittedFile {
  path: string
  conflicted: boolean
}

/** Files and operation state currently reported by Git. This becomes empty
 * after a successful commit and is distinct from cumulative session changes. */
export interface UncommittedChanges {
  files: UncommittedFile[]
  hasMoreFiles: boolean
  insertions: number
  deletions: number
  mergeInProgress: boolean
}

/** Which repo and branch a working tree is on — all O(1) to obtain, unlike the
 * working-tree scan `GitState` adds on top. */
export interface GitIdentity {
  repoRoot: string
  headSha: string
  branch: string | null
  targetBranch: string
}

export interface GitState extends GitIdentity {
  uncommittedChanges: UncommittedChanges
  prUrl?: string
}
