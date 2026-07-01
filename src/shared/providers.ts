// Host-neutral code-host DTOs shared across main, preload, and renderer. These
// never leak Octokit/GraphQL response types — that is the whole point of the
// provider adapter. The main-side `Provider`/`ProviderAuth`/`ReviewProvider`
// interfaces (which carry Promise-returning methods) stay in
// `src/main/providers/types.ts` and re-export these.

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

export interface PullRequestSummary {
  number: number
  title: string
  author: string
  authorAvatarUrl: string
  state: 'open' | 'closed' | 'merged'
  createdAt: string
  updatedAt: string
  draft: boolean
  labels: { name: string; color: string }[]
  additions: number
  deletions: number
}

export interface PullRequestDetail extends PullRequestSummary {
  body: string
  baseRef: string
  headRef: string
  baseSha: string
  headSha: string
  changedFiles: number
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
  comments: DraftReviewComment[]
}
