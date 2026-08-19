import { GitHubAuth } from './auth'
import { buildClient, type GitHubClient } from './octokit'
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
  PullRequestDetail,
  PullRequestOverview,
  PullRequestSummary,
  PullRequestUpdate,
  RepoRef,
  ReviewComment,
  ReviewProvider,
  ReviewThread,
} from '../types'
import type { PrConversationItem } from '@solus/contracts/providers'
import { createLogger } from '../../logger'
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

const PR_CONVERSATION_QUERY = `
  query(
    $owner: String!
    $repo: String!
    $number: Int!
    $commentsCursor: String
    $reviewsCursor: String
    $includeComments: Boolean!
    $includeReviews: Boolean!
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
      }
    }
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
      nodes {
        ... on PullRequest {
          number
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
                ... on User { login }
              }
            }
          }
          assignees(first: 100) { nodes { login } }
          body
          baseRefName
          headRefName
          baseRepository { nameWithOwner }
          headRepository { nameWithOwner }
        }
      }
    }
    assigned: search(
      query: $assignedQuery
      type: ISSUE
      first: 100
      after: $assignedCursor
    ) @include(if: $includeAssigned) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on PullRequest {
          number
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
                ... on User { login }
              }
            }
          }
          assignees(first: 100) { nodes { login } }
          body
          baseRefName
          headRefName
          baseRepository { nameWithOwner }
          headRepository { nameWithOwner }
        }
      }
    }
  }
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
  state: NonNullable<PrConversationItem['reviewState']>
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
    }
  }
}

interface GqlNeedsReviewPullRequest {
  number: number
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
    nodes: Array<{ requestedReviewer: { login?: string } | null }>
  }
  assignees: { nodes: Array<{ login: string }> }
  body: string
  baseRefName: string
  headRefName: string
  baseRepository: { nameWithOwner: string } | null
  headRepository: { nameWithOwner: string } | null
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

function toNeedsReviewSummary(pr: GqlNeedsReviewPullRequest, repo: RepoRef): PullRequestSummary {
  const summary: PullRequestSummary = {
    number: pr.number,
    title: pr.title,
    headSha: pr.headRefOid,
    baseRepo: repo,
    author: pr.author?.login ?? '',
    authorAvatarUrl: pr.author?.avatarUrl ?? '',
    state: pr.state === 'OPEN' ? 'open' : pr.state === 'MERGED' ? 'merged' : 'closed',
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    draft: pr.isDraft,
    labels: pr.labels.nodes,
    additions: pr.additions,
    deletions: pr.deletions,
    requestedReviewers: pr.reviewRequests.nodes.flatMap(({ requestedReviewer }) =>
      requestedReviewer?.login ? [requestedReviewer.login] : []),
    assignees: pr.assignees.nodes.map(({ login }) => login),
    body: pr.body,
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
  }
  if (pr.baseRepository && pr.headRepository) {
    summary.isCrossRepository = pr.baseRepository.nameWithOwner !== pr.headRepository.nameWithOwner
  }
  return summary
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
  title: string
  user: { login: string; avatar_url?: string } | null
  state: string
  merged_at: string | null
  created_at: string
  updated_at: string
  draft?: boolean
  labels?: Array<{ name: string; color: string }>
  additions?: number
  deletions?: number
  requested_reviewers?: Array<{ login: string } | null>
  assignees?: Array<{ login: string } | null>
  body?: string | null
  changed_files?: number
  mergeable?: boolean | null
  mergeable_state?: string | null
  base: { ref: string; sha: string; repo?: { full_name?: string } | null }
  head: { ref: string; sha: string; repo?: { full_name?: string; name?: string; owner?: { login?: string } } | null }
}

function toSummary(pr: RestPull): PullRequestSummary {
  const summary: PullRequestSummary = {
    number: pr.number,
    title: pr.title,
    headSha: pr.head.sha,
    author: pr.user?.login ?? '',
    authorAvatarUrl: pr.user?.avatar_url ?? '',
    state: pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    draft: pr.draft ?? false,
    labels: (pr.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    requestedReviewers: (pr.requested_reviewers ?? [])
      .flatMap((reviewer) => reviewer?.login ? [reviewer.login] : []),
    assignees: (pr.assignees ?? [])
      .flatMap((assignee) => assignee?.login ? [assignee.login] : []),
    body: pr.body ?? '',
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
  }
  if (pr.base.repo?.full_name && pr.head.repo?.full_name) {
    summary.isCrossRepository = pr.base.repo.full_name !== pr.head.repo.full_name
  }
  return summary
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

function withBaseRepo(summary: PullRequestSummary, repo: RepoRef): PullRequestSummary {
  return { ...summary, baseRepo: repo }
}

function toDetail(
  pr: RestPull,
  repo: RepoRef,
  access: Awaited<ReturnType<typeof githubPullRequestAccessFor>>,
): PullRequestDetail {
  const baseFull = pr.base.repo?.full_name
  const headFull = pr.head.repo?.full_name
  return {
    ...withBaseRepo(toSummary(pr), repo),
    body: pr.body ?? '',
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    changedFiles: pr.changed_files ?? 0,
    mergeable: pr.mergeable ?? null,
    mergeStateStatus: pr.mergeable_state ?? null,
    headRepo: {
      owner: pr.head.repo?.owner?.login ?? repo.owner,
      repo: pr.head.repo?.name ?? repo.repo,
      // The head branch lives in a fork when its repo differs from the base repo.
      isFork: !!headFull && !!baseFull && headFull !== baseFull,
    },
    ...access,
  }
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

/**
 * Typed GitHub operations for PR review mode over REST + GraphQL. The consuming
 * layer imports `ReviewProvider`/DTOs only — never `@octokit/*`. Reads, threads,
 * and leaving review comments work identically for fork and same-repo PRs.
 */
export class GitHubProvider implements ReviewProvider {
  private diffBaseCache = new Map<string, Promise<string>>()
  private viewerCache: { token: string; login: Promise<string> } | null = null

  constructor(private readonly auth: GitHubAuth) {}

  /** Lazily build an authenticated client (REST + GraphQL). */
  protected client(): Promise<GitHubClient> {
    return buildClient(this.auth)
  }

  async getViewer(): Promise<string> {
    const token = await this.auth.getAccessToken()
    if (this.viewerCache?.token === token) return this.viewerCache.login

    const login: Promise<string> = this.client()
      .then(({ rest }) => rest.users.getAuthenticated())
      .then(({ data }) => data.login)
      .catch((err) => {
        if (this.viewerCache?.login === login) this.viewerCache = null
        throw err
      })
    this.viewerCache = { token, login }
    return login
  }

  async listPullRequests(repo: RepoRef, filter?: PrFilter): Promise<PullRequestSummary[]> {
    const data: PullRequestSummary[] = []
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
    const { rest } = await this.client()
    const { data } = await rest.pulls.list({
      owner: repo.owner,
      repo: repo.repo,
      state: filter?.state ?? 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: perPage,
      page,
    })
    let items = data.map((pr) => withBaseRepo(toSummary(pr), repo))
    if (filter?.author) {
      const author = filter.author.toLowerCase()
      items = items.filter((pr) => pr.author.toLowerCase() === author)
    }
    return { items, page, hasMore: data.length === perPage }
  }

  async listPullRequestsNeedingReview(repo: RepoRef, viewer: string): Promise<PullRequestSummary[]> {
    const { graphql } = await this.client()
    const queries = needsReviewSearchTerms(repo, viewer)
    const pullRequests = new Map<number, PullRequestSummary>()
    let requestedCursor: string | null = null
    let assignedCursor: string | null = null
    let hasMoreRequested = true
    let hasMoreAssigned = true

    while (hasMoreRequested || hasMoreAssigned) {
      const response = await graphql<NeedsReviewSearchResponse>(NEEDS_REVIEW_QUERY, {
        ...queries,
        requestedCursor,
        assignedCursor,
        includeRequested: hasMoreRequested,
        includeAssigned: hasMoreAssigned,
      })
      const requested = response.requested
      const assigned = response.assigned
      for (const pr of [...(requested?.nodes ?? []), ...(assigned?.nodes ?? [])]) {
        if (pr) pullRequests.set(pr.number, toNeedsReviewSummary(pr, repo))
      }
      hasMoreRequested = requested?.pageInfo.hasNextPage ?? false
      hasMoreAssigned = assigned?.pageInfo.hasNextPage ?? false
      requestedCursor = requested?.pageInfo.endCursor ?? requestedCursor
      assignedCursor = assigned?.pageInfo.endCursor ?? assignedCursor
    }

    return [...pullRequests.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async getPullRequestOverview(repo: RepoRef, number: number): Promise<PullRequestOverview> {
    const [detail, commits, reviewers] = await Promise.all([
      this.getPullRequest(repo, number),
      this.listCommits(repo, number),
      this.listReviewers(repo, number),
    ])
    return { detail, commits, reviewers }
  }

  async getPullRequestDiffBase(repo: RepoRef, pullRequest: PullRequestDetail): Promise<string> {
    const key = `${repo.host}/${repo.owner}/${repo.repo}:${pullRequest.number}:${pullRequest.baseSha}:${pullRequest.headSha}`
    let pending = this.diffBaseCache.get(key)
    if (!pending) {
      pending = this.client().then(async ({ rest }) => {
        const { data } = await rest.repos.compareCommitsWithBasehead({
          owner: repo.owner,
          repo: repo.repo,
          basehead: `${pullRequest.baseSha}...${pullRequest.headRepo.owner}:${pullRequest.headRef}`,
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
    const { rest } = await this.client()
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
  }

  async getPullRequestDiffFileContents(
    repo: RepoRef,
    request: PrDiffFileContentsRequest,
  ): Promise<PrDiffFileContents> {
    const detail = await this.getPullRequest(repo, request.number)
    if (detail.headSha !== request.headSha) {
      throw new Error('This pull request changed. Refresh it before loading file contents.')
    }
    const { rest } = await this.client()
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
  }

  async getPullRequest(repo: RepoRef, number: number): Promise<PullRequestDetail> {
    const client = await this.client()
    const [{ data: pr }, viewer] = await Promise.all([client.rest.pulls.get({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: number,
    }), this.getViewer()])
    const access = await githubPullRequestAccessFor(client, repo, viewer, pr.user?.login ?? '')
    return toDetail(pr, repo, access)
  }

  async updatePullRequest(
    repo: RepoRef,
    number: number,
    patch: PullRequestUpdate,
  ): Promise<PullRequestDetail> {
    const { rest } = await this.client()
    interface PullRequestEditFields {
      title?: string
      body?: string
    }
    const fields: PullRequestEditFields = {}
    if (patch.title !== undefined) fields.title = patch.title
    if (patch.body !== undefined) fields.body = patch.body
    if (Object.keys(fields).length > 0) {
      await rest.pulls.update({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
        ...fields,
      })
    }
    return this.getPullRequest(repo, number)
  }

  async listReviewThreads(repo: RepoRef, number: number): Promise<ReviewThread[]> {
    const { graphql } = await this.client()
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
  }

  async listCommits(repo: RepoRef, number: number): Promise<PrCommit[]> {
    const { rest } = await this.client()
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
  }

  async listReviewers(repo: RepoRef, number: number): Promise<PrReviewer[]> {
    const { rest } = await this.client()
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
      map.set(login, { login, state })
    }
    // Users who are requested but haven't reviewed yet.
    for (const u of requested.users) {
      if (!map.has(u.login)) {
        map.set(u.login, { login: u.login, state: null })
      }
    }
    return [...map.values()]
  }

  async listReviewerCandidates(repo: RepoRef, number: number): Promise<PrReviewerCandidate[]> {
    const [client, pullRequest] = await Promise.all([this.client(), this.getPullRequest(repo, number)])
    return listGithubReviewerCandidates(client, repo, pullRequest.author)
  }

  async requestReviewers(repo: RepoRef, number: number, logins: string[]): Promise<PrReviewer[]> {
    const { rest } = await this.client()
    await rest.pulls.requestReviewers({ owner: repo.owner, repo: repo.repo, pull_number: number, reviewers: logins })
    return this.listReviewers(repo, number)
  }

  async removeRequestedReviewer(repo: RepoRef, number: number, login: string): Promise<PrReviewer[]> {
    const { rest } = await this.client()
    await rest.pulls.removeRequestedReviewers({ owner: repo.owner, repo: repo.repo, pull_number: number, reviewers: [login] })
    return this.listReviewers(repo, number)
  }

  async updatePullRequestLifecycle(
    repo: RepoRef,
    number: number,
    action: Exclude<PrLifecycleAction, 'merge'>,
    expectedHeadSha: string,
  ): Promise<PullRequestDetail> {
    const client = await this.client()
    const [{ data: pullRequest }, viewer] = await Promise.all([
      client.rest.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: number }),
      this.getViewer(),
    ])
    const raw = pullRequest
    const access = await githubPullRequestAccessFor(client, repo, viewer, pullRequest.user?.login ?? '')
    if (!access.viewerPermissions.actions.includes(action)) {
      throw new Error(`You do not have permission to ${action} this pull request.`)
    }
    if (!raw.node_id) throw new Error('GitHub did not return the pull request node ID.')
    const current = toDetail(raw, repo, access)
    const lifecycle = await updateGithubPullRequestLifecycle(
      client,
      repo,
      number,
      action,
      expectedHeadSha,
      { headSha: current.headSha, nodeId: raw.node_id, draft: current.draft },
    )
    return { ...current, ...lifecycle }
  }

  async createReview(repo: RepoRef, number: number, review: DraftReview): Promise<void> {
    const { rest } = await this.client()
    // One request = atomic from our side: either the whole batch posts or nothing does.
    try {
      type CreateReviewRequest = Parameters<typeof rest.pulls.createReview>[0]
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
      await rest.pulls.createReview(request)
    } catch (err) {
      throw new Error(githubApiErrorMessage(err, 'Could not submit the review'))
    }
  }

  async mergePullRequest(repo: RepoRef, number: number, method: MergeMethod): Promise<{ merged: boolean; message?: string }> {
    const { rest } = await this.client()
    try {
      const { data } = await rest.pulls.merge({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
        merge_method: method,
      })
      return { merged: data.merged, message: data.message }
    } catch (err) {
      // 405/409 = not mergeable (conflicts, protection, stale head). Return the
      // host message so the individual PR action can explain the refusal.
      return { merged: false, message: githubApiErrorMessage(err, 'GitHub could not merge the pull request') }
    }
  }

  async listPullRequestFileStats(repo: RepoRef, number: number): Promise<ChangedFileStat[]> {
    const { rest } = await this.client()
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
  }

  async replyToThread(_repo: RepoRef, threadId: string, body: string): Promise<ReviewComment> {
    const { graphql } = await this.client()
    // Reply by thread node id directly — the REST replies endpoint needs the first
    // comment's numeric id, which our signature doesn't carry. GraphQL is cleaner here.
    const res = await graphql<{ addPullRequestReviewThreadReply: { comment: GqlComment } }>(
      REPLY_MUTATION,
      { threadId, body },
    )
    return toComment(res.addPullRequestReviewThreadReply.comment)
  }

  async resolveThread(_repo: RepoRef, threadId: string): Promise<void> {
    const { graphql } = await this.client()
    await graphql(RESOLVE_MUTATION, { threadId })
  }

  async unresolveThread(_repo: RepoRef, threadId: string): Promise<void> {
    const { graphql } = await this.client()
    await graphql(UNRESOLVE_MUTATION, { threadId })
  }

  async listComments(repo: RepoRef, number: number): Promise<PrConversationItem[]> {
    const { graphql } = await this.client()
    const items: PrConversationItem[] = []
    let commentsCursor: string | null = null
    let reviewsCursor: string | null = null
    let includeComments = true
    let includeReviews = true

    // The two GraphQL connections paginate independently. Once one is complete,
    // @include keeps later pages of the other from refetching duplicate nodes.
    while (includeComments || includeReviews) {
      const res: PrConversationResponse = await graphql<PrConversationResponse>(PR_CONVERSATION_QUERY, {
        owner: repo.owner,
        repo: repo.repo,
        number,
        commentsCursor,
        reviewsCursor,
        includeComments,
        includeReviews,
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
    }

    return items.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }

  async addIssueComment(repo: RepoRef, number: number, body: string): Promise<void> {
    const { rest } = await this.client()
    await rest.issues.createComment({
      owner: repo.owner,
      repo: repo.repo,
      issue_number: number,
      body,
    })
  }

  async listChecks(repo: RepoRef, numbers: number[]): Promise<NumberedPrChecksSummary[]> {
    if (numbers.length === 0) return []
    const { graphql } = await this.client()
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
  }
}

export function makeGitHubProvider(): Provider {
  const auth = new GitHubAuth()
  return { id: 'github', auth, review: new GitHubProvider(auth) }
}
