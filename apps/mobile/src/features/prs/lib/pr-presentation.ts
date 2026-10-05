import type { CheckItem, PrChecksSummary } from '@solus/contracts/checks-types'
import type { PrReviewer, PrReviewVerdict, PrUnavailableReason, PullRequest } from '@solus/contracts/providers'
import type { HostPullRequests } from '../pull-request-directory'

/**
 * The words and groups the pull request screens show. The rules follow the web
 * client's (`workspace-ui/src/components/prs/lib/prs-list-view.ts` and
 * `pr-surface-error.ts`), which native code cannot import; a changed rule there
 * is changed here too.
 */

export interface PrSection {
  key: 'authored' | 'review-requested' | 'others'
  label: string
  prs: PullRequest[]
}

/** Authored first, then waiting on the viewer's review, then the rest. An
 *  empty section is left out. Without a known viewer nothing is "authored". */
export function prSections(prs: readonly PullRequest[], viewerLogin: string | null): PrSection[] {
  const authored: PullRequest[] = []
  const reviewRequested: PullRequest[] = []
  const others: PullRequest[] = []
  for (const pr of prs) {
    if (viewerLogin && pr.author.toLowerCase() === viewerLogin.toLowerCase()) authored.push(pr)
    else if (pr.needsMyReview) reviewRequested.push(pr)
    else others.push(pr)
  }
  const sections: PrSection[] = [
    { key: 'authored', label: 'Authored', prs: authored },
    { key: 'review-requested', label: 'Review requested', prs: reviewRequested },
    { key: 'others', label: 'Others', prs: others },
  ]
  return sections.filter((section) => section.prs.length > 0)
}

/** One row of the host list: a pull request and the project it came from. */
export interface PrRowItem {
  pr: PullRequest
  projectPath: string
  folderName: string
}

/** The host's pull requests from every readable project, newest activity
 *  first, in sections. */
export function hostPrSections(listing: HostPullRequests | null): { title: string; data: PrRowItem[] }[] {
  if (!listing) return []
  const rows = new Map<PullRequest, PrRowItem>()
  for (const project of listing.projects) {
    if (project.kind !== 'page') continue
    for (const pr of project.prs) rows.set(pr, { pr, projectPath: project.projectPath, folderName: project.folderName })
  }
  const newestFirst = Array.from(rows.keys()).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  return prSections(newestFirst, listing.viewerLogin).map((section) => ({ title: section.label, data: section.prs.map((pr) => rows.get(pr)!) }))
}

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

/** The checks in a word, or null when the PR has none. Only checks for the
 *  PR's current head count: an older run says nothing about this one. */
export function checksLabel(checks: PrChecksSummary | null, headSha: string): CheckStatus | null {
  if (!checks || checks.headSha !== headSha || checks.state === 'none') return null
  if (checks.state === 'passing') return { label: 'Checks passing', tone: 'passing' }
  if (checks.state === 'failing') return { label: 'Checks failing', tone: 'failing' }
  return { label: 'Checks running', tone: 'pending' }
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

export function reviewStatusLabel(status: PullRequest['reviewStatus']): string | null {
  if (status === 'approved') return 'Approved'
  if (status === 'changes-requested') return 'Changes requested'
  if (status === 'review-required') return 'Review required'
  return null
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
