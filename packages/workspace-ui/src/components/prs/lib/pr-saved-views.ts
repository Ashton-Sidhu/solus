import type { PrViewFilters } from '@solus/contracts/pr-views'
import type { PrListView } from './prs-list-view'
import { prStateValue, prStatusKeysFor } from './pr-filter-menu'

export function capturePrView(
  view: PrListView,
  hostId: string | null,
  project: PrViewFilters['project']
): PrViewFilters {
  const selectedState = prStateValue(view.statusKeys)
  const state =
    selectedState === 'merged' || selectedState === 'closed' || selectedState === 'all'
      ? selectedState
      : 'open'
  return {
    hostId,
    project,
    query: view.query,
    state,
    involvement:
      view.involvement === 'created'
        ? 'authored'
        : view.involvement === 'review-requested'
          ? 'reviewing'
          : view.involvement,
    labels:
      view.labelGroups ?? (view.labels ?? (view.label ? [view.label] : [])).map((label) => [label]),
    excludedLabels: view.excludedLabels ?? [],
    author: view.author,
    draft:
      selectedState === 'draft' || view.draft === 'draft'
        ? 'only'
        : view.draft === 'ready'
          ? 'hide'
          : 'all',
    review: view.review === 'no-reviews' ? 'none' : view.review,
    checks: view.checks,
    sort: view.sortMode,
    guide: view.guide === 'has-guide',
    lens: view.lens === 'has-lens'
  }
}
export function applyPrView(view: PrListView, filters: PrViewFilters): void {
  view.query = filters.query
  view.statusKeys = prStatusKeysFor(filters.state)
  view.sortMode = filters.sort
  view.involvement =
    filters.involvement === 'authored'
      ? 'created'
      : filters.involvement === 'reviewing'
        ? 'review-requested'
        : filters.involvement
  view.author = filters.author
  view.label = null
  view.labelGroups = filters.labels.map((group) => [...group])
  view.labels = filters.labels.flat()
  view.excludedLabels = [...filters.excludedLabels]
  view.draft = filters.draft === 'only' ? 'draft' : filters.draft === 'hide' ? 'ready' : 'all'
  view.review = filters.review === 'none' ? 'no-reviews' : filters.review
  view.checks = filters.checks
  view.guide = filters.guide ? 'has-guide' : 'all'
  view.lens = filters.lens ? 'has-lens' : 'all'
}
