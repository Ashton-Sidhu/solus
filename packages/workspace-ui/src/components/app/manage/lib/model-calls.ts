import { APP_MODEL_CALL_STATES, type AppModelCallState, type AppModelCallView, type AppModelStep } from '@solus/contracts/app-models'
import { formatDuration } from '../../../insights/lib/format'

/** The Models section (docs/plans/app-models.md §7): what a model call says, and the models a model setting offers. */

const STATE_LABELS = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
} satisfies { [State in AppModelCallState]: string }

export function modelCallStateLabel(state: AppModelCallState): string {
  return STATE_LABELS[state]
}

export const MODEL_CALL_STATE_CHOICES: { value: AppModelCallState | ''; label: string }[] = [
  { value: '', label: 'All states' },
  ...APP_MODEL_CALL_STATES.map((state) => ({ value: state, label: STATE_LABELS[state] })),
]

/** The owner stops a call that has not ended. */
export function canCancelModelCall(call: Pick<AppModelCallView, 'status'>): boolean {
  return call.status === 'queued' || call.status === 'running'
}

/** How long the call took, or has taken so far. */
export function modelCallDuration(call: Pick<AppModelCallView, 'startedAt' | 'endedAt'>, now: number): string {
  return call.startedAt === null ? '—' : formatDuration((call.endedAt ?? now) - call.startedAt)
}

/** `1,204 in · 380 out`, or empty when the provider said nothing. */
export function modelCallTokens(call: Pick<AppModelCallView, 'usage'>): string {
  const usage = call.usage
  if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return ''
  return `${(usage.inputTokens ?? 0).toLocaleString()} in · ${(usage.outputTokens ?? 0).toLocaleString()} out`
}

/** A result as the detail shows it: text as it is, data as indented JSON. */
export function modelCallResultText(result: AppModelCallView['result']): string {
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
}

const STEP_STATE_LABELS = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
} satisfies { [State in AppModelStep['state']]: string }

export function modelStepStateLabel(state: AppModelStep['state']): string {
  return STEP_STATE_LABELS[state]
}
