import type { CheckConclusion, CheckItem, PrChecksState, PrChecksSummary } from '@solus/contracts/checks-types'

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

/** How long a finished check took, as a compact `1m 42s`. Null while a check is
 *  still running or when the host didn't report both stamps — the rail then
 *  shows nothing rather than a zero. */
export function checkDuration(item: CheckItem): string | null {
  if (!item.startedAt || !item.completedAt) return null
  const ms = new Date(item.completedAt).getTime() - new Date(item.startedAt).getTime()
  if (!Number.isFinite(ms) || ms <= 0) return null
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

/**
 * Every check on a PR, ordered so what's broken leads: failing, then still
 * running, then the rest. Surfaces preview only the first few rows, so the
 * host's own order buries a failure behind a screenful of green on a PR with
 * a long matrix. Ties keep required-before-optional and the host's order —
 * `sort` is stable.
 */
export function orderedChecks(summary: PrChecksSummary | undefined): CheckItem[] {
  if (!summary) return []
  return [...summary.required, ...summary.optional].sort(
    (a, b) => severityRank(a) - severityRank(b),
  )
}

function severityRank(item: CheckItem): number {
  if (isFailing(item)) return 0
  return item.inFlight ? 1 : 2
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
