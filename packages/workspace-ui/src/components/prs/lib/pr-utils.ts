import {
    GitBranch as GitBranchIcon,
    GitMerge as GitMergeIcon,
    GitPullRequest as GitPullRequestIcon,
    CircleAlert as WarningCircleIcon,
  } from "@lucide/svelte";
  import type { PullRequest } from '@solus/contracts/providers'
import { hasMergeConflicts } from '../../pr-review/lib/merge-readiness'

export type PrStateFilter = 'open' | 'closed' | 'all'
export type PrSortMode = 'updated' | 'created' | 'effort'

export interface PrFacetSelection {
  involvement: 'all' | 'created' | 'assigned' | 'review-requested'
  author: string | null
  label: string | null
  draft: 'all' | 'ready' | 'draft'
  review: 'all' | 'approved' | 'changes-requested' | 'review-required' | 'no-reviews'
  checks: 'all' | 'passing' | 'pending' | 'failing'
}

interface PrFacetContext {
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
    const viewer = context.viewerLogin(pr)?.toLowerCase() ?? null
    if (selection.involvement === 'created' && pr.author.toLowerCase() !== viewer) return false
    if (
      selection.involvement === 'assigned' &&
      !pr.assignees?.some((login) => login.toLowerCase() === viewer)
    ) return false
    if (
      selection.involvement === 'review-requested' &&
      !pr.requestedReviewers?.some((reviewer) => reviewer.login.toLowerCase() === viewer)
    ) return false
    if (selection.author && pr.author.toLowerCase() !== selection.author.toLowerCase()) return false
    if (selection.label && !pr.labels.some((label) => label.name === selection.label)) return false
    if (selection.draft === 'ready' && pr.draft) return false
    if (selection.draft === 'draft' && !pr.draft) return false
    if (selection.review !== 'all' && pr.reviewStatus !== selection.review) return false
    if (selection.checks !== 'all' && context.checksState(pr) !== selection.checks) return false
    return true
  })
}

export interface PrStatusBadge {
  label: string
  Icon: typeof GitPullRequestIcon
  tone: string
}

/** Status chip facts for a PR — shared by the PRs page sidebar and the PR
 *  review activity rail. */
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
    return { label: 'Draft', Icon: GitBranchIcon, tone: 'var(--solus-text-tertiary)' }
  }
  if (hasMergeConflicts(detail)) {
    return { label: 'Merge conflicts', Icon: WarningCircleIcon, tone: 'var(--solus-art-negative)' }
  }
  if (detail.state === 'merged') {
    return { label: 'Merged', Icon: GitMergeIcon, tone: 'var(--review)' }
  }
  if (detail.state === 'closed') {
    return { label: 'Closed', Icon: GitPullRequestIcon, tone: 'var(--failure)' }
  }
  return { label: 'Open', Icon: GitPullRequestIcon, tone: 'var(--success)' }
}

export function filterPrs(
  items: PullRequest[],
  query: string,
  stateFilter: PrStateFilter,
): PullRequest[] {
  const q = query.trim().toLowerCase()
  return items.filter((pr) => {
    // "Closed" includes merged: the server's closed fetch returns merged PRs
    // (remapped to state 'merged'), and the tab counts group them as closed.
    if (stateFilter === 'open' && pr.state !== 'open') return false
    if (stateFilter === 'closed' && pr.state === 'open') return false
    if (!q) return true
    return (
      pr.title.toLowerCase().includes(q) ||
      pr.author.toLowerCase().includes(q) ||
      String(pr.number).includes(q)
    )
  })
}

export function sortPrs(
  items: PullRequest[],
  mode: PrSortMode,
): PullRequest[] {
  return [...items].sort((a, b) => {
    if (mode === 'effort') {
      if (!a.effort && !b.effort) return b.updatedAt.localeCompare(a.updatedAt)
      if (!a.effort) return 1
      if (!b.effort) return -1
      return a.effort.minutes - b.effort.minutes || b.updatedAt.localeCompare(a.updatedAt)
    }
    const dateA = mode === 'created' ? a.createdAt : a.updatedAt
    const dateB = mode === 'created' ? b.createdAt : b.updatedAt
    return dateB.localeCompare(dateA)
  })
}

export function reviewEffortSummary(items: PullRequest[]): {
  count: number
  knownCount: number
  minutes: number
} | null {
  const known = items.filter((pr) => pr.effort)
  if (known.length === 0) return null
  return {
    count: items.length,
    knownCount: known.length,
    minutes: known.reduce((sum, pr) => sum + pr.effort!.minutes, 0),
  }
}

export interface PrInboxFacts {
  /** Open PRs in the loaded page. Counted from `items` rather than the tab
   *  filter so switching to Closed/All doesn't restate them as "open". */
  openCount: number
  /** Review minutes across the rows currently on screen, or null when no PR
   *  carries an estimate — the header drops the clause rather than asserting
   *  a fabricated "≈ 0 min". */
  effortMinutes: number | null
  /** Null until the first list fetch lands, so the header never claims a sync
   *  that hasn't happened. */
  syncedLabel: string | null
}

/** The three facts under the inbox title: how much is open, how long it reads,
 *  and how fresh the data is. */
export function prInboxFacts({
  items,
  filtered,
  listLoadedAt,
  now = Date.now(),
}: {
  items: PullRequest[]
  filtered: PullRequest[]
  listLoadedAt: number
  now?: number
}): PrInboxFacts {
  const effort = reviewEffortSummary(filtered)
  return {
    openCount: items.reduce((count, pr) => count + (pr.state === 'open' ? 1 : 0), 0),
    effortMinutes: effort ? effort.minutes : null,
    syncedLabel: listLoadedAt > 0 ? `Synced ${relativeTime(listLoadedAt, now)}` : null,
  }
}

export function reviewEffortTooltip(pr: PullRequest): string | undefined {
  return pr.effort?.signals.join(' · ')
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
