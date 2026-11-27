import { z } from 'zod'
import type { AppModelCallState, AppModelCallView, AppModelStep } from '@solus/contracts/app-models'
import { formatDuration } from '../../../insights/lib/format'

/** One model call in the Activity log (docs/plans/app-models.md §7): what the call says. */

/** The owner stops a call that has not ended. */
export function canCancelModelCall(call: Pick<AppModelCallView, 'status'>): boolean {
  return call.status === 'queued' || call.status === 'running'
}

/** How long the call took, or has taken so far. */
export function modelCallDuration(call: Pick<AppModelCallView, 'startedAt' | 'endedAt'>, now: number): string {
  return call.startedAt === null ? '—' : formatDuration((call.endedAt ?? now) - call.startedAt)
}

/** A result as the detail shows it: text as it is, data as indented JSON. */
export function modelCallResultText(result: AppModelCallView['result']): string {
  const text = z.string().safeParse(result)
  return text.success ? text.data : JSON.stringify(result, null, 2)
}

const STEP_STATE_LABELS = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
} satisfies { [State in AppModelStep['state']]: string }

export function modelStepStateLabel(state: AppModelStep['state']): string {
  return STEP_STATE_LABELS[state]
}

/** A prompt longer than this folds to its first lines until the person opens it. */
export function isLongPrompt(prompt: string): boolean {
  return prompt.length > 360 || prompt.split('\n').length > 4
}

/** How long one operation took; empty while it runs. */
export function modelStepDuration(step: Pick<AppModelStep, 'startedAt' | 'endedAt'>): string {
  return step.endedAt === null ? '' : formatDuration(step.endedAt - step.startedAt)
}

/** The last stage of a call that has neither a result nor an error yet. */
export function modelCallEndText(state: AppModelCallState): string {
  switch (state) {
    case 'queued': return 'Waiting for the model to start…'
    case 'running': return 'The model is working…'
    case 'done': return 'The model returned no result.'
    case 'failed': return 'The call failed.'
    case 'cancelled': return 'Cancelled before the model finished.'
  }
}
