import type { CheckConclusion, CheckItem, PrChecksSummary } from '@solus/contracts/checks-types'
import type { NumberedPrChecksSummary } from '@solus/contracts/checks-rpc-types'
import { HostBatches, pullRequestByNumber, type RepositoryRows } from './host-batches'

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
  checkSuite: {
    app: { name: string } | null
    workflowRun?: { event: string; runNumber: number; workflow: { id: string; name: string } } | null
  } | null
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

const PASSING_CONCLUSIONS = new Set<CheckConclusion>(['success', 'neutral', 'skipped'])

export function githubCheckRollupFields(number: string, workflow = false): string {
  return `        commits(last: 1) {
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
                      checkSuite { app { name } ${workflow ? 'workflowRun { event runNumber workflow { id name } }' : ''} }
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
        }`
}

function newestWorkflowRuns(raw: GqlCheckContext[]): Map<string, number> {
  const newestRun = new Map<string, number>()
  for (const node of raw) {
    if (node.__typename !== 'CheckRun') continue
    const run = node.checkSuite?.workflowRun
    if (!run || (run.event !== 'pull_request' && run.event !== 'pull_request_target')) continue
    const key = `${run.workflow.id} ${run.event}`
    for (const scope of [key, `${key} ${node.name.trim()}`]) {
      newestRun.set(scope, Math.max(run.runNumber, newestRun.get(scope) ?? -1))
    }
  }
  return newestRun
}

function agentCheck(node: GqlCheckContext, newestRun: Map<string, number>) {
  const check = normalizeContext(node)
  check.name = check.name.trim()
  if (!check.name) return null
  if (node.__typename === 'CheckRun' && !node.status.trim()) check.inFlight = false
  if (!check.inFlight && (check.conclusion === 'stale' || !check.conclusion)) check.conclusion = 'neutral'
  const run = node.__typename === 'CheckRun' ? node.checkSuite?.workflowRun : null
  if (run && check.conclusion === 'cancelled') {
    const lineage = `${run.workflow.id} ${run.event}`
    const scope = node.isRequired ? `${lineage} ${check.name}` : lineage
    if (run.runNumber < (newestRun.get(scope) ?? run.runNumber)) return null
  }
  return { check, workflow: run?.workflow.name.trim() ?? '', required: node.isRequired }
}

export function agentCheckRuns(pullRequest: GqlChecksPullRequest): Array<{ check: CheckItem; name: string; required: boolean }> {
  const raw = pullRequest.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []
  const newestRun = newestWorkflowRuns(raw)
  const selected = new Map<string, { check: CheckItem; workflow: string; required: boolean }>()
  for (const node of raw) {
    const entry = agentCheck(node, newestRun)
    if (!entry) continue
    const key = JSON.stringify([entry.workflow, entry.check.name])
    const held = selected.get(key)?.check
    if (!held || checkIsNewer(entry.check, held)) selected.set(key, entry)
  }
  const counts = new Map<string, number>()
  for (const { check } of selected.values()) counts.set(check.name, (counts.get(check.name) ?? 0) + 1)
  return [...selected.values()].map(({ check, workflow, required }) => ({
    check, required, name: workflow && (counts.get(check.name) ?? 0) > 1 ? `${workflow} / ${check.name}` : check.name,
  })).sort((a, b) => Number(failedAgentCheck(b.check)) - Number(failedAgentCheck(a.check)))
}

function checkTime(check: CheckItem): string {
  const unset = '0001-01-01T00:00:00Z'
  return [check.completedAt, check.startedAt].find(at => at && at !== unset) ?? ''
}

function checkIsNewer(candidate: CheckItem, held: CheckItem): boolean {
  if (candidate.inFlight || held.inFlight) return candidate.inFlight
  const a = checkTime(candidate)
  const b = checkTime(held)
  const delta = Date.parse(a) - Date.parse(b)
  if (Number.isNaN(delta)) return a >= b
  if (delta !== 0) return delta > 0
  const fraction = (time: string) => /\.(\d+)(?:Z|[+-]\d\d:\d\d)$/.exec(time)?.[1] ?? ''
  return fraction(a) >= fraction(b)
}

function failedAgentCheck(check: CheckItem): boolean {
  return check.conclusion === 'failure' || check.conclusion === 'cancelled' || check.conclusion === 'timed_out'
}

/** Check runs of pull requests, in documents shared by the repositories of
 *  one account (host-batches.ts). Each context says whether it is required. */
export const checkRows = new HostBatches<GqlChecksPullRequest>({
  operation: 'PrChecks',
  perDocument: 25,
  field: pullRequestByNumber((number) => `
        number
        headRefOid
${githubCheckRollupFields(String(number))}`),
})

export function normalizeChecksResponse(
  repository: RepositoryRows<GqlChecksPullRequest>,
  numbers: number[],
  warn: (message: string) => void = () => {},
): NumberedPrChecksSummary[] {
  return uniquePrNumbers(numbers).map((number) => {
    const pullRequest = repository[`p${number}`]
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
  const check: CheckItem = {
    id: context.context,
    name: context.context,
    conclusion: inFlight ? null : context.state === 'SUCCESS' ? 'success' : 'failure',
    inFlight,
    detailsUrl: context.targetUrl,
    appName: null,
    startedAt: context.createdAt,
    completedAt: inFlight ? null : context.createdAt,
  }
  if (context.description) check.description = context.description
  return check
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

export function uniquePrNumbers(numbers: number[]): number[] {
  const unique = [...new Set(numbers)]
  if (unique.some((number) => !Number.isSafeInteger(number) || number <= 0)) {
    throw new Error('PR numbers must be positive integers.')
  }
  return unique
}
