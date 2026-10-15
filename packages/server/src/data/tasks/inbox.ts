import type {
  InboxInvolvement,
  InboxPullRequest,
  InboxScopeProject,
  InboxUpstreamResult,
  InboxUpstreamScope,
} from '@solus/contracts/inbox-types'
import type { PrFilter, PrListPage, PullRequest, RepoRef } from '@solus/contracts/providers'
import type { RecordScope } from '../../admission/principal'
import { listProjects } from '../../project-config/projects-manifest'
import { providerForRepo } from '../../providers/registry'
import { prIndex } from '../../prs/pr-index'
import { resolveTaskPublishTarget } from './adapters/registry'
import { listUpstreamTasks } from './upstream'

interface BoundScope {
  provider: InboxUpstreamScope['provider']
  externalKey: string
  projects: InboxScopeProject[]
}

interface PullRequestSnapshot {
  rows: InboxPullRequest[]
  fetchedAt: number
}

const pullRequestSnapshots = new Map<string, PullRequestSnapshot>()

function messageOf(error: Parameters<typeof String>[0]): string {
  return error instanceof Error ? error.message : String(error)
}

async function boundScopes(): Promise<BoundScope[]> {
  const scopes = new Map<string, BoundScope>()
  for (const project of await listProjects()) {
    let target: Awaited<ReturnType<typeof resolveTaskPublishTarget>>
    try {
      target = await resolveTaskPublishTarget(project.path)
    } catch {
      // A stale or incomplete binding cannot name an upstream scope honestly.
      continue
    }
    if (!target) continue
    const key = `${target.adapter.id}\0${target.ref.externalKey}`
    const existing = scopes.get(key)
    const projectRef = { projectKey: project.path, projectLabel: project.folderName }
    if (existing) existing.projects.push(projectRef)
    else {
      scopes.set(key, {
        provider: target.adapter.id,
        externalKey: target.ref.externalKey,
        projects: [projectRef],
      })
    }
  }
  return [...scopes.values()]
}

/** The search qualifier each involvement narrows the open pull requests by.
 *  `user-review-requested` names the viewer alone, not a team they are in. */
function involvementQuery(involvement: Exclude<InboxInvolvement, 'mentioned'>, viewer: string): string {
  if (involvement === 'authored') return `author:${viewer}`
  if (involvement === 'assigned') return `assignee:${viewer}`
  if (involvement === 'review_requested') return `user-review-requested:${viewer}`
  return ''
}

async function listPullRequests(
  scope: BoundScope,
  involvement: InboxInvolvement,
): Promise<InboxPullRequest[]> {
  if (scope.provider !== 'github') return []
  if (involvement === 'mentioned') {
    throw new Error('GitHub pull requests do not expose a precise mentioned filter in the review provider.')
  }
  const [owner, repo, ...extra] = scope.externalKey.split('/')
  if (!owner || !repo || extra.length) throw new Error(`Invalid GitHub scope: ${scope.externalKey}`)
  const repoRef: RepoRef = { host: 'github.com', owner, repo }
  const provider = providerForRepo(repoRef)
  if (!provider) throw new Error('No pull request provider is available for this scope.')
  const viewer = await provider.review.getViewer(repoRef)
  // The code host's search narrows the rows, so only the matches are paged.
  const filter: PrFilter = { state: 'open', query: involvementQuery(involvement, viewer) }
  const rows: PullRequest[] = []
  let cursor: string | null = null
  for (let page = 1; ; page++) {
    const found: PrListPage = await prIndex.list(repoRef, provider, viewer, filter, page, cursor)
    const known = new Set(rows.map((row) => row.number))
    rows.push(...found.items.filter((row) => !known.has(row.number)))
    if (!found.hasMore || !found.cursor) break
    cursor = found.cursor
  }
  return rows.map((row) => ({ ...row, provider: 'github', externalKey: scope.externalKey }))
}

async function readScope(
  recordScope: RecordScope,
  scope: BoundScope,
  involvement: InboxInvolvement,
): Promise<InboxUpstreamScope> {
  const projectKey = scope.projects[0]?.projectKey
  if (!projectKey) return { ...scope, tickets: [], pullRequests: [] }
  const pullRequestCacheKey = `${scope.externalKey}\0${involvement}`
  const [ticketResult, pullRequestResult] = await Promise.allSettled([
    listUpstreamTasks(recordScope, projectKey, { involvement }),
    listPullRequests(scope, involvement),
  ])
  const result: InboxUpstreamScope = {
    ...scope,
    tickets: ticketResult.status === 'fulfilled' ? ticketResult.value.tasks : [],
    pullRequests: pullRequestResult.status === 'fulfilled'
      ? pullRequestResult.value
      : pullRequestSnapshots.get(pullRequestCacheKey)?.rows ?? [],
  }
  if (ticketResult.status === 'fulfilled') {
    result.fetchedAt = ticketResult.value.fetchedAt
    result.fromCache = ticketResult.value.fromCache
    result.truncated = ticketResult.value.truncated
  } else result.ticketError = messageOf(ticketResult.reason)
  if (pullRequestResult.status === 'rejected') {
    result.pullRequestError = messageOf(pullRequestResult.reason)
    const cached = pullRequestSnapshots.get(pullRequestCacheKey)
    if (cached) {
      result.fromCache = true
      result.fetchedAt = result.fetchedAt
        ? Math.min(result.fetchedAt, cached.fetchedAt)
        : cached.fetchedAt
    }
  } else {
    const fetchedAt = Date.now()
    pullRequestSnapshots.set(pullRequestCacheKey, { rows: pullRequestResult.value, fetchedAt })
    result.fetchedAt = Math.max(result.fetchedAt ?? 0, fetchedAt)
  }
  return result
}

/** One host-side fan-out for every distinct bound task scope on this host. */
export async function listInboxUpstream(
  recordScope: RecordScope,
  involvement: InboxInvolvement,
): Promise<InboxUpstreamResult> {
  const scopes = await boundScopes()
  return { scopes: await Promise.all(scopes.map((scope) => readScope(recordScope, scope, involvement))) }
}
