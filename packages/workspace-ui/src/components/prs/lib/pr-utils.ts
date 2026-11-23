import { matchesPrLabels } from '@solus/client-core/pr-label-filters'
import type { PrSort } from '@solus/contracts/pr-views'
import { comparePrs } from '@solus/client-core/pr-sort'
import { CircleAlert as WarningCircleIcon } from '@lucide/svelte'
import type { PullRequest } from '@solus/contracts/providers'
import { GitMergeIcon, GitPullRequestIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon } from '../../ui/octicons'
import { hasMergeConflicts } from '../../pr-review/lib/merge-readiness'
import { matchesPrText } from './pr-search-query'

export type PrStateFilter = 'open' | 'closed' | 'all'
/** `ready` is merge readiness — the default review queue. */
export type PrSortMode = PrSort
export type PrChecksState = 'passing' | 'pending' | 'failing'

export interface PrFacetSelection {
  guide?: 'all' | 'has-guide'
  lens?: 'all' | 'has-lens'
  involvement: 'all' | 'created' | 'assigned' | 'review-requested' | 'others'
  author: string | null
  label: string | null
  labels?: string[]
  labelGroups?: string[][]
  excludedLabels?: string[]
  draft: 'all' | 'ready' | 'draft'
  review: 'all' | 'approved' | 'changes-requested' | 'review-required' | 'no-reviews'
  checks: 'all' | 'passing' | 'pending' | 'failing'
}

interface PrFacetContext {
  hasGuide?: (pr: PullRequest) => boolean
  hasLens?: (pr: PullRequest) => boolean
  viewerLogin: (pr: PullRequest) => string | null
  checksState: (pr: PullRequest) => 'passing' | 'pending' | 'failing' | null
}

/** Applies only filters backed by facts present on every loaded list row. */
export function filterPrFacets(
  items: PullRequest[],
  selection: PrFacetSelection,
  context: PrFacetContext,
): PullRequest[] {
  return items.filter((pr) => {
    if (selection.guide === 'has-guide' && !context.hasGuide?.(pr)) return false
    if (selection.lens === 'has-lens' && !context.hasLens?.(pr)) return false
    if (!matchesInvolvement(pr, selection.involvement, context.viewerLogin(pr))) return false
    if (!matchesPrAuthor(pr, selection.author, context.viewerLogin(pr))) return false
    if (!matchesFacetLabels(pr, selection)) return false
    if (selection.draft === 'ready' && pr.draft) return false
    if (selection.draft === 'draft' && !pr.draft) return false
    if (selection.review !== 'all' && pr.reviewStatus !== selection.review) return false
    if (selection.checks !== 'all' && context.checksState(pr) !== selection.checks) return false
    return true
  })
}

function matchesPrAuthor(pr: PullRequest, selected: string | null, viewerLogin: string | null): boolean {
  if (!selected) return true
  const author = selected === 'me' ? viewerLogin : selected
  return !!author && pr.author.toLowerCase() === author.toLowerCase()
}

function matchesFacetLabels(pr: PullRequest, selection: PrFacetSelection): boolean {
  const included = selection.labels ?? (selection.label ? [selection.label] : [])
  const groups = selection.labelGroups ?? included.map((name) => [name])
  return matchesPrLabels(pr.labels.map((label) => label.name), groups, selection.excludedLabels ?? [])
}

function matchesInvolvement(pr: PullRequest, involvement: PrFacetSelection['involvement'], login: string | null): boolean {
  const viewer = login?.toLowerCase() ?? null
  switch (involvement) {
    case 'others': return pr.author.toLowerCase() !== viewer && !pr.needsMyReview && !pr.requestedReviewers?.some((reviewer) => reviewer.login.toLowerCase() === viewer)
    case 'created': return pr.author.toLowerCase() === viewer
    case 'assigned': return !!pr.assignees?.some((assignee) => assignee.toLowerCase() === viewer)
    case 'review-requested': return !!pr.needsMyReview || !!pr.requestedReviewers?.some((reviewer) => reviewer.login.toLowerCase() === viewer)
    default: return true
  }
}

export interface PrStatusBadge {
  label: string
  Icon: typeof GitPullRequestIcon
  tone: string
}

/** An open pull request a failing required check holds back. It reads as
 *  merge conflicts do: it cannot merge until someone acts. */
export const REQUIRED_CHECKS_FAILING_BADGE: PrStatusBadge = {
  label: 'Required checks failing',
  Icon: WarningCircleIcon,
  tone: 'var(--solus-art-negative)',
}

/** Status chip facts for a PR — shared by the PRs page sidebar and the PR
 *  review activity rail. */
/** A linked pull request the code host says does not exist. The link stays
 *  until someone removes it. */
export const PR_NOT_FOUND_BADGE: PrStatusBadge = {
  label: 'Not found',
  Icon: WarningCircleIcon,
  tone: 'var(--solus-text-tertiary)',
}

export function prStatusBadge(
  detail: {
    state: 'open' | 'closed' | 'merged'
    draft: boolean
    mergeable?: boolean | null
    mergeStateStatus?: string | null
  } | null,
): PrStatusBadge | null {
  if (!detail) return null
  if (detail.draft && detail.state === 'open') {
    return { label: 'Draft', Icon: GitPullRequestDraftIcon, tone: 'var(--solus-text-tertiary)' }
  }
  if (hasMergeConflicts(detail)) {
    return { label: 'Merge conflicts', Icon: WarningCircleIcon, tone: 'var(--solus-art-negative)' }
  }
  if (detail.state === 'merged') {
    return { label: 'Merged', Icon: GitMergeIcon, tone: 'var(--review)' }
  }
  if (detail.state === 'closed') {
    return { label: 'Closed', Icon: GitPullRequestClosedIcon, tone: 'var(--failure)' }
  }
  return { label: 'Open', Icon: GitPullRequestIcon, tone: 'var(--success)' }
}

export function filterPrs(
  items: PullRequest[],
  query: string,
  stateFilter: PrStateFilter,
): PullRequest[] {
  return items.filter((pr) => {
    // "Closed" includes merged: the server's closed fetch returns merged PRs
    // (remapped to state 'merged'), and the tab counts group them as closed.
    if (stateFilter === 'open' && pr.state !== 'open') return false
    if (stateFilter === 'closed' && pr.state === 'open') return false
    return matchesPrText(pr, query)
  })
}

/**
 * The default review queue, in merge-readiness order: green and approved,
 * then green and still waiting on a verdict, then everything else still open —
 * drafts included, because their author has not made them mergeable yet — then
 * finished work. A known conflict is never ready, whatever else is true, so it
 * sinks to the bottom. Inside a tier the smaller measured diff comes first (an
 * unknown size after every known one), then the most recently updated.
 *
 * Checks come from the checks store, not the row, so they are asked for; a
 * summary for an older head is not this head's answer and counts as unknown.
 */
export function rankPrsByMergeReadiness(
  items: readonly PullRequest[],
  checksState: (pr: PullRequest) => PrChecksState | null,
): PullRequest[] {
  return items.toSorted((a, b) => comparePrs(a, b, 'ready', (pr) => ({ viewerLogin: null, checks: checksState(pr) })))
}

export function sortPrs(
  items: PullRequest[],
  mode: PrSortMode,
  checksState: (pr: PullRequest) => PrChecksState | null = () => null,
  viewerLogin: (pr: PullRequest) => string | null = () => null,
): PullRequest[] {
  return items.toSorted((a, b) => comparePrs(a, b, mode, (pr) => ({ viewerLogin: viewerLogin(pr), checks: checksState(pr) })))
}

export interface PrInboxFacts {
  /** Open PRs in the loaded page. Counted from `items` rather than the tab
   *  filter so switching to Closed/All doesn't restate them as "open". */
  openCount: number
  /** Null until the first list fetch lands, so the header never claims a sync
   *  that hasn't happened. */
  syncedLabel: string | null
}

/** The facts under the inbox title: how much is open and how fresh the data is. */
export function prInboxFacts({
  items,
  listLoadedAt,
  now = Date.now(),
}: {
  items: PullRequest[]
  listLoadedAt: number
  now?: number
}): PrInboxFacts {
  return {
    openCount: items.reduce((count, pr) => count + (pr.state === 'open' ? 1 : 0), 0),
    syncedLabel: listLoadedAt > 0 ? `Synced ${relativeTime(listLoadedAt, now)}` : null,
  }
}

export function relativeTime(at: string | number, now = Date.now()): string {
  const ms = now - (Number.isFinite(at) ? Number(at) : new Date(String(at)).getTime())
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}
