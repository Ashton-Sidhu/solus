import type { CheckConclusion, CheckItem, PrChecksSummary } from '@solus/contracts/checks-types'
import type { NumberedPrChecksSummary } from '@solus/contracts/checks-rpc-types'
import { z } from 'zod'

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

const cliCheckRunSchema = z.object({
  __typename: z.literal('CheckRun'),
  databaseId: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  detailsUrl: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  isRequired: z.boolean(),
  checkSuite: z.object({ app: z.object({ name: z.string() }).nullable() }).nullable(),
})

const cliStatusContextSchema = z.object({
  __typename: z.literal('StatusContext'),
  context: z.string(),
  state: z.string(),
  targetUrl: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: z.string().nullable(),
  isRequired: z.boolean(),
})

const cliChecksPullRequestSchema = z.object({
  number: z.number(),
  headRefOid: z.string(),
  commits: z.object({
    nodes: z.array(z.object({
      commit: z.object({
        statusCheckRollup: z.object({
          state: z.string(),
          contexts: z.object({
            totalCount: z.number(),
            nodes: z.array(z.discriminatedUnion('__typename', [cliCheckRunSchema, cliStatusContextSchema])),
          }),
        }).nullable(),
      }),
    })),
  }),
})

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

/** Normalize the array selected by `gh api graphql --jq`. The CLI still asks
 * GitHub for the same status-check rollup as the adapter, so required checks
 * and legacy status contexts keep the same meaning on both credential paths. */
export function normalizeCliChecksResponse(
  raw: string,
  numbers: number[],
  warn: (message: string) => void = () => {},
): NumberedPrChecksSummary[] {
  const pullRequests = z.array(cliChecksPullRequestSchema.nullable()).parse(JSON.parse(raw))
  const byNumber = new Map(
    pullRequests.flatMap((pullRequest) => pullRequest ? [[pullRequest.number, pullRequest] as const] : []),
  )
  return uniquePrNumbers(numbers).map((number) => {
    const pullRequest = byNumber.get(number)
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
