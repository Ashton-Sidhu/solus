import {
    GitBranch as GitBranchIcon,
    GitMerge as GitMergeIcon,
    GitPullRequest as GitPullRequestIcon,
    CircleAlert as WarningCircleIcon,
  } from "@lucide/svelte";
  import type { PullRequestSummary } from '@solus/contracts/providers'

export type PrStateFilter = 'open' | 'closed' | 'all'
export type PrSortMode = 'updated' | 'created' | 'effort'

export interface PrStatusBadge {
  label: string
  Icon: typeof GitPullRequestIcon
  tone: string
}

/** Status chip facts for a PR — shared by the PRs page sidebar and the PR
 *  review activity rail. */
export function prStatusBadge(
  detail: { state: 'open' | 'closed' | 'merged'; draft: boolean; mergeStateStatus?: string | null } | null,
): PrStatusBadge | null {
  if (!detail) return null
  if (detail.draft && detail.state === 'open') {
    return { label: 'Draft', Icon: GitBranchIcon, tone: 'var(--solus-text-tertiary)' }
  }
  if (detail.state === 'open' && detail.mergeStateStatus === 'dirty') {
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
  items: PullRequestSummary[],
  query: string,
  stateFilter: PrStateFilter,
): PullRequestSummary[] {
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
  items: PullRequestSummary[],
  mode: PrSortMode,
): PullRequestSummary[] {
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

export function reviewEffortSummary(items: PullRequestSummary[]): {
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
  items: PullRequestSummary[]
  filtered: PullRequestSummary[]
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

export function reviewEffortTooltip(pr: PullRequestSummary): string | undefined {
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
