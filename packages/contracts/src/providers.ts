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

export interface GitHubPullRequestUrl {
  number: number
  baseRepo: RepoRef
  url: string
}

/** Parse the canonical public GitHub PR form used in pasted links. Keep this
 * shared so transcript navigation, task links, and agent tools agree on what a
 * valid external PR is. */
export function parseGitHubPullRequestUrl(value: string): GitHubPullRequestUrl | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/i)
  if (!match) return null
  const number = Number(match[3])
  if (!Number.isSafeInteger(number) || number <= 0) return null
  // The canonical form of the link that was pasted, not one rebuilt from its
  // parts: a query string or a trailing slash is noise, but the rest is the
  // caller's own URL and stays theirs.
  url.search = ''
  url.hash = ''
  return {
    number,
    baseRepo: { host: url.hostname, owner: match[1], repo: match[2] },
    url: url.href.replace(/\/$/, ''),
  }
}

export interface PrFilter {
  state?: 'open' | 'closed' | 'all'
  author?: string
  /** Exact head branch lookup; used by task/session PR discovery. */
  head?: string
}

export interface PrListPage {
  items: PullRequest[]
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

/**
 * One pull request, as the host reports it.
 *
 * There is a single shape whether a row came from a listing or from a direct
 * read: a list row that omitted a field is not a different kind of pull
 * request, and asking every reader to tell "absent" from "not loaded" is what
 * made two surfaces disagree about one pull request. Providers fill every field
 * at the mapper. The three genuinely host-computed fields stay nullable because
 * the host itself may not know them yet — never because Solus did not ask.
 */
export interface PullRequest {
  number: number
  /** The host's own page for this pull request, as the host reported it.
   *  Nothing in Solus assembles this string. */
  url: string
  title: string
  /** Current host head, used to key derived list metadata without another request. */
  headSha: string
  baseSha: string
  /** Base repository remote identity for opening the PR on its host. */
  baseRepo: RepoRef
  /** Where the head branch lives; `isFork` true when it differs from the base repo. */
  headRepo: { owner: string; repo: string; isFork: boolean }
  author: string
  authorAvatarUrl: string
  state: 'open' | 'closed' | 'merged'
  createdAt: string
  updatedAt: string
  draft: boolean
  labels: PrLabel[]
  additions: number
  deletions: number
  body: string
  baseRef: string
  headRef: string
  /** Host-computed size; null while the host is still computing it. */
  changedFiles: number | null
  /** Host-computed mergeability; null while the host is still computing it. */
  mergeable: boolean | null
  /** Host-specific merge state, e.g. GitHub REST's `dirty` for merge conflicts. */
  mergeStateStatus: string | null
  capabilities: PrReviewCapabilities
  viewerPermissions: PrViewerPermissions
  /** Pacing guidance only; review always opens the complete diff. */
  effort?: ReviewEffort
  /** Who the host has asked to review this PR and who has not answered yet. */
  requestedReviewers?: PrRequestedReviewer[]
  /** Host logins currently assigned to this PR. */
  assignees?: string[]
  /** Why this PR belongs in the connected viewer's review queue. */
  reviewAttention?: 'requested' | 'assigned'
  needsMyReview?: boolean
  /** GitHub's aggregate review result for list filtering. A direct REST read
   *  can omit it; list pages enrich the row through one batched GraphQL read. */
  reviewStatus?: 'approved' | 'changes-requested' | 'review-required' | 'no-reviews' | 'reviewed'
}

export type PrReviewVerdict = 'comment' | 'approve' | 'request-changes'
export type PrLifecycleAction = 'merge' | 'close' | 'reopen' | 'ready' | 'draft'

/** Canonical lifecycle fields returned by a provider mutation. The mutation
 * response owns these values; callers must not immediately re-read an
 * eventually consistent list/detail endpoint to discover them. */
export type PrLifecycleUpdate = Pick<PullRequest, 'state' | 'draft' | 'updatedAt'>
export type PrMergeMethod = 'merge' | 'squash' | 'rebase'

/** Operations supported by the provider and repository configuration. */
export interface PrReviewCapabilities {
  diff: boolean
  diffFileContents: boolean
  inlineComments: boolean
  threadReplies: boolean
  threadResolution: boolean
  reviewVerdicts: PrReviewVerdict[]
  actions: PrLifecycleAction[]
  mergeMethods: PrMergeMethod[]
  reviewerRequests: boolean
  reviewerCandidates: boolean
  labelManagement: boolean
}

/** Operations the connected viewer may perform on this pull request. */
export interface PrViewerPermissions {
  actions: PrLifecycleAction[]
  reviewVerdicts: PrReviewVerdict[]
  comment: boolean
  resolveThreads: boolean
  requestReviewers: boolean
  manageLabels: boolean
}

/** One repository label, in the form the host uses for PR metadata. */
export interface PrLabel {
  name: string
  color: string
}

export interface PrReviewerCandidate {
  login: string
  avatarUrl?: string
}

/** The account the connected provider token belongs to, as a client shows it. */
export interface ProviderViewer {
  login: string
  /** The host's profile image; absent when the host does not report one. */
  avatarUrl?: string
}

/** A reviewer the host has asked for, as the list fetch already knows them. */
export interface PrRequestedReviewer {
  login: string
  /** The host's profile image; absent for a team or a deleted account. */
  avatarUrl?: string
}

/** Exact host revision shown by PR review. It deliberately contains no local path. */
export interface PrReviewTarget {
  host: string
  owner: string
  repo: string
  number: number
  title: string
  baseRef: string
  headRef: string
  baseSha: string
  headSha: string
  headRepo: { owner: string; repo: string; isFork: boolean }
}

export interface PrDiffRequest {
  number: number
  baseSha: string
  /** Reject the response if the pull request moved after the review opened. */
  headSha: string
  /** Provider-owned opaque page cursor. */
  cursor?: string
  commitSha?: string
}

export interface PrDiffSlice {
  /** Complete unified file patches. A slice never ends inside one file patch. */
  patch: string
  truncated: boolean
  nextCursor: string | null
}

export type PrDiffChangeType = 'change' | 'rename-pure' | 'rename-changed' | 'new' | 'deleted'

export interface PrDiffFileContentsRequest {
  number: number
  baseSha: string
  headSha: string
  commitSha?: string
  oldPath: string
  newPath: string
  changeType: PrDiffChangeType
}

export interface PrDiffFileContents {
  oldContents: string
  newContents: string
}

/** Mutable pull-request content. State/base changes stay behind their dedicated
 * workflows so a generic edit cannot accidentally close or retarget a PR. */
export interface PullRequestUpdate {
  title?: string
  body?: string
}

export interface PullRequestOverview {
  pullRequest: PullRequest
  commits: PrCommit[]
  reviewers: PrReviewer[]
}

export interface ReviewComment {
  id: string
  author: string
  /** The author's GitHub avatar; absent for a deleted/ghost account. */
  authorAvatarUrl?: string
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
  /** The host's profile image; absent for a deleted account. */
  avatarUrl?: string
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

interface PrActivityItemBase {
  id: string
  author: string
  /** The author's GitHub avatar; absent for a deleted/ghost account. */
  authorAvatarUrl?: string
  createdAt: string
  url?: string
}

/** A top-level PR conversation entry, distinct from an inline review thread. */
export interface PrCommentActivityItem extends PrActivityItemBase {
  kind: 'comment' | 'review'
  body: string
  /** Present only for review bodies; uses the host's canonical review state. */
  reviewState?: Exclude<PrReviewer['state'], null>
}

/** A label mutation from the provider's pull request timeline. */
export interface PrLabelActivityItem extends PrActivityItemBase {
  kind: 'label'
  action: 'added' | 'removed'
  label: PrLabel
}

/** Provider activity interleaved with commits and inline review threads. */
export type PrConversationItem = PrCommentActivityItem | PrLabelActivityItem
