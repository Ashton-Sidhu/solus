import type { TurnSort, TurnStatusFilter } from './turn-rows'

/**
 * The rail's choices — the Sort and Filters menus of its narrowing row, and the
 * same menus again as crumbs once that row folds away. One list, so the fold
 * never offers a choice the row does not, or the other way round.
 */

export interface TurnSortChoice {
  value: string
  label: string
  sort: TurnSort
}

export const TURN_SORT_CHOICES: TurnSortChoice[] = [
  { value: 'newest', label: 'Newest first', sort: { key: 'startedAt', dir: 'desc' } },
  { value: 'oldest', label: 'Oldest first', sort: { key: 'startedAt', dir: 'asc' } },
  { value: 'longest', label: 'Longest', sort: { key: 'durationMs', dir: 'desc' } },
  { value: 'costliest', label: 'Most expensive', sort: { key: 'costUsd', dir: 'desc' } },
  { value: 'tokens', label: 'Most tokens', sort: { key: 'tokens', dir: 'desc' } },
]

export const TURN_STATUS_CHOICES: { value: TurnStatusFilter; label: string }[] = [
  { value: 'ok', label: 'Succeeded' },
  { value: 'error', label: 'Failed' },
  { value: 'interrupted', label: 'Interrupted' },
]

/** The menu choice a sort matches. A sort set from a table column the menu
 *  does not list matches none, rather than reading as a wrong one. */
export function sortChoiceFor(sort: TurnSort): TurnSortChoice | null {
  return (
    TURN_SORT_CHOICES.find(
      (choice) => choice.sort.key === sort.key && choice.sort.dir === sort.dir,
    ) ?? null
  )
}

/** A radio value back to a status, `all` (or anything unknown) to none. */
export function statusFilterFor(value: string): TurnStatusFilter | null {
  return TURN_STATUS_CHOICES.find((choice) => choice.value === value)?.value ?? null
}

export function statusFilterLabel(status: TurnStatusFilter | null): string {
  return TURN_STATUS_CHOICES.find((choice) => choice.value === status)?.label ?? 'All turns'
}
