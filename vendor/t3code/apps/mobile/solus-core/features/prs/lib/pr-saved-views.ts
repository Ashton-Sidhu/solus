import type { PrViewFilters } from '@solus/contracts/pr-views'
import type { PullRequestListPreferences } from '../../workspace/list-preferences'
export function capturePrView(value: PullRequestListPreferences, query: string): PrViewFilters {
  return {
    hostId: value.hostId,
    project: value.project,
    query,
    state: value.state,
    involvement: value.involvement,
    labels: value.filters.labels ?? [],
    excludedLabels: value.filters.excludedLabels ?? [],
    author: value.filters.author ?? null,
    draft: value.filters.draft ?? 'all',
    review: value.filters.review ?? 'all',
    checks: value.filters.checks ?? 'all',
    sort: value.sort,
    guide: !!value.filters.guide,
    lens: !!value.filters.lens
  }
}
export function applyPrView(filters: PrViewFilters): PullRequestListPreferences {
  return {
    hostId: filters.hostId,
    project: filters.project,
    state: filters.state,
    involvement: filters.involvement,
    sort: filters.sort,
    filters: {
      guide: filters.guide,
      lens: filters.lens,
      labels: filters.labels.map((group) => [...group]),
      excludedLabels: [...filters.excludedLabels],
      author: filters.author ?? undefined,
      draft: filters.draft === 'all' ? undefined : filters.draft,
      review: filters.review === 'all' ? undefined : filters.review,
      checks: filters.checks === 'all' ? undefined : filters.checks
    }
  }
}
