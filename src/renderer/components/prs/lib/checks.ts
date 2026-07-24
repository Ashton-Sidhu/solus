import type { CheckConclusion, CheckItem, PrChecksState, PrChecksSummary } from '../../../../shared/checks-types'

export type ChecksDisplayState = PrChecksState | 'unavailable'

export interface ChecksPresentation {
  state: ChecksDisplayState
  label: string
  tooltip: string
  stale: boolean
}

export function checksPresentation(
  summary: PrChecksSummary | undefined,
  currentHeadSha: string | null | undefined,
  loadFailed: boolean,
): ChecksPresentation | null {
  if (loadFailed) {
    return {
      state: 'unavailable',
      label: 'Checks unavailable',
      tooltip: 'Checks could not be refreshed. The last known result is not being asserted.',
      stale: false,
    }
  }
  if (!summary) return null

  const stale = !!currentHeadSha && summary.headSha !== currentHeadSha
  const state = stale ? 'pending' : summary.state
  return {
    state,
    label: stale ? 'Refreshing' : stateLabel(state),
    tooltip: `${stale ? 'Head changed; refreshing. ' : ''}${checksCounts(summary)}`,
    stale,
  }
}

export function checksCounts(summary: PrChecksSummary): string {
  const optionalFailing = summary.optional.filter(isFailing).length
  const base = `${summary.required.length} required · ${summary.optional.length} optional`
  return optionalFailing > 0
    ? `${base}; ${optionalFailing} optional failing`
    : base
}

export function checkResultLabel(item: CheckItem): string {
  if (item.inFlight) return 'Running'
  return conclusionLabel(item.conclusion)
}

export function isFailing(item: CheckItem): boolean {
  return !item.inFlight && !!item.conclusion && !['success', 'neutral', 'skipped'].includes(item.conclusion)
}

function stateLabel(state: PrChecksState): string {
  switch (state) {
    case 'pending': return 'Pending'
    case 'passing': return 'Passing'
    case 'failing': return 'Failing'
    case 'none': return 'No checks'
  }
}

function conclusionLabel(conclusion: CheckConclusion | null): string {
  if (!conclusion) return 'No result'
  switch (conclusion) {
    case 'success': return 'Passed'
    case 'failure': return 'Failed'
    case 'neutral': return 'Neutral'
    case 'cancelled': return 'Cancelled'
    case 'timed_out': return 'Timed out'
    case 'action_required': return 'Action required'
    case 'skipped': return 'Skipped'
    case 'stale': return 'Stale'
  }
}
