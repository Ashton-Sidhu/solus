// Host-neutral code-host DTOs shared across main, preload, and renderer. These
// never leak Octokit/GraphQL response types — that is the whole point of the
// provider adapter. The main-side `Provider`/`ProviderAuth`/`ReviewProvider`
// interfaces (which carry Promise-returning methods) stay in
// `src/main/providers/types.ts` and re-export these.

import type { ReviewEffort } from './effort-types'

/** owner/repo + host, derived from the local `origin` remote. */
export interface RepoRef {
  owner: string
  repo: string
  /** e.g. `github.com` or a GHE hostname. Selects the provider. */
  host: string
}

export interface PrFilter {
  state?: 'open' | 'closed' | 'all'
  author?: string
}

export interface PrListPage {
  items: PullRequestSummary[]
  page: number
  hasMore: boolean
}

export interface PrEffortRequest {
  number: number
  headSha: string
}

export interface PrEffortResult extends PrEffortRequest {
  effort?: ReviewEffort
  /** Diff totals loaded alongside effort because PR list responses omit them. */
  additions?: number
  deletions?: number
}

export interface PullRequestSummary {
  number: number
  title: string
  /** Current host head, used to key derived list metadata without another request. */
  headSha: string
  /** Base repository remote identity for opening the PR on its host. */
  baseRepo?: RepoRef
  author: string
  authorAvatarUrl: string
  state: 'open' | 'closed' | 'merged'
  createdAt: string
  updatedAt: string
  draft: boolean
  labels: { name: string; color: string }[]
  additions: number
  deletions: number
  /** Pacing guidance only; review always opens the complete diff. */
  effort?: ReviewEffort
  /** Host logins currently requested to review this PR. */
  requestedReviewers?: string[]
  /** Host logins currently assigned to this PR. */
  assignees?: string[]
  /** Why this PR belongs in the connected viewer's review queue. */
  reviewAttention?: 'requested' | 'assigned'
  needsMyReview?: boolean
  /** List responses already carry these fields; stack detection reuses them without detail calls. */
  body?: string
  baseRef?: string
  headRef?: string
  isCrossRepository?: boolean
}

export interface PullRequestDetail extends PullRequestSummary {
  body: string
  baseRef: string
  headRef: string
  baseSha: string
  headSha: string
  changedFiles: number
  /** Host-computed mergeability; null while the host is still computing it. */
  mergeable: boolean | null
  /** Host-specific merge state, e.g. GitHub REST's `dirty` for merge conflicts. */
  mergeStateStatus: string | null
  /** Where the head branch lives; `isFork` true when it differs from the base repo. */
  headRepo: { owner: string; repo: string; isFork: boolean }
}

export interface PullRequestOverview {
  detail: PullRequestDetail
  commits: PrCommit[]
  reviewers: PrReviewer[]
}

export interface ReviewComment {
  id: string
  author: string
  body: string
  createdAt: string
  /**
   * Unified-diff snippet GitHub anchors this comment to (a few lines ending at
   * the commented line). Only the thread's first comment carries one; replies
   * leave it undefined.
   */
  diffHunk?: string
}

/** One commit on a PR, for the Activity timeline. */
export interface PrCommit {
  /** Full commit SHA; render the first 7 chars. */
  sha: string
  /** First line of the commit message. */
  message: string
  /** Author's GitHub login, falling back to the git author name. */
  author: string
  committedAt: string
}

export interface ReviewThread {
  /** GraphQL thread node id (needed to reply/resolve). */
  id: string
  filePath: string
  /** null = outdated (the anchor no longer exists in the current diff). */
  line: number | null
  side: 'LEFT' | 'RIGHT'
  isResolved: boolean
  isOutdated: boolean
  comments: ReviewComment[]
}

/** A reviewer requested on (or who has reviewed) a PR. */
export interface PrReviewer {
  login: string
  /** Current review state; null when the user was requested but hasn't reviewed yet. */
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING' | null
}

export interface DraftReviewComment {
  path: string
  /** Last line of the range — anchors the comment. */
  line: number
  /** Set for a multi-line range; the first line of the range. */
  startLine?: number
  side: 'LEFT' | 'RIGHT'
  body: string
}

export interface DraftReview {
  body: string
  event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'
  /** Head SHA the comments are anchored to (the head we rendered to the user). */
  commitId: string
  /** Exact merge-base used by the rendered diff, persisted after a successful review. */
  baseSha?: string
  comments: DraftReviewComment[]
}

/** A top-level PR conversation entry, distinct from an inline review thread. */
export interface PrConversationItem {
  id: string
  kind: 'comment' | 'review'
  author: string
  body: string
  createdAt: string
  /** Present only for review bodies; uses the host's canonical review state. */
  reviewState?: Exclude<PrReviewer['state'], null>
  url?: string
}
