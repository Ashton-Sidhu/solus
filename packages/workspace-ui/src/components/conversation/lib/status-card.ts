import type { StatusCardState, StatusCardStep, StatusCardStepStatus, StatusCardSubstep } from '@solus/contracts/types'
import { formatStepDuration, setupSpanMs, stepDurationMs } from '@solus/contracts/setup-card'
import type { StepRailState } from '../../steps/lib/step-rail'

export interface StatusCardLine {
  /** The lowercase type word: the glyph and this word carry the state. */
  type: string
  /** The time a finished setup took. Empty while it runs or after it failed. */
  rail: string
}

/** The one-line summary of a setup card (docs/transcript-cards.md). It has
 *  no step count: the steps show where setup is. The time comes from the
 *  host's step times; a card the client made uses `clientTotalMs`, the time
 *  this client saw. */
export function statusCardLine(card: StatusCardState, clientTotalMs: number): StatusCardLine {
  if (card.status === 'error') return { type: 'failed', rail: '' }
  if (card.status === 'done') return { type: 'ready', rail: formatStepDuration(setupSpanMs(card) ?? clientTotalMs) }
  return { type: 'setting up', rail: '' }
}

/** A failed step or a step with a warning shows its detail below its row. The rule is the same for a sub-step. */
export function showsStepDetail(step: Pick<StatusCardStep, 'detail' | 'status'>): boolean {
  return !!step.detail && (step.status === 'error' || step.status === 'warning')
}

/** The marker of a setup step on the step timeline (`StepRail`). */
export function stepRailStateOf(status: StatusCardStepStatus): StepRailState {
  switch (status) {
    // The step in progress is the current one, with its number, as on the
    // onboarding timeline; the header's spinner says that work runs.
    case 'active': return 'current'
    case 'pending': return 'next'
    case 'error': return 'failed'
    default: return status
  }
}

/**
 * What the title row of a step says at its end. A step of several
 * repositories that runs counts the repositories that finished; a running
 * step without them says nothing, because its number and its bar show it.
 * Otherwise "skipped", or the time that the step took.
 */
export function stepTrailingNote(step: StatusCardStep, clientMs: number | undefined): string {
  if (step.status === 'active') {
    if (!step.substeps?.length) return ''
    const finished = step.substeps.filter((substep) => substep.status !== 'active' && substep.status !== 'pending').length
    return `${finished} of ${step.substeps.length}`
  }
  if (step.status === 'skipped') return 'skipped'
  const durationMs = stepDurationMs(step) ?? clientMs
  return durationMs === undefined ? '' : formatStepDuration(durationMs)
}

/** Where a failed card shows the host's output: under the repository that failed, under the step that failed, or after the steps. */
export type SetupOutputHome =
  | { kind: 'substep'; stepId: string; substepId: string }
  | { kind: 'step'; stepId: string }
  | { kind: 'end' }

/**
 * The output belongs next to what failed, so a person reads the error where
 * it happened. A failed setup with no output shows none.
 */
export function setupOutputHome(card: Pick<StatusCardState, 'status' | 'steps' | 'output'>): SetupOutputHome | null {
  if (card.status !== 'error' || !card.output?.length) return null
  for (const step of card.steps) {
    const substep = step.substeps?.find((candidate) => candidate.status === 'error')
    if (substep) return { kind: 'substep', stepId: step.id, substepId: substep.id }
  }
  const failedStep = card.steps.find((step) => step.status === 'error')
  return failedStep ? { kind: 'step', stepId: failedStep.id } : { kind: 'end' }
}

/**
 * How long a running sub-step has run, from the host's start time, as the
 * time beside its working mark. Nothing when the host sent no start time.
 */
export function substepElapsedNote(substep: Pick<StatusCardSubstep, 'status' | 'startedAt'>, now: number): string {
  if (substep.status !== 'active' || substep.startedAt === undefined) return ''
  return formatStepDuration(Math.max(0, now - substep.startedAt))
}

/**
 * What the row of a sub-step says at its end once it stopped: "skipped", or
 * the time that its repository took, from the times of the host. A sub-step
 * that waits says nothing, and one that runs has its elapsed time
 * (`substepElapsedNote`) beside the session sidebar's working dots.
 */
export function substepNote(substep: StatusCardSubstep): string {
  if (substep.status === 'active') return ''
  if (substep.status === 'skipped') return 'skipped'
  const durationMs = stepDurationMs(substep)
  return durationMs === undefined ? '' : formatStepDuration(durationMs)
}
