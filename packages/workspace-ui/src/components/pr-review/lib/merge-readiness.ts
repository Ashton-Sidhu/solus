import type { PrChecksSummary } from '@solus/contracts/checks-types'
import type { PullRequest } from '@solus/contracts/providers'
import type { MergeMethod } from '@solus/contracts/types'
import { MERGE_METHOD_OPTIONS, defaultMergeMethod } from './merge-method'

/**
 * One reading of whether a pull request can land, shared by the pull request
 * page's status card and the project rail's pull request row. Both surfaces
 * say the same three things from it: the state, what stands in the way, and
 * the one move that changes it. They cannot disagree because there is one
 * table, walked in one order.
 *
 * The order is the order of blockers a reader must clear: a conflict first,
 * because nothing else can be judged until the branch merges cleanly; then the
 * checks, then an out-of-date head; then the states that only ask for patience.
 */
export type MergeReadinessKey =
  | 'merged'
  | 'closed'
  | 'draft'
  | 'ready'
  | 'checks'
  | 'conflicts'
  | 'behind'
  | 'open'

/**
 * The move that changes the state. Host actions run against the code host on
 * one click; agent actions open a new session for the head branch — a draft
 * composer with the prompt filled in, or the conflict resolver's own session.
 */
export type MergeAction =
  | { kind: 'merge'; label: string; method: MergeMethod }
  | { kind: 'mark-ready'; label: string }
  | { kind: 'resolve-conflicts'; label: string }
  | { kind: 'fix-checks'; label: string }
  | { kind: 'update-branch'; label: string }

export interface MergeReadiness {
  key: MergeReadinessKey
  headline: string
  /** The quieter second line. Empty when there is nothing worth stating. */
  note: string
  blocked: boolean
  /** Null when the next step is someone else's — a reviewer, the host, CI. */
  action: MergeAction | null
}

export interface MergeReadinessInput {
  detail: PullRequest
  checks: PrChecksSummary | undefined
  /** The checks could not be read at all. Not the same as "no checks". */
  checksLoadFailed?: boolean
  /** Undefined when the surface has not read the threads — the project rail
   *  reads only what the host's detail says. */
  unresolvedCount?: number
  approvedReviewCount?: number
  openedTime?: string | null
}

interface Blocker {
  key: MergeReadinessKey
  headline: string
  note: string
  blocked: boolean
  action: MergeAction | null
}

function hostCanMerge(detail: PullRequest): boolean {
  return (
    detail.mergeable === true &&
    (detail.mergeStateStatus === 'clean' || detail.mergeStateStatus === 'has_hooks')
  )
}

function mergeStatusPending(detail: PullRequest): boolean {
  return detail.mergeStateStatus === null || detail.mergeStateStatus === 'unknown'
}

function viewerMayMerge(detail: PullRequest): boolean {
  return (
    detail.capabilities.actions.includes('merge') &&
    detail.viewerPermissions.actions.includes('merge') &&
    detail.capabilities.mergeMethods.length > 0
  )
}

/**
 * Whether an agent session for this branch is worth opening: the head lives in
 * the base repository, and the viewer may push there or wrote the pull request.
 * The host grants `ready` to exactly those two groups, so it stands in for
 * "may update the head" without a second permission read.
 */
function viewerMayUpdateHead(detail: PullRequest): boolean {
  return !detail.headRepo.isFork && detail.viewerPermissions.actions.includes('ready')
}

function mergeAction(detail: PullRequest): MergeAction | null {
  if (!viewerMayMerge(detail)) return null
  const method = defaultMergeMethod(detail.capabilities.mergeMethods)
  const label =
    MERGE_METHOD_OPTIONS.find((option) => option.value === method)?.action ?? 'Merge pull request'
  return { kind: 'merge', label, method }
}

function agentAction(
  detail: PullRequest,
  action: Exclude<MergeAction, { kind: 'merge' | 'mark-ready' }>,
): MergeAction | null {
  return viewerMayUpdateHead(detail) ? action : null
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function waiting(headline: string, note: string): Blocker {
  return { key: 'open', headline, note, blocked: false, action: null }
}

/** The branch's own state: a conflict, red checks, or a head behind its base. */
function branchBlockers(
  detail: PullRequest,
  checksState: PrChecksSummary['state'] | undefined,
): Blocker[] {
  const base = detail.baseRef ?? 'main'
  const blockers: Blocker[] = []
  if (detail.mergeStateStatus === 'dirty' || detail.mergeable === false) {
    blockers.push({
      key: 'conflicts',
      headline: `Conflicts with ${base}`,
      note: `Rebase onto ${base} to continue`,
      blocked: true,
      action: agentAction(detail, { kind: 'resolve-conflicts', label: 'Resolve conflicts with agent' }),
    })
  }
  if (checksState === 'failing' || detail.mergeStateStatus === 'unstable') {
    blockers.push({
      key: 'checks',
      headline: 'Checks need attention',
      note: 'Fix failing checks to continue',
      blocked: true,
      action: agentAction(detail, { kind: 'fix-checks', label: 'Fix failing checks with agent' }),
    })
  }
  if (detail.mergeStateStatus === 'behind') {
    blockers.push({
      key: 'behind',
      headline: 'Branch is out of date',
      note: `Update this branch with ${base}`,
      blocked: true,
      action: agentAction(detail, { kind: 'update-branch', label: 'Update branch with agent' }),
    })
  }
  return blockers
}

/** The states that only ask for patience: CI, reviewers, the host itself. */
function waitingBlockers(
  { detail, checks, checksLoadFailed = false, unresolvedCount, approvedReviewCount = 0 }: MergeReadinessInput,
  checksCurrent: boolean,
): Blocker[] {
  const blockers: Blocker[] = []
  if (checksLoadFailed) {
    blockers.push(waiting('Checks unavailable', 'Refresh the checks to continue'))
  } else if (checks && (!checksCurrent || checks.state === 'pending')) {
    blockers.push(
      waiting('Checks in progress', checksCurrent ? 'Wait for checks to finish' : 'Checks are refreshing'),
    )
  }
  if (unresolvedCount) {
    blockers.push(waiting('Review in progress', plural(unresolvedCount, 'unresolved thread')))
  }
  const remainingApprovals = (detail.requiredApprovingReviewCount ?? 0) - approvedReviewCount
  if (remainingApprovals > 0) {
    blockers.push(
      waiting('Review in progress', `${plural(remainingApprovals, 'approving review')} required`),
    )
  }
  return blockers
}

/** Everything standing between this pull request and a merge, worst first. */
function blockersOf(input: MergeReadinessInput): Blocker[] {
  const { detail, checks } = input
  // A result computed against a head the branch has since moved past is not
  // asserted either way — the same refusal the checks chip makes.
  const checksCurrent = !checks || checks.headSha === detail.headSha
  const blockers = [
    ...branchBlockers(detail, checks && checksCurrent ? checks.state : undefined),
    ...waitingBlockers(input, checksCurrent),
  ]
  // The host's own verdict is the catch-all: every blocker above already
  // explains a refusal, so this only speaks when none of them did.
  if (blockers.length === 0 && !hostCanMerge(detail)) {
    blockers.push(
      mergeStatusPending(detail)
        ? waiting('Merge status pending', 'GitHub is calculating merge readiness')
        : waiting('Review in progress', 'Merge requirements are still pending'),
    )
  }
  return blockers
}

export function mergeReadiness(input: MergeReadinessInput): MergeReadiness {
  const { detail, openedTime = null } = input
  const base = detail.baseRef ?? 'main'
  const opened = openedTime ? `Opened ${openedTime}` : ''

  if (detail.state === 'merged') {
    return { key: 'merged', headline: `Merged into ${base}`, note: opened, blocked: false, action: null }
  }
  if (detail.state === 'closed') {
    return { key: 'closed', headline: 'Closed', note: opened, blocked: false, action: null }
  }

  const blockers = blockersOf(input)
  if (detail.draft) {
    // A draft cannot merge whatever else is true, so the move is the one that
    // ends the draft; the note still names what waits behind it.
    return {
      key: 'draft',
      headline: 'Still a draft',
      note: blockers[0]?.note ?? opened,
      blocked: blockers.some((blocker) => blocker.blocked),
      action: detail.viewerPermissions.actions.includes('ready')
        ? { kind: 'mark-ready', label: 'Mark ready for review' }
        : null,
    }
  }
  const [first, second] = blockers
  if (!first) {
    return { key: 'ready', headline: 'Ready to merge', note: opened, blocked: false, action: mergeAction(detail) }
  }
  // The headline names the first blocker, so the note spends its one line on
  // the next one rather than saying the headline again.
  return {
    key: first.key,
    headline: first.headline,
    note: (second ?? first).note,
    blocked: first.blocked,
    action: first.action,
  }
}

export type MergeReadinessTone = 'positive' | 'negative' | 'review' | 'neutral'

/**
 * The colour the status card's glyph takes. It follows the same host palette
 * the list's status dots use — merged is purple, a blocker is red, ready is
 * green — and everything still in motion stays neutral, so the card is only
 * ever coloured when the colour says something the headline does not.
 */
export function readinessTone(key: MergeReadinessKey): MergeReadinessTone {
  switch (key) {
    case 'ready':
      return 'positive'
    case 'checks':
    case 'conflicts':
    case 'behind':
    case 'closed':
      return 'negative'
    case 'merged':
      return 'review'
    default:
      return 'neutral'
  }
}
