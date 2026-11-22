import type { CheckItem } from '@solus/contracts/checks-types'
import type { PrReviewer, PrReviewVerdict, PrUnavailableReason, PullRequest } from '@solus/contracts/providers'

/**
 * The words the pull request screens show. The rules follow the web
 * client's (`workspace-ui/src/components/prs/lib/prs-list-view.ts` and
 * `pr-surface-error.ts`), which native code cannot import; a changed rule there
 * is changed here too.
 */

export type PrStateTone = 'open' | 'draft' | 'merged' | 'closed'

export function prStateTone(pr: Pick<PullRequest, 'state' | 'draft'>): PrStateTone {
  if (pr.state === 'merged') return 'merged'
  if (pr.state === 'closed') return 'closed'
  return pr.draft ? 'draft' : 'open'
}

export const PR_STATE_LABELS = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
} as const satisfies Record<PrStateTone, string>

const GITHUB_AUTH_MESSAGES = [
  'GitHub is not connected',
  'Your GitHub authorization is no longer valid. Reconnect GitHub to continue.',
]

/** True when the host refused because GitHub is not connected on it: the
 *  answer is a connection, not a retry. */
export function isGithubAuthError(message: string): boolean {
  return GITHUB_AUTH_MESSAGES.some((candidate) => message.includes(candidate))
}

/** Why a project has no pull requests, with its own name in the sentence. */
export function prUnavailableTitle(reason: PrUnavailableReason, projectLabel: string): string {
  if (reason === 'not-a-repository') return `${projectLabel} is not a git repository.`
  if (reason === 'no-remote') return `${projectLabel} has no git remote.`
  return `Solus can’t read pull requests from ${projectLabel}’s host yet.`
}

/** A check's outcome in a word, and its color family. */
export interface CheckStatus {
  label: string
  tone: 'passing' | 'pending' | 'failing' | 'neutral'
}

/** One check in a word, and whether it passed, failed, or is still going. */
export function checkItemLabel(item: Pick<CheckItem, 'conclusion' | 'inFlight'>): CheckStatus {
  if (item.inFlight || item.conclusion === null) return { label: 'Running', tone: 'pending' }
  switch (item.conclusion) {
    case 'success': return { label: 'Passed', tone: 'passing' }
    case 'failure': return { label: 'Failed', tone: 'failing' }
    case 'timed_out': return { label: 'Timed out', tone: 'failing' }
    case 'action_required': return { label: 'Needs action', tone: 'failing' }
    case 'cancelled': return { label: 'Cancelled', tone: 'neutral' }
    case 'skipped': return { label: 'Skipped', tone: 'neutral' }
    case 'stale': return { label: 'Stale', tone: 'neutral' }
    case 'neutral': return { label: 'Neutral', tone: 'neutral' }
  }
}

export function reviewerStateLabel(state: PrReviewer['state']): string {
  switch (state) {
    case 'APPROVED': return 'Approved'
    case 'CHANGES_REQUESTED': return 'Changes requested'
    case 'COMMENTED': return 'Commented'
    case 'DISMISSED': return 'Dismissed'
    case 'PENDING': return 'Review pending'
    case null: return 'Requested'
  }
}

/** A review verdict the viewer may give, which needs both the repository's
 *  support and the viewer's permission. GitHub refuses a verdict on your own
 *  pull request, so the author is offered a comment only. */
export function canGiveVerdict(pr: PullRequest, verdict: PrReviewVerdict, viewerLogin: string | null): boolean {
  if (!pr.capabilities.reviewVerdicts.includes(verdict) || !pr.viewerPermissions.reviewVerdicts.includes(verdict)) return false
  if (verdict === 'comment') return true
  return !viewerLogin || pr.author.toLowerCase() !== viewerLogin.toLowerCase()
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "now", "5m", "3h", "2d", then a date. */
export function prAge(iso: string, now: number): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const age = Math.max(0, now - at)
  if (age < MINUTE) return 'now'
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m`
  if (age < DAY) return `${Math.floor(age / HOUR)}h`
  if (age < 7 * DAY) return `${Math.floor(age / DAY)}d`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Whether a branch merges into its base: with conflicts, cleanly, or not reported. */
export type BranchMergeState = 'conflicts' | 'clean' | 'unknown'

export function branchMergeState(conflicting: boolean, clean: boolean): BranchMergeState {
  if (conflicting) return 'conflicts'
  return clean ? 'clean' : 'unknown'
}

/** The value at the end of the branch row; undefined when the title says it all. */
export function branchRowValue(input: { readonly updating: boolean; readonly behind: boolean; readonly mergeState: BranchMergeState; readonly baseRef: string }): string | undefined {
  if (input.updating) return 'Updating…'
  if (input.behind) return `Behind ${input.baseRef}`
  return input.mergeState === 'unknown' ? 'Not reported' : undefined
}
