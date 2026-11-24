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

/**
 * Run an issue read with the Projects v2 values, and again without them when
 * the connection lacks the `read:project` scope. A repository and an issue do
 * not need that scope; only their board values do. The issue then reads as off
 * every board, so it takes no priority or due date write.
 */
async function withoutProjectScope<Result>(read: (queries: IssueQueries) => Promise<Result>): Promise<Result> {
  try {
    return await read(ISSUE_QUERIES)
  } catch (error) {
    if (!isInsufficientScopes(error)) throw error
    return read(PLAIN_ISSUE_QUERIES)
  }
}

const previewErrors = z.object({
  errors: z.array(z.object({ message: z.string(), path: z.array(z.union([z.string(), z.number()])).optional() })),
})

/** These documents run only through the github.com task adapters. Some accounts
 * still get field errors during the preview, even on github.com. */
export async function withPlanningStatus<Result>(read: (preview: boolean) => Promise<Result>): Promise<Result> {
  try {
    return await read(true)
  } catch (error) {
    const parsed = previewErrors.safeParse(error)
    const fieldMessage = /\b(planningStatuses|viewerCanSetStatus)\b|['"]status['"]/
    if (!parsed.success || !parsed.data.errors.some(({ message, path }) =>
      fieldMessage.test(message) || path?.some((part) => part === 'status' || part === 'planningStatuses' || part === 'viewerCanSetStatus'),
    )) throw error
    return read(false)
  }
}

export function readGithubIssues<Result>(read: (queries: IssueQueries) => Promise<Result>): Promise<Result> {
  return withPlanningStatus((preview) => withoutProjectScope((queries) => read(preview
    ? queries === ISSUE_QUERIES ? ISSUE_STATUS_QUERIES : PLAIN_ISSUE_STATUS_QUERIES
    : queries)))
}

export async function searchGithubIssues(graphql: GraphQLClient, query: string): Promise<ProviderTask[] | null> {
  return withPlanningStatus(async (preview) => {
    if (!preview) return null
    const { search } = await graphql<{ search: { nodes: Array<IssueNode | null> } }>(SEARCH_ISSUES_WITH_STATUS, {
      query: `${query} sort:updated-desc`,
    })
    return search.nodes.flatMap((node) => node?.id ? [issueToTask(node)] : [])
  })
}

export async function readRepositoryPlanningStatuses(graphql: GraphQLClient, repository: { owner: string; repo: string }): Promise<PlanningStatus[]> {
  return withPlanningStatus(async (preview) => {
    if (!preview) return []
    const { repository: options } = await graphql<{ repository: PlanningStatuses | null }>(`
      query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) { ${PLANNING_STATUSES_FIELDS} }
      }
    `, repository)
    return options ? planningStatusesOf(options) : []
  })
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
