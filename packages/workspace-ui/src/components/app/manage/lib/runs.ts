import { APP_RUN_STATES, type AppRunDetail, type AppRunState, type AppRunView, type AppStepKind } from '@solus/contracts/apps'
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

export function stepKindLabel(kind: AppStepKind): string {
  return STEP_KIND_LABELS[kind]
}

/** How long a run took, or has taken so far. */
export function runDurationText(run: Pick<AppRunView, 'startedAt' | 'finishedAt'>, nowMs = Date.now()): string {
  return formatDuration((run.finishedAt ?? nowMs) - run.startedAt)
}

/** The workflows the picker offers: the ones the active version declares, then any other that has a run, for a run from an older version. */
export function workflowNames(declared: readonly { name: string }[], runs: readonly Pick<AppRunView, 'workflow'>[]): string[] {
  const names = declared.map((workflow) => workflow.name)
  for (const run of runs) if (!names.includes(run.workflow)) names.push(run.workflow)
  return names
}

/** A run id short enough for a pill: its first eight characters. */
export function shortRunId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

/** The step a failed run stopped at: the one that Retry runs again. */
export function failedStepName(run: Pick<AppRunDetail, 'state' | 'steps'>): string | null {
  if (run.state !== 'failed') return null
  return run.steps.find((step) => step.state === 'failed')?.name ?? null
}
