import type { CheckConclusion, CheckItem, PrChecksSummary } from '@solus/contracts/checks-types'
import type { PullRequest } from '@solus/contracts/providers'
import type { PullRequestWatchState } from '../data/sessions/pull-request-watches'

/**
 * The rules of a pull request watch (docs/plans/pr-watch.md §5–6): what a
 * watch read found that the agent was not told yet, and the state to keep.
 * Pure: the watcher does every read and every write.
 */

/** A comment, a review with a body, or a review thread comment. */
export interface WatchRemark {
  id: string
  kind: 'comment' | 'review' | 'thread-comment'
  author: string
  body: string
  /** When it was written, or last edited when it was edited. */
  at: string
  url?: string
  /** The file a thread comment is on. */
  path?: string
}

/** One watch read. `remarks` is null when this read did not ask for them. */
export interface WatchRead {
  pullRequest: Pick<PullRequest, 'number' | 'url' | 'title' | 'state' | 'headSha' | 'mergeable'>
  checks: PrChecksSummary
  remarks: WatchRemark[] | null
  /** The login whose credential read the pull request: the agent's own
   *  account. Its remarks are not news. */
  viewer: string
}

export type WatchNews =
  | { kind: 'checks-failed'; checks: CheckItem[] }
  | { kind: 'checks-passed'; checks: string[] }
  | { kind: 'remarks'; remarks: WatchRemark[] }
  | { kind: 'conflicting' }
  | { kind: 'closed' }

/** Why a watch ends. The watcher adds the reasons that are not the rules'. */
export type WatchEndReason =
  | 'merged'
  | 'closed'
  | 'remark-limit'
  | 'unreadable'
  | 'settled'
  | 'stopped'
  | 'unwatched'
  | 'unlinked'

export interface WatchEvaluation {
  next: PullRequestWatchState
  news: WatchNews[]
  end: 'merged' | 'closed' | 'remark-limit' | null
}

/** Wakes in a row with only remarks before the watch ends: two bots that
 *  answer each other would otherwise keep the agent busy forever. */
export const REMARK_ONLY_WAKE_LIMIT = 10

const FAILED_CONCLUSIONS = new Set<CheckConclusion>(['failure', 'cancelled', 'timed_out', 'action_required'])
const PASSING_CONCLUSIONS = new Set<CheckConclusion>(['success', 'neutral', 'skipped'])

export function initialWatchState(startedAt: number): PullRequestWatchState {
  return {
    headSha: null,
    failedChecks: [],
    passReported: false,
    passedChecks: [],
    remarksThrough: new Date(startedAt).toISOString(),
    remarkIdsAtWatermark: [],
    conflicting: false,
    remarkOnlyWakes: 0,
  }
}

export function evaluateWatch(state: PullRequestWatchState, read: WatchRead): WatchEvaluation {
  const { pullRequest } = read
  if (pullRequest.state === 'merged') return { next: state, news: [], end: 'merged' }
  if (pullRequest.state === 'closed') return { next: state, news: [{ kind: 'closed' }], end: 'closed' }

  // A new head is new work: what was said about the old head's checks is void.
  const next: PullRequestWatchState = pullRequest.headSha === state.headSha
    ? { ...state }
    : { ...state, headSha: pullRequest.headSha, failedChecks: [], passReported: false, passedChecks: [] }
  const news: WatchNews[] = []

  const checks = [...read.checks.required, ...read.checks.optional]
  const failed = checks.filter(isFailed)
  const newlyFailed = failed.filter((check) => !next.failedChecks.includes(check.id))
  next.failedChecks = failed.map((check) => check.id)
  if (newlyFailed.length) news.push({ kind: 'checks-failed', checks: newlyFailed })

  const gate = read.checks.required.length ? read.checks.required : checks
  const gatePassed = gate.length > 0 && gate.every(isPassing)
  if (gatePassed) {
    const names = gate.map((check) => check.name)
    // Only a required check can grow the gate: advisory bots that add passed
    // checks would otherwise wake the agent for nothing.
    const grew = read.checks.required.length > 0 && names.some((name) => !next.passedChecks.includes(name))
    if (!next.passReported || grew) news.push({ kind: 'checks-passed', checks: names })
    next.passReported = true
    next.passedChecks = names
  }

  // Unknown mergeability keeps the last answer.
  if (pullRequest.mergeable !== null) {
    const conflicting = !pullRequest.mergeable
    if (conflicting && !next.conflicting) news.push({ kind: 'conflicting' })
    next.conflicting = conflicting
  }

  if (read.remarks) {
    const fresh = read.remarks
      .filter((remark) => remark.author !== read.viewer && isAfterWatermark(remark, state))
      .sort((a, b) => a.at.localeCompare(b.at))
    if (fresh.length) {
      const newest = fresh[fresh.length - 1].at
      const tied = newest === state.remarksThrough ? state.remarkIdsAtWatermark : []
      next.remarksThrough = newest
      next.remarkIdsAtWatermark = [...tied, ...fresh.filter((remark) => remark.at === newest).map(({ id }) => id)]
      news.push({ kind: 'remarks', remarks: fresh })
    }
  }

  if (!news.length) return { next, news, end: null }
  next.remarkOnlyWakes = news.every((item) => item.kind === 'remarks') ? state.remarkOnlyWakes + 1 : 0
  return { next, news, end: next.remarkOnlyWakes >= REMARK_ONLY_WAKE_LIMIT ? 'remark-limit' : null }
}

function isFailed(check: CheckItem): boolean {
  return !check.inFlight && check.conclusion !== null && FAILED_CONCLUSIONS.has(check.conclusion)
}

function isPassing(check: CheckItem): boolean {
  return !check.inFlight && check.conclusion !== null && PASSING_CONCLUSIONS.has(check.conclusion)
}

function isAfterWatermark(remark: WatchRemark, state: PullRequestWatchState): boolean {
  if (remark.at > state.remarksThrough) return true
  return remark.at === state.remarksThrough && !state.remarkIdsAtWatermark.includes(remark.id)
}

/** Items of one kind a wake lists before "and N more". */
const LIST_LIMIT = 10
const EXCERPT_LENGTH = 200

/** The prompt that wakes the agent. `end` says why the watch stops, when it does. */
export function wakeText(
  pullRequest: Pick<PullRequest, 'number' | 'url' | 'headSha'>,
  news: WatchNews[],
  end: 'closed' | 'remark-limit' | 'unreadable' | null,
): string {
  const label = `pull request #${pullRequest.number} (${pullRequest.url})`
  if (end === 'unreadable') {
    return `Solus stopped watching ${label} because it could not read it from the code host several times in a row. Check it yourself, and call watch_pull_request to watch it again.`
  }
  const lines = [`Update on ${label}, which Solus is watching for you (head ${pullRequest.headSha.slice(0, 7)}):`, '']
  for (const item of news) lines.push(...newsLines(item))
  lines.push('')
  if (end === 'closed') {
    lines.push('The pull request was closed, so Solus stopped watching it. If it is reopened, call watch_pull_request to watch it again.')
  } else if (end === 'remark-limit') {
    lines.push(`Solus stopped watching after ${REMARK_ONLY_WAKE_LIMIT} updates in a row that were only comments. Act on these, then call watch_pull_request to watch it again if you still need to.`)
  } else {
    lines.push('Look into each item and act on it. Then end your turn: Solus wakes you again when something changes. Before you hand the work back, call watch_pull_request with watching=false.')
  }
  return lines.join('\n')
}

function newsLines(item: WatchNews): string[] {
  switch (item.kind) {
    case 'checks-failed':
      return [`- Checks failed:`, ...limited(item.checks.map((check) =>
        `  - ${check.name}${check.appName ? ` (${check.appName})` : ''}: ${check.conclusion}${check.detailsUrl ? ` — ${check.detailsUrl}` : ''}`))]
    case 'checks-passed':
      return [`- Every check that gates the merge passed: ${item.checks.slice(0, LIST_LIMIT).join(', ')}${item.checks.length > LIST_LIMIT ? `, and ${item.checks.length - LIST_LIMIT} more` : ''}.`]
    case 'conflicting':
      return ['- The branch now conflicts with its base.']
    case 'closed':
      return ['- The pull request was closed without merging.']
    case 'remarks':
      return [`- New comments and reviews:`, ...limited(item.remarks.map((remark) => {
        const where = remark.path ? ` on ${remark.path}` : ''
        const link = remark.url ? ` — ${remark.url}` : ''
        return `  - ${remark.author}${where}: ${excerpt(remark.body)}${link}`
      }))]
  }
}

function limited(lines: string[]): string[] {
  return lines.length <= LIST_LIMIT ? lines : [...lines.slice(0, LIST_LIMIT), `  - and ${lines.length - LIST_LIMIT} more`]
}

function excerpt(body: string): string {
  const text = body.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim()
  return text.length <= EXCERPT_LENGTH ? `"${text}"` : `"${text.slice(0, EXCERPT_LENGTH - 1)}…"`
}
