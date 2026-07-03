import { GitHubAuth } from './auth'
import { buildClient, type GitHubClient } from './octokit'
import type { MergeMethod } from '../../../shared/types'
import type {
  DraftReview,
  PrCommit,
  PrReviewer,
  Provider,
  PrFilter,
  PullRequestDetail,
  PullRequestOverview,
  PullRequestSummary,
  RepoRef,
  ReviewComment,
  ReviewProvider,
  ReviewThread,
} from '../types'

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
              nodes { id author { login } body createdAt diffHunk }
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
      comment { id author { login } body createdAt }
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

interface GqlComment {
  id: string
  author: { login: string } | null
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

interface GitHubApiErrorDetail {
  message?: unknown
  resource?: unknown
  field?: unknown
  code?: unknown
}

interface GitHubApiErrorBody {
  message?: unknown
  errors?: unknown
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function githubApiErrorMessage(err: unknown, fallback: string): string {
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : null
  const responseData = (err as { response?: { data?: unknown } })?.response?.data as GitHubApiErrorBody | undefined
  const bodyMessage = asString(responseData?.message)
  const details = Array.isArray(responseData?.errors)
    ? responseData.errors
        .map((detail: GitHubApiErrorDetail) => {
          const message = asString(detail.message)
          if (message) return message

          const field = asString(detail.field)
          const code = asString(detail.code)
          const resource = asString(detail.resource)
          return [resource, field, code].filter(Boolean).join(' ')
        })
        .filter(Boolean)
    : []

  const parts = [bodyMessage, ...details].filter(Boolean)
  if (parts.length > 0) return `${fallback}${status ? ` (${status})` : ''}: ${parts.join('; ')}`

  const message = err instanceof Error ? err.message : String(err)
  return message ? `${fallback}: ${message}` : fallback
}

/** Pagination sanity cap for the PR list — enough for any real review queue
 *  without letting a monorepo's backlog turn one load into dozens of pages. */
const MAX_LISTED_PRS = 500

// ─── Mappers (Octokit/GraphQL → host-neutral DTOs) ────────────────────────────

/** Shared shape of a PR across the REST list and get responses we read. */
interface RestPull {
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
}

function toSummary(pr: RestPull): PullRequestSummary {
  return {
    number: pr.number,
    title: pr.title,
    author: pr.user?.login ?? '',
    authorAvatarUrl: pr.user?.avatar_url ?? '',
    state: pr.merged_at ? 'merged' : (pr.state as 'open' | 'closed'),
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    draft: pr.draft ?? false,
    labels: (pr.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
  }
}

function toComment(c: GqlComment): ReviewComment {
  return {
    id: c.id,
    author: c.author?.login ?? '',
    body: c.body,
    createdAt: c.createdAt,
    ...(c.diffHunk ? { diffHunk: c.diffHunk } : {}),
  }
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
class GitHubProvider implements ReviewProvider {
  constructor(private readonly auth: GitHubAuth) {}

  /** Lazily build an authenticated client (REST + GraphQL). */
  protected client(): Promise<GitHubClient> {
    return buildClient(this.auth)
  }

  async listPullRequests(repo: RepoRef, filter?: PrFilter): Promise<PullRequestSummary[]> {
    const { rest } = await this.client()
    const data: unknown[] = []
    // Paginate (sorted by most recently updated) up to a sanity cap — one page
    // silently truncated busy repos at 100 PRs.
    for await (const page of rest.paginate.iterator(rest.pulls.list, {
      owner: repo.owner,
      repo: repo.repo,
      state: filter?.state ?? 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    })) {
      data.push(...page.data)
      if (data.length >= MAX_LISTED_PRS) break
    }
    let summaries = data.slice(0, MAX_LISTED_PRS).map((pr) => toSummary(pr as unknown as RestPull))
    // GitHub's list endpoint has no author filter (that's the search API); filter ourselves.
    if (filter?.author) {
      const author = filter.author.toLowerCase()
      summaries = summaries.filter((p) => p.author.toLowerCase() === author)
    }
    return summaries
  }

  async getPullRequestOverview(repo: RepoRef, number: number): Promise<PullRequestOverview> {
    const [detail, commits, reviewers] = await Promise.all([
      this.getPullRequest(repo, number),
      this.listCommits(repo, number),
      this.listReviewers(repo, number),
    ])
    return { detail, commits, reviewers }
  }

  async getPullRequest(repo: RepoRef, number: number): Promise<PullRequestDetail> {
    const { rest } = await this.client()
    const { data: pr } = await rest.pulls.get({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: number,
    })
    const baseFull = pr.base.repo?.full_name
    const headFull = pr.head.repo?.full_name
    return {
      ...toSummary(pr as unknown as RestPull),
      body: pr.body ?? '',
      baseRef: pr.base.ref,
      headRef: pr.head.ref,
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      changedFiles: (pr as any).changed_files ?? 0,
      mergeable: pr.mergeable ?? null,
      headRepo: {
        owner: pr.head.repo?.owner?.login ?? repo.owner,
        repo: pr.head.repo?.name ?? repo.repo,
        // The head branch lives in a fork when its repo differs from the base repo.
        isFork: !!headFull && !!baseFull && headFull !== baseFull,
      },
    }
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
      const state = r.state as PrReviewer['state']
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

  async createReview(repo: RepoRef, number: number, review: DraftReview): Promise<void> {
    const { rest } = await this.client()
    // One request = atomic from our side: either the whole batch posts or nothing does.
    try {
      await rest.pulls.createReview({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
        commit_id: review.commitId,
        body: review.body,
        event: review.event,
        comments: review.comments.map((c) => ({
          path: c.path,
          body: c.body,
          line: c.line,
          side: c.side,
          // start_side is required by the REST API whenever start_line is set.
          ...(c.startLine !== undefined ? { start_line: c.startLine, start_side: c.side } : {}),
        })),
      })
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
      // 405/409 = not mergeable (conflicts, protection, stale head) — the merge
      // queue treats this as "resolve locally", not as a failure.
      return { merged: false, message: githubApiErrorMessage(err, 'GitHub could not merge the pull request') }
    }
  }

  async listPullRequestFiles(repo: RepoRef, number: number): Promise<string[]> {
    const { rest } = await this.client()
    // One page of 100 is plenty for the ordering heuristic — overlap on the
    // first 100 files is representative even for giant PRs.
    const { data } = await rest.pulls.listFiles({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: number,
      per_page: 100,
    })
    return data.map((f) => f.filename)
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
}

export function makeGitHubProvider(): Provider {
  const auth = new GitHubAuth()
  return { id: 'github', auth, review: new GitHubProvider(auth) }
}
