import type { AppCallsRequest, AppRunState, AppRunView, AppRunsRequest, AppStepKind, AppStepState, AppStepView, AppWebhookView } from '@solus/contracts/apps'
import { APP_RUN_STATES } from '@solus/contracts/apps'
import type { RowLine } from '../webhooks/webhook-rows'
import type { FilterChoice } from './app-activity'
import { agoText, callerText, countText, durationText, untilText, type Confirmation } from './apps'

/**
 * The Workflows section (docs/plans/apps.md §8.3, §9.2): the runs of an
 * app's workflows and the steps of one run. The owner terminates a run that
 * is in progress, and starts a failed run again from its failed step.
 */

/** The most runs one read gives. */
const RUN_LIMIT = 100

export function runStateLabel(state: AppRunState): string {
  switch (state) {
    case 'running': return 'Running'
    case 'sleeping': return 'Sleeping'
    case 'succeeded': return 'Succeeded'
    case 'failed': return 'Failed'
    case 'terminated': return 'Terminated'
  }
}

export const RUN_STATE_CHOICES: readonly FilterChoice<AppRunState>[] = [
  { value: null, label: 'Every state' },
  ...APP_RUN_STATES.map((state) => ({ value: state, label: runStateLabel(state) })),
]

/** The read of the runs: the newest ones, in one state when a state is chosen. */
export function runsRequest(appId: string, state: AppRunState | null): AppRunsRequest {
  const request: AppRunsRequest = { appId, limit: RUN_LIMIT }
  if (state !== null) request.state = state
  return request
}

/**
 * The read of a run's log: the rows of the call log that belong to the run.
 * One row is an execution of the workflow's function, with the log lines of
 * the run and the spans of its steps; the others are the calls of its steps.
 */
export function runCallsRequest(appId: string, runId: string): AppCallsRequest {
  return { appId, runId, limit: RUN_LIMIT }
}

/** A run that is in progress can be terminated. */
export function canTerminate(run: Pick<AppRunView, 'state'>): boolean {
  return run.state === 'running' || run.state === 'sleeping'
}

/** Only a failed run starts again: its failed step runs again and its finished steps do not. */
export function canRunAgain(run: Pick<AppRunView, 'state'>): boolean {
  return run.state === 'failed'
}

/** A failed run the owner has not dismissed can be taken off what needs them, with no retry. */
export function canDismiss(run: Pick<AppRunView, 'state' | 'dismissedAt'>): boolean {
  return run.state === 'failed' && run.dismissedAt === null
}

/**
 * The lines of one run in the list: its state, its steps, and who started it;
 * when it wakes; why it failed. The row shows the age of the run at its end.
 */
export function runLines(run: AppRunView, now: number, webhooks: readonly AppWebhookView[] = []): RowLine[] {
  const facts = [runStateLabel(run.state), countText(run.stepCount, 'step'), callerText(run.startedBy, webhooks)]
  if (run.version !== null) facts.push(`v${run.version}`)
  if (run.dismissedAt !== null) facts.push('Dismissed')
  const lines: RowLine[] = [{ text: facts.join(' · ') }]
  if (run.state === 'sleeping' && run.wakeAt !== null) lines.push({ text: `Starts again ${untilText(run.wakeAt, now)}` })
  if (run.error) lines.push({ text: run.error, tone: 'danger' })
  return lines
}

export function stepKindLabel(kind: AppStepKind): string {
  switch (kind) {
    case 'do': return 'Step'
    case 'sleep': return 'Sleep'
    case 'query': return 'Query'
    case 'mutation': return 'Mutation'
    case 'model': return 'Model'
  }
}

export function stepStateLabel(state: AppStepState): string {
  switch (state) {
    case 'running': return 'Running'
    case 'done': return 'Done'
    case 'failed': return 'Failed'
    case 'sleeping': return 'Sleeping'
  }
}

/** The lines of one step: its kind, its attempts, and its time; when it wakes; why it failed. */
export function stepLines(step: AppStepView, now: number): RowLine[] {
  const time = step.finishedAt !== null ? `took ${durationText(step.finishedAt - step.startedAt)}` : `started ${agoText(step.startedAt, now)}`
  const lines: RowLine[] = [{ text: `${stepKindLabel(step.kind)} · ${countText(step.attempts, 'attempt')} · ${time}` }]
  if (step.state === 'sleeping' && step.wakeAt !== null) lines.push({ text: `Wakes ${untilText(step.wakeAt, now)}` })
  if (step.error) lines.push({ text: step.error, tone: 'danger' })
  else if (step.state === 'failed') lines.push({ text: stepStateLabel(step.state), tone: 'danger' })
  return lines
}

/** The question before a run is terminated: it does not start again. */
export function terminateConfirmation(workflow: string): Confirmation {
  return {
    title: `Terminate this run of ${workflow}?`,
    message: 'The run stops and does not start again. What its finished steps wrote stays as it is.',
  }
}

export const RUN_AGAIN_NOTE = 'The failed step runs again. The finished steps do not.'
