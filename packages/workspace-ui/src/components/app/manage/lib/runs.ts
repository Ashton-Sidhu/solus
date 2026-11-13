import { APP_RUN_STATES, type AppRunState, type AppRunView, type AppStepKind, type AppStepState, type AppStepView } from '@solus/contracts/apps'
import { formatDuration } from '../../../insights/lib/format'

/** The Workflows section (docs/plans/apps.md §8.3, §9.2): what a run and a step say, and what the owner can do to a run. */

const RUN_STATE_LABELS = {
  running: 'Running',
  sleeping: 'Sleeping',
  succeeded: 'Succeeded',
  failed: 'Failed',
  terminated: 'Terminated',
} satisfies { [State in AppRunState]: string }

export function runStateLabel(state: AppRunState): string {
  return RUN_STATE_LABELS[state]
}

export const RUN_STATE_CHOICES: { value: AppRunState | ''; label: string }[] = [
  { value: '', label: 'All states' },
  ...APP_RUN_STATES.map((state) => ({ value: state, label: RUN_STATE_LABELS[state] })),
]

/** The owner terminates a run that has not ended. */
export function canTerminateRun(run: Pick<AppRunView, 'state'>): boolean {
  return run.state === 'running' || run.state === 'sleeping'
}

/** The owner starts a failed run again: the failed step runs again, and the finished steps do not. */
export function canRetryRun(run: Pick<AppRunView, 'state'>): boolean {
  return run.state === 'failed'
}

const STEP_KIND_LABELS = {
  do: 'Step',
  sleep: 'Sleep',
  query: 'Query',
  mutation: 'Mutation',
  model: 'Model',
} satisfies { [Kind in AppStepKind]: string }

const STEP_STATE_LABELS = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  sleeping: 'Sleeping',
} satisfies { [State in AppStepState]: string }

export function stepKindLabel(kind: AppStepKind): string {
  return STEP_KIND_LABELS[kind]
}

export function stepStateLabel(state: AppStepState): string {
  return STEP_STATE_LABELS[state]
}

/** How long a step took; null while it has no end. */
export function stepDurationText(step: Pick<AppStepView, 'startedAt' | 'finishedAt'>): string | null {
  return step.finishedAt === null ? null : formatDuration(step.finishedAt - step.startedAt)
}

/** "1 attempt", "3 attempts". */
export function attemptsText(attempts: number): string {
  return attempts === 1 ? '1 attempt' : `${attempts} attempts`
}

/** How long a run took, or has taken so far. */
export function runDurationText(run: Pick<AppRunView, 'startedAt' | 'finishedAt'>, nowMs = Date.now()): string {
  return formatDuration((run.finishedAt ?? nowMs) - run.startedAt)
}
