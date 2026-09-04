import { GitHubAuth } from './auth'
import type { GitHubClient } from './octokit'
import { githubClients, runGithubRequest } from './request'
import { resolveUploadTarget, uploadGithubAsset } from './asset-upload'
import type { ChangedFileStat, MergeMethod } from '@solus/contracts/types'
import type {
  DraftReview,
  PrDiffFileContents,
  PrDiffFileContentsRequest,
  PrDiffRequest,
  PrDiffSlice,
  PrCommit,
  PrLifecycleAction,
  PrReviewer,
  PrReviewerCandidate,
  Provider,
  PrFilter,
  PullRequest,
  PullRequestOverview,
  PullRequestUpdate,
  RepoRef,
  ReviewComment,
  ReviewProvider,
  ReviewThread,
} from '../types'
import type { PrConversationItem, PrLabel, PrRequestedReviewer, ProviderViewer } from '@solus/contracts/providers'
import { createLogger } from '../../logger'
import { canonicalRepoRef } from './canonical-repo'
import {
  buildChecksQuery,
  normalizeChecksResponse,
  type GqlChecksResponse,
} from './checks'
import type { NumberedPrChecksSummary } from '@solus/contracts/checks-rpc-types'
import {
  githubPullRequestAccessFor,
  listGithubReviewerCandidates,
  updateGithubPullRequestLifecycle,
  type PullRequestAccess,
} from './pull-request-actions'
import { z } from 'zod'

const log = createLogger('main', 'github-provider')

/** GitHub's file status vocabulary folded onto git's status letters. `copied`,
 *  `changed` and `unchanged` have no letter of their own and read as edits. */
const GITHUB_FILE_STATUS = new Map<string, ChangedFileStat['status']>([
  ['added', 'A'],
  ['removed', 'D'],
  ['renamed', 'R'],
])

interface GithubDiffFile {
  filename: string
  previous_filename?: string
  status: string
  patch?: string
}

function diffPath(path: string): string {
  return /[\s"\\]/.test(path) ? JSON.stringify(path) : path
}

/** Only a real commit id may scope a diff — the sha travels into an API path. */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i

/** Convert complete GitHub file records into a unified patch. Keeping this
 * file-based is what guarantees pagination never cuts through a hunk. */
interface UnifiedGithubPatch {
  patch: string
  truncated: boolean
}

export function githubFilesToUnifiedPatch(files: GithubDiffFile[]): UnifiedGithubPatch {
  let truncated = false
  const patches = files.map((file) => {
    const oldPath = file.previous_filename ?? file.filename
    const oldLabel = file.status === 'added' ? '/dev/null' : `a/${oldPath}`
    const newLabel = file.status === 'removed' ? '/dev/null' : `b/${file.filename}`
    const lines = [`diff --git ${diffPath(`a/${oldPath}`)} ${diffPath(`b/${file.filename}`)}`]
    if (file.status === 'added') lines.push('new file mode 100644')
    if (file.status === 'removed') lines.push('deleted file mode 100644')
    if (file.status === 'renamed') {
      lines.push(`rename from ${oldPath}`, `rename to ${file.filename}`)
      if (!file.patch) lines.push('similarity index 100%')
    }
    lines.push(`--- ${diffPath(oldLabel)}`, `+++ ${diffPath(newLabel)}`)
    if (file.patch) lines.push(file.patch)
    else if (file.status !== 'renamed') {
      // GitHub omits `patch` for binary and oversized files. The file remains
      // visible, but expanded source context must come from the contents RPC.
      truncated = true
      lines.push(`Binary files ${diffPath(oldLabel)} and ${diffPath(newLabel)} differ`)
    }
    return lines.join('\n')
  })
  return { patch: patches.join('\n'), truncated }
}

/** GitHub's compare response has no `head_commit` field. The last ahead
 * commit is the compared head; when there are no ahead commits, the merge
 * base is the head because it is equal to or behind the base revision. */
export function githubComparedHeadSha(comparison: {
  commits: Array<{ sha: string }>
  merge_base_commit: { sha: string }
}): string {
  return comparison.commits[comparison.commits.length - 1]?.sha ?? comparison.merge_base_commit.sha
}

// ─── GraphQL documents ────────────────────────────────────────────────────────
// REST can't report a thread's resolution state, and there is no REST mutation to
// resolve/unresolve — so threads and their lifecycle go through GraphQL (§6.3).

const REVIEW_THREADS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            diffSide
            comments(first: 100) {
              nodes { id author { login avatarUrl } body createdAt diffHunk }
            }
          }
        }
      }
    }
  }
`

const REPLY_MUTATION = `
  mutation($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
      comment { id author { login avatarUrl } body createdAt }
    }
  }
`

const RESOLVE_MUTATION = `
  mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
  }
`

const UNRESOLVE_MUTATION = `
  mutation($threadId: ID!) {
    unresolveReviewThread(input: { threadId: $threadId }) { thread { id } }
  }
`

const DELETE_ISSUE_COMMENT_MUTATION = `
  mutation($commentId: ID!) {
    deleteIssueComment(input: { id: $commentId }) { clientMutationId }
  }
`

const PR_CONVERSATION_QUERY = `
  query PrConversation(
    $owner: String!
    $repo: String!
    $number: Int!
    $commentsCursor: String
    $reviewsCursor: String
    $timelineCursor: String
    $includeComments: Boolean!
    $includeReviews: Boolean!
    $includeTimeline: Boolean!
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        comments(first: 100, after: $commentsCursor) @include(if: $includeComments) {
          pageInfo { hasNextPage endCursor }
          nodes { id author { login avatarUrl } body createdAt url }
        }
        reviews(first: 100, after: $reviewsCursor) @include(if: $includeReviews) {
          pageInfo { hasNextPage endCursor }
          nodes { id author { login avatarUrl } body createdAt submittedAt state url }
        }
        timelineItems(
          first: 100
          after: $timelineCursor
          itemTypes: [LABELED_EVENT, UNLABELED_EVENT]
        ) @include(if: $includeTimeline) {
          pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on LabeledEvent {
              id
              actor { login avatarUrl }
              createdAt
              label { name color }
            }
            ... on UnlabeledEvent {
              id
              actor { login avatarUrl }
              createdAt
              label { name color }
            }
          }
        }
      }
    }
  }
`

/** Everything `PullRequest` needs from a search hit. Named once so the two
 *  search aliases below cannot select different fields for the same rows. */
const NEEDS_REVIEW_FIELDS = `
  fragment NeedsReviewFields on PullRequest {
    number
    url
    title
    headRefOid
    author { login avatarUrl }
    state
    createdAt
    updatedAt
    isDraft
    labels(first: 100) { nodes { name color } }
    additions
    deletions
    reviewRequests(first: 100) {
      nodes {
        requestedReviewer {
          ... on User { login avatarUrl }
        }
      }
    }
    assignees(first: 100) { nodes { login } }
    body
    baseRefName
    baseRefOid
    headRefName
    changedFiles
    mergeable
    reviewDecision
    reviews(first: 1) { totalCount }
    baseRepository { nameWithOwner }
    headRepository { nameWithOwner name owner { login } }
  }
`

const NEEDS_REVIEW_QUERY = `
  query(
    $requestedQuery: String!
    $assignedQuery: String!
    $requestedCursor: String
    $assignedCursor: String
    $includeRequested: Boolean!
    $includeAssigned: Boolean!
  ) {
    requested: search(
      query: $requestedQuery
      type: ISSUE
      first: 100
      after: $requestedCursor
    ) @include(if: $includeRequested) {
      pageInfo { hasNextPage endCursor }
      nodes { ...NeedsReviewFields }
    }
    assigned: search(
      query: $assignedQuery
      type: ISSUE
      first: 100
      after: $assignedCursor
    ) @include(if: $includeAssigned) {
      pageInfo { hasNextPage endCursor }
      nodes { ...NeedsReviewFields }
    }
  }
  ${NEEDS_REVIEW_FIELDS}
`

interface GqlComment {
  id: string
  author: { login: string; avatarUrl: string } | null
  body: string
  createdAt: string
  diffHunk?: string
}

interface GqlThread {
  id: string
  isResolved: boolean
  isOutdated: boolean
  path: string
  line: number | null
  diffSide: 'LEFT' | 'RIGHT'
  comments: { nodes: GqlComment[] }
}

interface ReviewThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
        nodes: GqlThread[]
      }
    }
  }
}

interface GqlConversationNode {
  id: string
  author: { login: string; avatarUrl: string } | null
  body: string
  createdAt: string
  url?: string
}

interface GqlReviewBody extends GqlConversationNode {
  submittedAt: string | null
  state: Exclude<PrReviewer['state'], null>
}

interface GqlLabelEvent {
  __typename: 'LabeledEvent' | 'UnlabeledEvent'
  id: string
  actor: { login: string; avatarUrl: string } | null
  createdAt: string
  label: { name: string; color: string }
}

interface GqlConversationPage<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
  nodes: T[]
}

interface PrConversationResponse {
  repository: {
    pullRequest: {
      comments?: GqlConversationPage<GqlConversationNode>
      reviews?: GqlConversationPage<GqlReviewBody>
      timelineItems?: GqlConversationPage<GqlLabelEvent>
    }
  }
}

interface GqlNeedsReviewPullRequest {
  number: number
  url: string
  title: string
  headRefOid: string
  author: { login: string; avatarUrl: string } | null
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  createdAt: string
  updatedAt: string
  isDraft: boolean
  labels: { nodes: Array<{ name: string; color: string }> }
  additions: number
  deletions: number
  reviewRequests: {
    nodes: Array<{ requestedReviewer: { login?: string; avatarUrl?: string } | null }>
  }
  assignees: { nodes: Array<{ login: string }> }
  body: string
  baseRefName: string
  baseRefOid: string
  headRefName: string
  changedFiles: number
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  reviews: { totalCount: number }
  baseRepository: { nameWithOwner: string } | null
  headRepository: { nameWithOwner: string; name: string; owner: { login: string } } | null
}

interface GqlNeedsReviewPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
  nodes: Array<GqlNeedsReviewPullRequest | null>
}

interface NeedsReviewSearchResponse {
  requested?: GqlNeedsReviewPage
  assigned?: GqlNeedsReviewPage
}

interface NeedsReviewSearchTerms {
  requestedQuery: string
  assignedQuery: string
}

export function needsReviewSearchTerms(repo: RepoRef, viewer: string): NeedsReviewSearchTerms {
  const scope = `repo:${repo.owner}/${repo.repo} is:pr is:open`
  return {
    requestedQuery: `${scope} review-requested:${viewer}`,
    assignedQuery: `${scope} assignee:${viewer}`,
  }
}

function toNeedsReviewPullRequest(
  pr: GqlNeedsReviewPullRequest,
  repo: RepoRef,
  access: PullRequestAccess,
): PullRequest {
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    headSha: pr.headRefOid,
    baseSha: pr.baseRefOid,
    baseRepo: repo,
    headRepo: headRepoOf(
      repo,
      {
        owner: pr.headRepository?.owner.login,
        repo: pr.headRepository?.name,
        fullName: pr.headRepository?.nameWithOwner,
      },
      pr.baseRepository?.nameWithOwner,
    ),
    author: pr.author?.login ?? '',
    authorAvatarUrl: pr.author?.avatarUrl ?? '',
    state: pr.state === 'OPEN' ? 'open' : pr.state === 'MERGED' ? 'merged' : 'closed',
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    draft: pr.isDraft,
    labels: pr.labels.nodes,
    additions: pr.additions,
    deletions: pr.deletions,
    requestedReviewers: requestedReviewers(
      pr.reviewRequests.nodes.map((node) => node.requestedReviewer),
    ),
    assignees: pr.assignees.nodes.map(({ login }) => login),
    body: pr.body,
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    changedFiles: pr.changedFiles,
    // GraphQL reports UNKNOWN while GitHub computes the merge in the background.
    mergeable: pr.mergeable === 'UNKNOWN' ? null : pr.mergeable === 'MERGEABLE',
    // `mergeStateStatus` is behind an Accept-header preview this query does not
    // request; search rows say "not computed" rather than guessing a state.
    mergeStateStatus: null,
    reviewStatus: reviewStatusOf(pr.reviewDecision, pr.reviews.totalCount),
    ...access,
  }
}

type PullRequestReviewStatus = NonNullable<PullRequest['reviewStatus']>

function reviewStatusOf(
  decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null,
  reviewCount: number,
): PullRequestReviewStatus {
  if (decision === 'APPROVED') return 'approved'
  if (decision === 'CHANGES_REQUESTED') return 'changes-requested'
  if (decision === 'REVIEW_REQUIRED') return 'review-required'
  return reviewCount === 0 ? 'no-reviews' : 'reviewed'
}

interface ReviewStatusResponse {
  nodes: Array<{
    id: string
    reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
    reviews: { totalCount: number }
  } | null>
}

const REVIEW_STATUS_QUERY = `
  query PrReviewStatuses($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on PullRequest {
        id
        reviewDecision
        reviews(first: 1) { totalCount }
      }
    }
  }
`

async function reviewStatuses(
  client: GitHubClient,
  nodeIds: string[],
): Promise<Map<string, PullRequestReviewStatus>> {
  if (nodeIds.length === 0) return new Map()
  const response = await client.graphql<ReviewStatusResponse>(REVIEW_STATUS_QUERY, { ids: nodeIds })
  return new Map(
    response.nodes.flatMap((node) => node
      ? [[node.id, reviewStatusOf(node.reviewDecision, node.reviews.totalCount)] as const]
      : []),
  )
}

const githubApiErrorSchema = z.object({
  status: z.number().optional(),
  response: z
    .object({
      data: z
        .object({
          message: z.string().optional(),
          errors: z
            .array(
              z.object({
                message: z.string().optional(),
                resource: z.string().optional(),
                field: z.string().optional(),
                code: z.string().optional(),
              }),
            )
            .optional(),
        })
        .optional(),
    })
    .optional(),
})

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed || null
}

export function githubApiErrorMessage<T>(err: T, fallback: string): string {
  const parsed = githubApiErrorSchema.safeParse(err)
  const status = parsed.success ? parsed.data.status : undefined
  const responseData = parsed.success ? parsed.data.response?.data : undefined
  const bodyMessage = nonEmpty(responseData?.message)
  const details = responseData?.errors
    ? responseData.errors
        .map((detail) => {
          const message = nonEmpty(detail.message)
          if (message) return message

          const field = nonEmpty(detail.field)
          const code = nonEmpty(detail.code)
          const resource = nonEmpty(detail.resource)
          return [resource, field, code].filter(Boolean).join(' ')
        })
        .filter(Boolean)
    : []

  const parts = [bodyMessage, ...details].filter(Boolean)
  if (parts.length > 0) return `${fallback}${status ? ` (${status})` : ''}: ${parts.join('; ')}`

  const message = err instanceof Error ? err.message : String(err)
  return message ? `${fallback}: ${message}` : fallback
}

// ─── Mappers (Octokit/GraphQL → host-neutral DTOs) ────────────────────────────

/** Shared shape of a PR across the REST list and get responses we read. */
interface RestPull {
  node_id?: string
  number: number
  /** The pull request's own page, as GitHub names it. Every list and get
   *  response carries it, so Solus never has to assemble the string. */
  html_url: string
  title: string
  user: { login: string; avatar_url?: string } | null
  state: string
  merged_at: string | null
  created_at: string
  updated_at: string
  draft?: boolean
  labels?: Array<{ name: string; color: string }> | null
  additions?: number
  deletions?: number
  requested_reviewers?: Array<{ login: string; avatar_url?: string } | null> | null
  assignees?: Array<{ login: string } | null> | null
  body?: string | null
  changed_files?: number
  mergeable?: boolean | null
  mergeable_state?: string | null
  base: { ref: string; sha: string; repo?: { full_name?: string } | null }
  head: { ref: string; sha: string; repo?: { full_name?: string; name?: string; owner?: { login?: string } } | null }
}

/**
 * Where the head branch lives. It is a fork when its repository differs from the
 * base's; a head repository GitHub no longer names — a deleted fork — reads as
 * the base rather than as a repository that does not exist.
 *
 * Shared by both mappers so the REST and search views of one pull request can
 * never disagree about whether it came from a fork.
 */
function headRepoOf(
  base: RepoRef,
  head: { owner?: string; repo?: string; fullName?: string },
  baseFullName: string | undefined,
): PullRequest['headRepo'] {
  return {
    owner: head.owner ?? base.owner,
    repo: head.repo ?? base.repo,
    isFork: !!head.fullName && !!baseFullName && head.fullName !== baseFullName,
  }
}

/** GitHub returns a null user where the account is gone. Those rows carry no
 *  login, so they name nobody rather than an empty reviewer. */
function logins(users: Array<{ login?: string } | null> | null | undefined): string[] {
  return (users ?? []).flatMap((user) => user?.login ? [user.login] : [])
}

/** The same rule as `logins`, keeping the profile image the list already paid
 *  for so a row can draw the reviewer rather than their initials. Both of
 *  GitHub's spellings land here: REST's `avatar_url` and GraphQL's `avatarUrl`. */
function requestedReviewers(
  users: Array<{ login?: string; avatarUrl?: string; avatar_url?: string } | null> | null | undefined,
): PrRequestedReviewer[] {
  return (users ?? []).flatMap((user) => {
    if (!user?.login) return []
    const avatarUrl = user.avatarUrl ?? user.avatar_url
    return [avatarUrl ? { login: user.login, avatarUrl } : { login: user.login }]
  })
}

/**
 * The one REST mapper. `pulls.list` and `pulls.get` return the same shape; the
 * list simply leaves the three host-computed fields off, which is what their
 * `null` means. Everything else — including access, which costs one memoised
 * `repos.get` for the whole page — is filled here so no reader downstream has
 * to ask which endpoint a row came from.
 */
function toPullRequest(
  pr: RestPull,
  repo: RepoRef,
  access: PullRequestAccess,
  reviewStatus?: PullRequestReviewStatus,
): PullRequest {
  return {
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    baseRepo: repo,
    headRepo: headRepoOf(
      repo,
      { owner: pr.head.repo?.owner?.login, repo: pr.head.repo?.name, fullName: pr.head.repo?.full_name },
      pr.base.repo?.full_name,
    ),
    author: pr.user?.login ?? '',
    authorAvatarUrl: pr.user?.avatar_url ?? '',
    state: pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    draft: pr.draft ?? false,
    labels: (pr.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    requestedReviewers: requestedReviewers(pr.requested_reviewers),
    assignees: logins(pr.assignees),
    body: pr.body ?? '',
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    changedFiles: pr.changed_files ?? null,
    mergeable: pr.mergeable ?? null,
    mergeStateStatus: pr.mergeable_state ?? null,
    ...(reviewStatus ? { reviewStatus } : {}),
    ...access,
  }
}

const REVIEWER_STATES = new Set<NonNullable<PrReviewer['state']>>([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
  'PENDING',
])

function reviewerState(state: string): NonNullable<PrReviewer['state']> {
  if (REVIEWER_STATES.has(state)) {
    // SAFETY: Set membership proves that this string is one of the declared review-state literals.
    return state as NonNullable<PrReviewer['state']>
  }
  return 'COMMENTED'
}

function reviewer(
  login: string,
  avatarUrl: string | undefined,
  state: PrReviewer['state'],
): PrReviewer {
  return avatarUrl ? { login, avatarUrl, state } : { login, state }
}

function toComment(c: GqlComment): ReviewComment {
  const comment: ReviewComment = {
    id: c.id,
    author: c.author?.login ?? '',
    body: c.body,
    createdAt: c.createdAt,
  }
  if (c.author?.avatarUrl) comment.authorAvatarUrl = c.author.avatarUrl
  if (c.diffHunk) comment.diffHunk = c.diffHunk
  return comment
}

function toThread(t: GqlThread): ReviewThread {
  return {
    id: t.id,
    filePath: t.path,
    line: t.line,
    side: t.diffSide,
    isResolved: t.isResolved,
    isOutdated: t.isOutdated,
    comments: t.comments.nodes.map(toComment),
  }
}

/** The REST client targets api.github.com whatever `RepoRef.host` a caller
 *  passes, so the viewer identity is always the github.com one. */
const GITHUB_HOST = 'github.com'

/** The account a client is signed in as, read once per client. */
const viewerByClient = new WeakMap<GitHubClient, Promise<ProviderViewer>>()

function viewerProfile(client: GitHubClient): Promise<ProviderViewer> {
  let viewer = viewerByClient.get(client)
  if (!viewer) {
    viewer = client.rest.users.getAuthenticated()
      .then(({ data }) => {
        const profile: ProviderViewer = { login: data.login }
        if (data.avatar_url) profile.avatarUrl = data.avatar_url
        return profile
      })
      .catch((error) => {
        viewerByClient.delete(client)
        throw error
      })
    viewerByClient.set(client, viewer)
  }
  return viewer
}

async function viewerLogin(client: GitHubClient): Promise<string> {
  return (await viewerProfile(client)).login
}

/**
 * Access for one row. `githubPullRequestAccessFor` memoises the repository
 * settings per client, so a whole page costs one `repos.get` and one viewer
 * read no matter how many distinct authors it holds.
 */
async function accessFor(client: GitHubClient, repo: RepoRef, author: string): Promise<PullRequestAccess> {
  return githubPullRequestAccessFor(client, repo, await viewerLogin(client), author)
}

/**
 * Typed GitHub operations for PR review mode over REST + GraphQL. The consuming
 * layer imports `ReviewProvider`/DTOs only — never `@octokit/*`. Reads, threads,
 * and leaving review comments work identically for fork and same-repo PRs.
 */
export class GitHubProvider implements ReviewProvider {
  private diffBaseCache = new Map<string, Promise<string>>()

  /**
   * The clients to try for `host`, one per credential in chain order. This is
   * the provider's one seam: tests script GitHub's answers by replacing it.
   */
  protected async clients(host: string, credentialCwd?: string): Promise<GitHubClient[]> {
    return githubClients(host, credentialCwd)
  }

  /**
   * Run one operation — read or write — with the first credential GitHub
   * accepts.
   *
   * A rejected token and GitHub's credential-specific access responses move to
   * the next client. GitHub uses both 403 and 404 when an OAuth app cannot see
   * an organization repository, while the user's gh credential may see it.
   * Validation, conflict, and other domain failures remain final.
   */
  private async withClient<Result>(
    operation: string,
    host: string,
    run: (client: GitHubClient) => Promise<Result>,
    credentialCwd?: string,
  ): Promise<Result> {
    return runGithubRequest(operation, host, await this.clients(host, credentialCwd), run)
  }

  async getViewer(repo?: RepoRef): Promise<string> {
    if (!repo) return this.withClient('get_github_viewer', GITHUB_HOST, viewerLogin)
    return this.withClient('get_github_viewer_for_repo', repo.host, async (client) => {
      await accessFor(client, repo, '')
      return viewerLogin(client)
    })
  }

  async getViewerProfile(): Promise<ProviderViewer> {
    return this.withClient('get_github_viewer', GITHUB_HOST, viewerProfile)
  }

  async listPullRequests(repo: RepoRef, filter?: PrFilter): Promise<PullRequest[]> {
    const data: PullRequest[] = []
    for (let page = 1; ; page++) {
      const result = await this.listPullRequestsPage(repo, filter, page, 100)
      data.push(...result.items)
      if (!result.hasMore) break
    }
    return data
  }

  async listPullRequestsPage(
    repo: RepoRef,
    filter?: PrFilter,
    page = 1,
    perPage = 100,
  ): Promise<import('@solus/contracts/providers').PrListPage> {
    return this.withClient('list_pull_requests', repo.host, async (client) => {
      const { data } = await client.rest.pulls.list({
        owner: repo.owner,
        repo: repo.repo,
        state: filter?.state ?? 'open',
        head: filter?.head ? `${repo.owner}:${filter.head}` : undefined,
        sort: 'updated',
        direction: 'desc',
        per_page: perPage,
        page,
      })
      const wanted = filter?.author
        ? data.filter((pr) => (pr.user?.login ?? '').toLowerCase() === filter.author?.toLowerCase())
        : data
      const statuses = await reviewStatuses(
        client,
        wanted.flatMap((pr) => pr.node_id ? [pr.node_id] : []),
      )
      const items = await Promise.all(
        wanted.map(async (pr) => toPullRequest(
          pr,
          repo,
          await accessFor(client, repo, pr.user?.login ?? ''),
          pr.node_id ? statuses.get(pr.node_id) : undefined,
        )),
      )
      return { items, page, hasMore: data.length === perPage }
    })
  }

  async createPullRequest(
    repo: RepoRef,
    input: { baseRef: string; headRef: string; title: string; body: string; credentialCwd?: string },
  ): Promise<PullRequest> {
    return this.withClient('create_pull_request', repo.host, async (client) => {
      const { data } = await client.rest.pulls.create({
        owner: repo.owner,
        repo: repo.repo,
        base: input.baseRef,
        head: input.headRef,
        title: input.title,
        body: input.body,
      })
      return toPullRequest(data, repo, await accessFor(client, repo, data.user?.login ?? ''))
    }, input.credentialCwd)
  }

  async listPullRequestsNeedingReview(repo: RepoRef, viewer: string): Promise<PullRequest[]> {
    return this.withClient('list_pull_requests_needing_review', repo.host, async (client) => {
      // A renamed repository is still reachable by its old name everywhere except
      // search, where the stale qualifier silently matches nothing.
      const queries = needsReviewSearchTerms(await canonicalRepoRef(client, repo), viewer)
      const pullRequests = new Map<number, PullRequest>()
      let requestedCursor: string | null = null
      let assignedCursor: string | null = null
      let hasMoreRequested = true
      let hasMoreAssigned = true

      while (hasMoreRequested || hasMoreAssigned) {
        const response: NeedsReviewSearchResponse = await client.graphql<NeedsReviewSearchResponse>(NEEDS_REVIEW_QUERY, {
          ...queries,
          requestedCursor,
          assignedCursor,
          includeRequested: hasMoreRequested,
          includeAssigned: hasMoreAssigned,
        })
        const requested = response.requested
        const assigned = response.assigned
        for (const pr of [...(requested?.nodes ?? []), ...(assigned?.nodes ?? [])]) {
          if (!pr) continue
          const access = await accessFor(client, repo, pr.author?.login ?? '')
          pullRequests.set(pr.number, toNeedsReviewPullRequest(pr, repo, access))
        }
        hasMoreRequested = requested?.pageInfo.hasNextPage ?? false
        hasMoreAssigned = assigned?.pageInfo.hasNextPage ?? false
        requestedCursor = requested?.pageInfo.endCursor ?? requestedCursor
        assignedCursor = assigned?.pageInfo.endCursor ?? assignedCursor
      }

      return [...pullRequests.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    })
  }

  async getPullRequestOverview(repo: RepoRef, number: number): Promise<PullRequestOverview> {
    const [pullRequest, commits, reviewers] = await Promise.all([
      this.getPullRequest(repo, number),
      this.listCommits(repo, number),
      this.listReviewers(repo, number),
    ])
    return { pullRequest, commits, reviewers }
  }

  async getPullRequestDiffBase(repo: RepoRef, pullRequest: PullRequest): Promise<string> {
    const key = `${repo.host}/${repo.owner}/${repo.repo}:${pullRequest.number}:${pullRequest.baseSha}:${pullRequest.headSha}`
    let pending = this.diffBaseCache.get(key)
    if (!pending) {
      pending = this.withClient('get_pull_request_diff_base', repo.host, async ({ rest }) => {
        const { data } = await rest.repos.compareCommitsWithBasehead({
          owner: repo.owner,
          repo: repo.repo,
          basehead: `${pullRequest.baseSha}...refs/pull/${pullRequest.number}/head`,
        })
        if (githubComparedHeadSha(data) !== pullRequest.headSha) {
          throw new Error('This pull request changed while its diff base was loading.')
        }
        return data.merge_base_commit.sha
      }).catch((error) => {
        this.diffBaseCache.delete(key)
        throw error
      })
      this.diffBaseCache.set(key, pending)
    }
    return pending
  }

  async getPullRequestDiff(repo: RepoRef, request: PrDiffRequest): Promise<PrDiffSlice> {
    const detail = await this.getPullRequest(repo, request.number)
    if (detail.headSha !== request.headSha) {
      throw new Error('This pull request changed. Refresh it before reviewing the new diff.')
    }
    const page = request.cursor === undefined ? 1 : Number(request.cursor)
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid pull request diff cursor.')
    return this.withClient('get_pull_request_diff', repo.host, async ({ rest }) => {
      if (request.commitSha) {
        // One commit of the change rather than the whole of it. A commit is
        // content-addressed, so no base staleness check applies: the sha either
        // exists with exactly this diff or the request fails.
        if (!COMMIT_SHA_PATTERN.test(request.commitSha)) throw new Error('Invalid pull request commit.')
        const response = await rest.repos.getCommit({
          owner: repo.owner,
          repo: repo.repo,
          ref: request.commitSha,
          page,
          per_page: 100,
        })
        const converted = githubFilesToUnifiedPatch(response.data.files ?? [])
        const hasNextPage = /<[^>]+>;\s*rel="next"/.test(response.headers.link ?? '')
        return {
          patch: converted.patch,
          truncated: converted.truncated,
          nextCursor: hasNextPage ? String(page + 1) : null,
        }
      }
      const diffBaseSha = await this.getPullRequestDiffBase(repo, detail)
      if (diffBaseSha !== request.baseSha) {
        throw new Error('This pull request base changed. Refresh it before reviewing the new diff.')
      }
      const response = await rest.pulls.listFiles({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: request.number,
        page,
        per_page: 100,
      })
      const converted = githubFilesToUnifiedPatch(response.data)
      const hasNextPage = /<[^>]+>;\s*rel="next"/.test(response.headers.link ?? '')
      return {
        patch: converted.patch,
        truncated: converted.truncated,
        nextCursor: hasNextPage ? String(page + 1) : null,
      }
    })
  }

  async getPullRequestDiffFileContents(
    repo: RepoRef,
    request: PrDiffFileContentsRequest,
  ): Promise<PrDiffFileContents> {
    const detail = await this.getPullRequest(repo, request.number)
    if (detail.headSha !== request.headSha) {
      throw new Error('This pull request changed. Refresh it before loading file contents.')
    }
    return this.withClient('get_pull_request_diff_file_contents', repo.host, async ({ rest }) => {
      const readFile = async (source: RepoRef, path: string, ref: string): Promise<string> => {
        const { data } = await rest.repos.getContent({ owner: source.owner, repo: source.repo, path, ref })
        if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) {
          throw new Error(`GitHub did not return file contents for ${path}.`)
        }
        if (data.encoding !== 'base64') throw new Error(`GitHub returned an unsupported encoding for ${path}.`)
        return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8')
      }
      const headRepo: RepoRef = { host: repo.host, owner: detail.headRepo.owner, repo: detail.headRepo.repo }
      if (request.commitSha) {
        // A commit-scoped diff compares against the commit's parent, not the PR
        // base, and the contents API accepts no `sha^` expression — resolve the
        // parent explicitly. A root commit has no parent; its old side is empty.
        if (!COMMIT_SHA_PATTERN.test(request.commitSha)) throw new Error('Invalid pull request commit.')
        const { data: commit } = await rest.git.getCommit({
          owner: repo.owner,
          repo: repo.repo,
          commit_sha: request.commitSha,
        })
        const parentSha = commit.parents[0]?.sha
        const oldContents = request.changeType === 'new' || !parentSha
          ? ''
          : await readFile(headRepo, request.oldPath, parentSha)
        const newContents = request.changeType === 'deleted'
          ? ''
          : await readFile(headRepo, request.newPath, request.commitSha)
        return { oldContents, newContents }
      }
      const diffBaseSha = await this.getPullRequestDiffBase(repo, detail)
      if (diffBaseSha !== request.baseSha) {
        throw new Error('This pull request base changed. Refresh it before loading file contents.')
      }
      const oldContents = request.changeType === 'new'
        ? ''
        : await readFile(repo, request.oldPath, diffBaseSha)
      const newContents = request.changeType === 'deleted'
        ? ''
        : await readFile(headRepo, request.newPath, request.headSha)
      return { oldContents, newContents }
    })
  }

  async getPullRequest(repo: RepoRef, number: number): Promise<PullRequest> {
    return this.withClient('get_pull_request', repo.host, async (client) => {
      const { data: pr } = await client.rest.pulls.get({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
      })
      return toPullRequest(pr, repo, await accessFor(client, repo, pr.user?.login ?? ''))
    })
  }

  async updatePullRequest(
    repo: RepoRef,
    number: number,
    patch: PullRequestUpdate,
  ): Promise<PullRequest> {
    interface PullRequestEditFields {
      title?: string
      body?: string
    }
    const fields: PullRequestEditFields = {}
    if (patch.title !== undefined) fields.title = patch.title
    if (patch.body !== undefined) fields.body = patch.body
    if (Object.keys(fields).length > 0) {
      await this.withClient('update_pull_request', repo.host, async ({ rest }) => {
        await rest.pulls.update({
          owner: repo.owner,
          repo: repo.repo,
          pull_number: number,
          ...fields,
        })
      })
    }
    return this.getPullRequest(repo, number)
  }

  async listReviewThreads(repo: RepoRef, number: number): Promise<ReviewThread[]> {
    return this.withClient('list_pull_request_threads', repo.host, async ({ graphql }) => {
      const threads: ReviewThread[] = []
      let cursor: string | null = null
      // Threads paginate; comments per thread (first 100) effectively never do.
      for (;;) {
        const res: ReviewThreadsResponse = await graphql<ReviewThreadsResponse>(REVIEW_THREADS_QUERY, {
          owner: repo.owner,
          repo: repo.repo,
          number,
          cursor,
        })
        const page = res.repository.pullRequest.reviewThreads
        for (const node of page.nodes) threads.push(toThread(node))
        if (!page.pageInfo.hasNextPage) break
        cursor = page.pageInfo.endCursor
      }
      return threads
    })
  }

  async listCommits(repo: RepoRef, number: number): Promise<PrCommit[]> {
    return this.withClient('list_pull_request_commits', repo.host, async ({ rest }) => {
      // Paginated; the REST endpoint itself caps a PR's commit list at 250.
      const data = await rest.paginate(rest.pulls.listCommits, {
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
        per_page: 100,
      })
      return data.map((c) => ({
        sha: c.sha,
        // GitHub shows only the subject line in the timeline; drop the body.
        message: c.commit.message.split('\n', 1)[0],
        author: c.author?.login ?? c.commit.author?.name ?? '',
        committedAt: c.commit.author?.date ?? c.commit.committer?.date ?? '',
      }))
    })
  }

  async listReviewers(repo: RepoRef, number: number): Promise<PrReviewer[]> {
    return this.withClient('list_pull_request_reviewers', repo.host, async ({ rest }) => {
      const [reviews, { data: requested }] = await Promise.all([
        rest.paginate(rest.pulls.listReviews, { owner: repo.owner, repo: repo.repo, pull_number: number, per_page: 100 }),
        rest.pulls.listRequestedReviewers({ owner: repo.owner, repo: repo.repo, pull_number: number }),
      ])
      // Fold each user's chronological reviews into their standing state, matching
      // GitHub's semantics: an approval / change request holds until dismissed or
      // replaced by another approval / change request — a later COMMENTED review
      // does not demote it. PENDING is the viewer's own unsubmitted draft, not a
      // review state at all.
      const map = new Map<string, PrReviewer>()
      for (const r of reviews) {
        const login = r.user?.login
        if (!login) continue
        const state = reviewerState(r.state)
        if (state === 'PENDING') continue
        const prev = map.get(login)?.state
        if (state === 'COMMENTED' && (prev === 'APPROVED' || prev === 'CHANGES_REQUESTED')) continue
        map.set(login, reviewer(login, r.user?.avatar_url, state))
      }
      // Users who are requested but haven't reviewed yet.
      for (const u of requested.users) {
        if (!map.has(u.login)) {
          map.set(u.login, reviewer(u.login, u.avatar_url, null))
        }
      }
      return [...map.values()]
    })
  }

  async listReviewerCandidates(repo: RepoRef, pullRequest: PullRequest): Promise<PrReviewerCandidate[]> {
    return this.withClient(
      'list_pull_request_reviewer_candidates',
      repo.host,
      (client) => listGithubReviewerCandidates(client, repo, pullRequest.author),
    )
  }

  async listLabelCandidates(repo: RepoRef): Promise<PrLabel[]> {
    return this.withClient('list_pull_request_label_candidates', repo.host, async ({ rest }) => {
      const labels = await rest.paginate(rest.issues.listLabelsForRepo, {
        owner: repo.owner,
        repo: repo.repo,
        per_page: 100,
      })
      return labels.map((label) => ({ name: label.name, color: label.color }))
    })
  }

  async setLabels(repo: RepoRef, number: number, names: string[]): Promise<PrLabel[]> {
    return this.withClient('set_pull_request_labels', repo.host, async ({ rest }) => {
      const { data } = await rest.issues.setLabels({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: number,
        labels: names,
      })
      return data.map((label) => ({ name: label.name, color: label.color ?? '' }))
    })
  }

  async requestReviewers(repo: RepoRef, number: number, logins: string[]): Promise<PrReviewer[]> {
    await this.withClient('request_reviewers', repo.host, async ({ rest }) => {
      await rest.pulls.requestReviewers({ owner: repo.owner, repo: repo.repo, pull_number: number, reviewers: logins })
    })
    return this.listReviewers(repo, number)
  }

  async removeRequestedReviewer(repo: RepoRef, number: number, login: string): Promise<PrReviewer[]> {
    await this.withClient('remove_requested_reviewer', repo.host, async ({ rest }) => {
      await rest.pulls.removeRequestedReviewers({ owner: repo.owner, repo: repo.repo, pull_number: number, reviewers: [login] })
    })
    return this.listReviewers(repo, number)
  }

  async updatePullRequestLifecycle(
    repo: RepoRef,
    number: number,
    action: Exclude<PrLifecycleAction, 'merge'>,
    expectedHeadSha: string,
  ): Promise<PullRequest> {
    return this.withClient('update_pull_request_lifecycle', repo.host, async (client) => {
      const { data: raw } = await client.rest.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: number })
      const access = await accessFor(client, repo, raw.user?.login ?? '')
      if (!access.viewerPermissions.actions.includes(action)) {
        throw new Error(`You do not have permission to ${action} this pull request.`)
      }
      if (!raw.node_id) throw new Error('GitHub did not return the pull request node ID.')
      const current = toPullRequest(raw, repo, access)
      const lifecycle = await updateGithubPullRequestLifecycle(
        client,
        repo,
        number,
        action,
        expectedHeadSha,
        { headSha: current.headSha, nodeId: raw.node_id, draft: current.draft },
      )
      return { ...current, ...lifecycle }
    })
  }

  async createReview(repo: RepoRef, number: number, review: DraftReview): Promise<void> {
    // One request = atomic from our side: either the whole batch posts or nothing does.
    try {
      type CreateReviewRequest = Parameters<GitHubClient['rest']['pulls']['createReview']>[0]
      const request: CreateReviewRequest = {
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
        commit_id: review.commitId,
        event: review.event,
      }
      // GitHub treats an omitted optional body differently from an empty one.
      if (review.body) request.body = review.body
      if (review.comments.length > 0) {
        request.comments = review.comments.map((comment) => {
          const item = {
            path: comment.path,
            body: comment.body,
            line: comment.line,
            side: comment.side,
          }
          if (comment.startLine !== undefined) {
            Object.assign(item, { start_line: comment.startLine, start_side: comment.side })
          }
          return item
        })
      }
      await this.withClient('create_review', repo.host, async ({ rest }) => {
        await rest.pulls.createReview(request)
      })
    } catch (err) {
      throw new Error(githubApiErrorMessage(err, 'Could not submit the review'))
    }
  }

  async mergePullRequest(repo: RepoRef, number: number, method: MergeMethod): Promise<{ merged: boolean; message?: string }> {
    try {
      const { data } = await this.withClient('merge_pull_request', repo.host, ({ rest }) => rest.pulls.merge({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
        merge_method: method,
      }))
      return { merged: data.merged, message: data.message }
    } catch (err) {
      // 405/409 = not mergeable (conflicts, protection, stale head). Return the
      // host message so the individual PR action can explain the refusal.
      return { merged: false, message: githubApiErrorMessage(err, 'GitHub could not merge the pull request') }
    }
  }

  async listPullRequestFileStats(repo: RepoRef, number: number): Promise<ChangedFileStat[]> {
    return this.withClient('list_pull_request_file_stats', repo.host, async ({ rest }) => {
      const files = await rest.paginate(rest.pulls.listFiles, {
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
        per_page: 100,
      })
      return files.map((f) => ({
        path: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        status: GITHUB_FILE_STATUS.get(f.status) ?? 'M',
      }))
    })
  }

  async replyToThread(repo: RepoRef, threadId: string, body: string): Promise<ReviewComment> {
    return this.withClient('reply_to_thread', repo.host, async ({ graphql }) => {
      // Reply by thread node id directly — the REST replies endpoint needs the first
      // comment's numeric id, which our signature doesn't carry. GraphQL is cleaner here.
      const res = await graphql<{ addPullRequestReviewThreadReply: { comment: GqlComment } }>(
        REPLY_MUTATION,
        { threadId, body },
      )
      return toComment(res.addPullRequestReviewThreadReply.comment)
    })
  }

  async resolveThread(repo: RepoRef, threadId: string): Promise<void> {
    await this.withClient('resolve_thread', repo.host, ({ graphql }) => graphql(RESOLVE_MUTATION, { threadId }))
  }

  async unresolveThread(repo: RepoRef, threadId: string): Promise<void> {
    await this.withClient('unresolve_thread', repo.host, ({ graphql }) => graphql(UNRESOLVE_MUTATION, { threadId }))
  }

  async listComments(repo: RepoRef, number: number): Promise<PrConversationItem[]> {
    return this.withClient('list_pull_request_comments', repo.host, async ({ graphql }) => {
      const items: PrConversationItem[] = []
      let commentsCursor: string | null = null
      let reviewsCursor: string | null = null
      let timelineCursor: string | null = null
      let includeComments = true
      let includeReviews = true
      let includeTimeline = true

      // The two GraphQL connections paginate independently. Once one is complete,
      // @include keeps later pages of the other from refetching duplicate nodes.
      while (includeComments || includeReviews || includeTimeline) {
        const res: PrConversationResponse = await graphql<PrConversationResponse>(PR_CONVERSATION_QUERY, {
          owner: repo.owner,
          repo: repo.repo,
          number,
          commentsCursor,
          reviewsCursor,
          timelineCursor,
          includeComments,
          includeReviews,
          includeTimeline,
        })
        const conversation: PrConversationResponse['repository']['pullRequest'] = res.repository.pullRequest
        if (conversation.comments) {
          for (const comment of conversation.comments.nodes) {
            const item: PrConversationItem = {
              id: comment.id,
              kind: 'comment',
              author: comment.author?.login ?? '',
              body: comment.body,
              createdAt: comment.createdAt,
            }
            if (comment.author?.avatarUrl) item.authorAvatarUrl = comment.author.avatarUrl
            if (comment.url) item.url = comment.url
            items.push(item)
          }
          includeComments = conversation.comments.pageInfo.hasNextPage
          commentsCursor = conversation.comments.pageInfo.endCursor
        }
        if (conversation.reviews) {
          for (const review of conversation.reviews.nodes) {
            if (!review.body.trim() || review.state === 'PENDING') continue
            const item: PrConversationItem = {
              id: review.id,
              kind: 'review',
              author: review.author?.login ?? '',
              body: review.body,
              createdAt: review.submittedAt ?? review.createdAt,
              reviewState: review.state,
            }
            if (review.author?.avatarUrl) item.authorAvatarUrl = review.author.avatarUrl
            if (review.url) item.url = review.url
            items.push(item)
          }
          includeReviews = conversation.reviews.pageInfo.hasNextPage
          reviewsCursor = conversation.reviews.pageInfo.endCursor
        }
        if (conversation.timelineItems) {
          for (const event of conversation.timelineItems.nodes) {
            const item: PrConversationItem = {
              id: event.id,
              kind: 'label',
              author: event.actor?.login ?? '',
              createdAt: event.createdAt,
              action: event.__typename === 'LabeledEvent' ? 'added' : 'removed',
              label: event.label,
            }
            if (event.actor?.avatarUrl) item.authorAvatarUrl = event.actor.avatarUrl
            items.push(item)
          }
          includeTimeline = conversation.timelineItems.pageInfo.hasNextPage
          timelineCursor = conversation.timelineItems.pageInfo.endCursor
        }
      }

      return items.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    })
  }

  async addIssueComment(repo: RepoRef, number: number, body: string): Promise<void> {
    await this.withClient('add_issue_comment', repo.host, async ({ rest }) => {
      await rest.issues.createComment({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: number,
        body,
      })
    })
  }

  /**
   * Upload a stored asset through the endpoint GitHub's own CLI uses for
   * `--attach`, and return the URL a comment can reference.
   *
   * GitHub has no attachment API in the REST reference; this endpoint is the
   * one its web composer and `gh` both use, so the bytes land where a normal
   * attachment would rather than as a file committed into the repository.
   */
  async publishAsset(repo: RepoRef, assetId: string): Promise<string> {
    return this.withClient('publish_asset', repo.host, async (client) => {
      const target = await resolveUploadTarget(client, repo.owner, repo.repo)
      return uploadGithubAsset(client, target, assetId)
    })
  }

  async deleteIssueComment(repo: RepoRef, commentId: string): Promise<void> {
    await this.withClient('delete_issue_comment', repo.host, ({ graphql }) =>
      graphql(DELETE_ISSUE_COMMENT_MUTATION, { commentId }))
  }

  async listChecks(repo: RepoRef, numbers: number[]): Promise<NumberedPrChecksSummary[]> {
    if (numbers.length === 0) return []
    return this.withClient('list_pull_request_checks', repo.host, async ({ graphql }) => {
      const results: NumberedPrChecksSummary[] = []
      for (let offset = 0; offset < numbers.length; offset += 25) {
        const batch = numbers.slice(offset, offset + 25)
        const response = await graphql<GqlChecksResponse>(buildChecksQuery(batch), {
          owner: repo.owner,
          repo: repo.repo,
        })
        results.push(...normalizeChecksResponse(response, batch, (message) => log.warn('pr_checks_normalize_warning', { message })))
      }
      return results
    })
  }
}

export function makeGitHubProvider(): Provider {
  return { id: 'github', auth: new GitHubAuth(), review: new GitHubProvider() }
}
