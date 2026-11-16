import { z } from 'zod'
import type { AppSpan, AppStepTry, AppStepView } from '@solus/contracts/apps'

/**
 * The tries of one `step.do` step (docs/plans/apps.md §8.3). The runner writes
 * one `step` span for each try, in the call that ran the run's function, with
 * the try's number and the step's retry options as attributes. So the tries
 * come from the run's log, and a step's receipt keeps only their count.
 */

/** One call of a run, as the tries read it: when it started, and its spans. */
export interface AppRunCallSpans {
  startedAt: number
  spans: readonly AppSpan[]
}

/** The attributes the runner gives a step's span. A span from a runner before the retry options has none of them. */
const stepAttributesSchema = z.object({ step: z.string(), attempt: z.number().int().min(1) })
const retryAttributesSchema = z.object({
  'retry.limit': z.number(),
  'retry.delay_ms': z.number(),
  'retry.backoff': z.enum(['constant', 'linear', 'exponential']),
  'step.timeout_ms': z.number(),
})

/** The tries of the step `name`, the oldest first, and its retry options as its newest try said them. */
export function stepTries(calls: readonly AppRunCallSpans[], name: string): Pick<AppStepView, 'tries' | 'retryPolicy'> {
  const found: { startedAt: number; attempt: number; span: AppSpan }[] = []
  for (const call of calls) {
    for (const span of call.spans) {
      if (span.kind !== 'step') continue
      const attributes = stepAttributesSchema.safeParse(span.attributes ?? {})
      if (!attributes.success || attributes.data.step !== name) continue
      found.push({ startedAt: call.startedAt + span.startMs, attempt: attributes.data.attempt, span })
    }
  }
  found.sort((a, b) => a.startedAt - b.startedAt)
  const tries = found.map(({ startedAt, attempt, span }): AppStepTry => ({
    attempt,
    startedAt,
    durationMs: span.durationMs,
    ok: span.ok,
    error: span.ok ? null : span.detail ?? null,
  }))
  const newest = found.at(-1)
  const policy = newest ? retryAttributesSchema.safeParse(newest.span.attributes ?? {}) : null
  return {
    tries,
    retryPolicy: policy?.success
      ? { limit: policy.data['retry.limit'], delayMs: policy.data['retry.delay_ms'], backoff: policy.data['retry.backoff'], timeoutMs: policy.data['step.timeout_ms'] }
      : null,
  }
}
