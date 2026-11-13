import { APP_CALLER_KINDS, type AppCallOutcome, type AppCallView, type AppCallerKind } from '@solus/contracts/apps'
import type { AppCallQuery } from '../../../../contexts/apps/apps.store.svelte'
import { formatDuration } from '../../../insights/lib/format'

/**
 * The Activity section (docs/plans/apps.md §9.2): the filters of the call
 * log. The host applies them, so a filter is what the read asks for.
 */

/** What the person chose. An empty choice is "all". */
export interface CallFilter {
  operation: string
  callerKind: AppCallerKind | ''
  outcome: AppCallOutcome | ''
}

export const NO_CALL_FILTER: CallFilter = { operation: '', callerKind: '', outcome: '' }

/** The calls a view reads first, and with "Show more": the most the host gives in one read. */
export const CALL_FIRST_PAGE = 100
export const CALL_FULL_PAGE = 500

/** What the read asks the host for: only the filters the person chose. */
export function callQuery(filter: CallFilter, limit: number = CALL_FIRST_PAGE): AppCallQuery {
  const query: AppCallQuery = { limit }
  if (filter.operation) query.operation = filter.operation
  if (filter.callerKind) query.callerKind = filter.callerKind
  if (filter.outcome) query.outcome = filter.outcome
  return query
}

/** The filters of a read, for a view that opens again on the list it left. */
export function callFilterOf(query: AppCallQuery): CallFilter {
  return { operation: query.operation ?? '', callerKind: query.callerKind ?? '', outcome: query.outcome ?? '' }
}

export function isCallFilterSet(filter: CallFilter): boolean {
  return filter.operation !== '' || filter.callerKind !== '' || filter.outcome !== ''
}

/**
 * The operations the filter offers: the ones the active version declares, then
 * the ones the log still holds of an earlier version. The chosen one stays a
 * choice when neither names it.
 */
export function operationChoices(declared: readonly string[], seen: readonly string[], chosen: string): { value: string; label: string }[] {
  const names = [...declared]
  for (const name of [...seen].sort()) if (!names.includes(name)) names.push(name)
  if (chosen && !names.includes(chosen)) names.push(chosen)
  return [{ value: '', label: 'All operations' }, ...names.map((name) => ({ value: name, label: name }))]
}

const CALLER_KIND_LABELS = {
  ui: 'The UI',
  agent: 'An agent',
  schedule: 'A schedule',
  webhook: 'A webhook',
  workflow: 'A workflow',
  model: 'A model call',
} satisfies { [Kind in AppCallerKind]: string }

export const CALLER_KIND_CHOICES: { value: AppCallerKind | ''; label: string }[] = [
  { value: '', label: 'All callers' },
  ...APP_CALLER_KINDS.map((kind) => ({ value: kind, label: CALLER_KIND_LABELS[kind] })),
]

export const OUTCOME_CHOICES: { value: AppCallOutcome | ''; label: string }[] = [
  { value: '', label: 'All outcomes' },
  { value: 'ok', label: 'OK' },
  { value: 'failed', label: 'Failed' },
  { value: 'running', label: 'Running' },
]

/** Whether the host can hold more calls than the view read: the read came back full, and a larger read exists. */
export function canShowMoreCalls(calls: readonly AppCallView[], limit: number): boolean {
  return calls.length >= limit && limit < CALL_FULL_PAGE
}

/** How long a call took; "Running" while it has no end. */
export function callDurationText(call: Pick<AppCallView, 'durationMs' | 'outcome'>): string {
  return call.durationMs === null ? (call.outcome === 'running' ? 'Running' : '—') : formatDuration(call.durationMs)
}

/** The input as the detail shows it: indented when it is whole JSON, as the host kept it when it was cut. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
