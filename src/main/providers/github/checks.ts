import type { CheckConclusion, CheckItem, PrChecksSummary } from '../../../shared/checks-types'
import type { NumberedPrChecksSummary } from '../../../shared/checks-rpc-types'

interface GqlCheckRun {
  __typename: 'CheckRun'
  databaseId: number
  name: string
  status: string
  conclusion: string | null
  detailsUrl: string | null
  startedAt: string | null
  completedAt: string | null
  isRequired: boolean
  checkSuite: { app: { name: string } | null } | null
}

interface GqlStatusContext {
  __typename: 'StatusContext'
  context: string
  state: string
  targetUrl: string | null
  description: string | null
  createdAt: string | null
  isRequired: boolean
}

type GqlCheckContext = GqlCheckRun | GqlStatusContext

export interface GqlChecksPullRequest {
  number: number
  headRefOid: string
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          state: string
          contexts: { totalCount: number; nodes: GqlCheckContext[] }
        } | null
      }
    }>
  }
}

export interface GqlChecksResponse {
  repository: Record<string, GqlChecksPullRequest | null>
}

const PASSING_CONCLUSIONS = new Set<CheckConclusion>(['success', 'neutral', 'skipped'])

export function buildChecksQuery(numbers: number[]): string {
  const selections = uniquePrNumbers(numbers).map((number) => `
    p${number}: pullRequest(number: ${number}) {
      number
      headRefOid
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 100) {
                totalCount
                nodes {
                  __typename
                  ... on CheckRun {
                    databaseId name status conclusion detailsUrl startedAt completedAt
                    isRequired(pullRequestNumber: ${number})
                    checkSuite { app { name } }
                  }
                  ... on StatusContext {
                    context state targetUrl description createdAt
                    isRequired(pullRequestNumber: ${number})
                  }
                }
              }
            }
          }
        }
      }
    }`).join('\n')

  return `query PrChecks($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {${selections}
    }
  }`
}

export function normalizeChecksResponse(
  response: GqlChecksResponse,
  numbers: number[],
  warn: (message: string) => void = () => {},
): NumberedPrChecksSummary[] {
  return uniquePrNumbers(numbers).map((number) => {
    const pullRequest = response.repository[`p${number}`]
    if (!pullRequest) throw new Error(`GitHub did not return PR #${number} while loading checks.`)
    return { number, summary: normalizePullRequestChecks(pullRequest, warn) }
  })
}

export function normalizePullRequestChecks(
  pullRequest: GqlChecksPullRequest,
  warn: (message: string) => void = () => {},
): PrChecksSummary {
  const rollup = pullRequest.commits.nodes[0]?.commit.statusCheckRollup ?? null
  if (!rollup) {
    return {
      state: 'none',
      required: [],
      optional: [],
      headSha: pullRequest.headRefOid,
      inFlight: false,
    }
  }

  if (rollup.contexts.totalCount > 100) {
    warn(`PR #${pullRequest.number} has ${rollup.contexts.totalCount} check contexts; only the first 100 are shown.`)
  }

  const required: CheckItem[] = []
  const optional: CheckItem[] = []
  for (const context of rollup.contexts.nodes) {
    const item = normalizeContext(context)
    ;(context.isRequired ? required : optional).push(item)
  }

  const inFlight = required.some((item) => item.inFlight)
  const failing = required.some((item) =>
    !item.inFlight && (!item.conclusion || !PASSING_CONCLUSIONS.has(item.conclusion)),
  )
  return {
    state: inFlight ? 'pending' : failing ? 'failing' : 'passing',
    required,
    optional,
    headSha: pullRequest.headRefOid,
    inFlight,
  }
}

function normalizeContext(context: GqlCheckContext): CheckItem {
  if (context.__typename === 'CheckRun') {
    const inFlight = context.status !== 'COMPLETED'
    return {
      id: String(context.databaseId),
      name: context.name,
      conclusion: inFlight ? null : normalizeCheckRunConclusion(context.conclusion),
      inFlight,
      detailsUrl: context.detailsUrl,
      appName: context.checkSuite?.app?.name ?? null,
      startedAt: context.startedAt,
      completedAt: context.completedAt,
    }
  }

  const inFlight = context.state === 'EXPECTED' || context.state === 'PENDING'
  return {
    id: context.context,
    name: context.context,
    conclusion: inFlight ? null : context.state === 'SUCCESS' ? 'success' : 'failure',
    inFlight,
    detailsUrl: context.targetUrl,
    appName: null,
    startedAt: context.createdAt,
    completedAt: inFlight ? null : context.createdAt,
  }
}

function normalizeCheckRunConclusion(conclusion: string | null): CheckConclusion | null {
  if (!conclusion) return null
  switch (conclusion) {
    case 'SUCCESS': return 'success'
    case 'FAILURE': return 'failure'
    case 'NEUTRAL': return 'neutral'
    case 'CANCELLED': return 'cancelled'
    case 'TIMED_OUT': return 'timed_out'
    case 'ACTION_REQUIRED': return 'action_required'
    case 'SKIPPED': return 'skipped'
    case 'STALE': return 'stale'
    default: return 'failure'
  }
}

function uniquePrNumbers(numbers: number[]): number[] {
  const unique = [...new Set(numbers)]
  if (unique.some((number) => !Number.isSafeInteger(number) || number <= 0)) {
    throw new Error('PR numbers must be positive integers.')
  }
  return unique
}
