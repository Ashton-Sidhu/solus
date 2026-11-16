import { z } from 'zod'
import type { AppModelCallState, AppModelCallView, AppModelStep } from '@solus/contracts/app-models'
import { durationText } from './apps'

/**
 * One model call (docs/plans/app-models.md §7), opened from the Activity log:
 * what the model wrote and its result. The owner cancels a call that has not
 * ended; the model of each setting is in Config.
 */

export function modelCallStateLabel(state: AppModelCallState): string {
  switch (state) {
    case 'queued': return 'Queued'
    case 'running': return 'Running'
    case 'done': return 'Done'
    case 'failed': return 'Failed'
    case 'cancelled': return 'Cancelled'
  }
}

export function modelStepStateLabel(state: AppModelStep['state']): string {
  switch (state) {
    case 'running': return 'Running'
    case 'done': return 'Done'
    case 'failed': return 'Failed'
  }
}

/** A call that has not ended can be cancelled. */
export function canCancelModelCall(call: Pick<AppModelCallView, 'status'>): boolean {
  return call.status === 'queued' || call.status === 'running'
}

/** How long the call took, or has taken so far. */
export function modelCallDurationText(call: Pick<AppModelCallView, 'startedAt' | 'endedAt'>, now: number): string | null {
  return call.startedAt === null ? null : durationText((call.endedAt ?? now) - call.startedAt)
}

/** `1,204 in · 380 out`, or null when the provider said nothing. */
export function modelCallTokensText(call: Pick<AppModelCallView, 'usage'>): string | null {
  const usage = call.usage
  if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return null
  return `${(usage.inputTokens ?? 0).toLocaleString()} in · ${(usage.outputTokens ?? 0).toLocaleString()} out`
}

/** A prompt longer than this folds to its first lines until the person opens it. */
export function isLongPrompt(prompt: string): boolean {
  return prompt.length > 360 || prompt.split('\n').length > 4
}

/** A result as the screen shows it: text as it is, data as indented JSON. */
export function modelCallResultText(result: AppModelCallView['result']): string {
  const text = z.string().safeParse(result)
  return text.success ? text.data : JSON.stringify(result, null, 2)
}
