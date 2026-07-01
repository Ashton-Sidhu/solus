import type { PullRequestSummary } from '../../../../shared/providers'

export type PrStateFilter = 'open' | 'closed' | 'all'
export type PrSortMode = 'updated' | 'created'

export function filterPrs(
  items: PullRequestSummary[],
  query: string,
  stateFilter: PrStateFilter,
): PullRequestSummary[] {
  const q = query.trim().toLowerCase()
  return items.filter((pr) => {
    if (stateFilter !== 'all' && pr.state !== stateFilter) return false
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
    const dateA = mode === 'created' ? a.createdAt : a.updatedAt
    const dateB = mode === 'created' ? b.createdAt : b.updatedAt
    return dateB.localeCompare(dateA)
  })
}

export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
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
