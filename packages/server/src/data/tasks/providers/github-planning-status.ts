import { z } from 'zod'
import type { GitHubClient, GraphQLClient } from '../../../providers/github/octokit'
import { isInsufficientScopes } from './failures'
import {
  ISSUE_QUERIES,
  ISSUE_STATUS_QUERIES,
  PLAIN_ISSUE_QUERIES,
  PLAIN_ISSUE_STATUS_QUERIES,
  PLANNING_STATUSES_FIELDS,
  SEARCH_ISSUES_WITH_STATUS,
  issueToTask,
  planningStatusesOf,
  type IssueNode,
  type IssueQueries,
  type PlanningStatus,
  type PlanningStatuses,
} from './github-model'
import type { ProviderTask } from './types'

/** What GitHub refused for one connection. A client is kept for each credential
 *  (`clientFor`), so its `graphql` function names the connection, and a refused
 *  variant is not asked for again on every read. */
interface Refusals { projectScope?: true; previewUntil?: number }
const refusals = new WeakMap<GraphQLClient, Refusals>()
/** GitHub turns preview fields on for an account over time, so a refusal is tried again after this. */
const PREVIEW_RETRY_MS = 60 * 60_000

function refusalsOf(graphql: GraphQLClient): Refusals {
  let held = refusals.get(graphql)
  if (!held) refusals.set(graphql, held = {})
  return held
}

/**
 * Run an issue read with the Projects v2 values, and without them when the
 * connection lacks the `read:project` scope. A repository and an issue do not
 * need that scope; only their board values do. The issue then reads as off
 * every board, so it takes no priority or due date write. The scope belongs to
 * the token, so a refusal holds for as long as its client.
 */
async function withoutProjectScope<Result>(graphql: GraphQLClient, read: (queries: IssueQueries) => Promise<Result>): Promise<Result> {
  const held = refusalsOf(graphql)
  if (held.projectScope) return read(PLAIN_ISSUE_QUERIES)
  try {
    return await read(ISSUE_QUERIES)
  } catch (error) {
    if (!isInsufficientScopes(error)) throw error
    held.projectScope = true
    return read(PLAIN_ISSUE_QUERIES)
  }
}

const previewErrors = z.object({
  errors: z.array(z.object({ message: z.string(), path: z.array(z.union([z.string(), z.number()])).optional() })),
})

/** These documents run only through the github.com task adapters. Some accounts
 * still get field errors during the preview, even on github.com. */
export async function withPlanningStatus<Result>(graphql: GraphQLClient, read: (preview: boolean) => Promise<Result>): Promise<Result> {
  const held = refusalsOf(graphql)
  if (held.previewUntil && held.previewUntil > Date.now()) return read(false)
  try {
    return await read(true)
  } catch (error) {
    const parsed = previewErrors.safeParse(error)
    const fieldMessage = /\b(planningStatuses|viewerCanSetStatus)\b|['"]status['"]/
    if (!parsed.success || !parsed.data.errors.some(({ message, path }) =>
      fieldMessage.test(message) || path?.some((part) => part === 'status' || part === 'planningStatuses' || part === 'viewerCanSetStatus'),
    )) throw error
    held.previewUntil = Date.now() + PREVIEW_RETRY_MS
    return read(false)
  }
}

export function readGithubIssues<Result>(graphql: GraphQLClient, read: (queries: IssueQueries) => Promise<Result>): Promise<Result> {
  return withPlanningStatus(graphql, (preview) => withoutProjectScope(graphql, (queries) => read(preview
    ? queries === ISSUE_QUERIES ? ISSUE_STATUS_QUERIES : PLAIN_ISSUE_STATUS_QUERIES
    : queries)))
}

export async function searchGithubIssues(graphql: GraphQLClient, query: string): Promise<ProviderTask[] | null> {
  return withPlanningStatus(graphql, async (preview) => {
    if (!preview) return null
    const { search } = await graphql<{ search: { nodes: Array<IssueNode | null> } }>(SEARCH_ISSUES_WITH_STATUS, {
      query: `${query} sort:updated-desc`,
    })
    return search.nodes.flatMap((node) => node?.id ? [issueToTask(node)] : [])
  })
}

/** The planning statuses of each repository, as the last read of one connection gave them. */
const heldStatuses = new WeakMap<GraphQLClient, Map<string, { statuses: PlanningStatus[]; readAt: number }>>()
/** A repository's statuses change rarely, so a write uses a copy this recent and reads nothing. */
const STATUSES_KEEP_MS = 10 * 60_000

/** Keep the planning statuses that a list or detail read gave, for the next write. */
export function rememberPlanningStatuses(graphql: GraphQLClient, repository: { owner: string; repo: string }, statuses: PlanningStatus[]): void {
  let held = heldStatuses.get(graphql)
  if (!held) heldStatuses.set(graphql, held = new Map())
  held.set(`${repository.owner}/${repository.repo}`.toLowerCase(), { statuses, readAt: Date.now() })
}

/** The planning statuses of a repository: the copy a recent read kept, else one query. */
export async function readRepositoryPlanningStatuses(graphql: GraphQLClient, repository: { owner: string; repo: string }): Promise<PlanningStatus[]> {
  const held = heldStatuses.get(graphql)?.get(`${repository.owner}/${repository.repo}`.toLowerCase())
  if (held && Date.now() - held.readAt < STATUSES_KEEP_MS) return held.statuses
  const statuses = await withPlanningStatus(graphql, async (preview) => {
    if (!preview) return []
    const { repository: options } = await graphql<{ repository: PlanningStatuses | null }>(`
      query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) { ${PLANNING_STATUSES_FIELDS} }
      }
    `, { owner: repository.owner, repo: repository.repo })
    return options ? planningStatusesOf(options) : []
  })
  rememberPlanningStatuses(graphql, repository, statuses)
  return statuses
}

export async function writePlanningStatus(
  { graphql, rest }: GitHubClient,
  home: { owner: string; repo: string; number: number },
  issueId: string,
  status: PlanningStatus,
): Promise<void> {
  if (status.category.key === 'duplicate' || status.category.stateReason === 'DUPLICATE') {
    // The GraphQL mutation requires the original issue for a duplicate.
    await rest.issues.update({ owner: home.owner, repo: home.repo, issue_number: home.number, state: 'closed', state_reason: 'duplicate' })
    return
  }
  await graphql(`mutation SetIssueStatus($issueId: ID!, $statusId: ID!) {
    setIssueStatus(input: { issueId: $issueId, statusId: $statusId }) { clientMutationId }
  }`, { issueId, statusId: status.id })
}
