import type { SshAddProgress } from '@solus/contracts/remote-machines'
import type { StatusCardState, StatusCardStep } from '@solus/contracts/types'

/**
 * Adding a machine over SSH as a setup card, the same card a run's setup draws,
 * on every client (docs/plans/host-routes.md D6). The host reports each step as
 * it starts, and the install again each time its percentage moves; a step keeps
 * its latest message and percentage. The result is the last step, not a screen
 * of its own.
 */

/** Where the add stands: its last step runs, failed, or ended well. */
export type SshAddStanding = 'running' | 'failed' | 'done'

export interface SshAddCardInput {
  /** The SSH target, as the person typed it. */
  target: string
  standing: SshAddStanding
  /** What the add did, once it is done. */
  resultMessage: string
  /** Why the add stopped, once it failed. */
  error: string
}

export function sshAddStatusCard(progress: readonly SshAddProgress[], input: SshAddCardInput): StatusCardState {
  const steps: StatusCardStep[] = []
  for (const event of progress) {
    const index = steps.findIndex((step) => step.id === event.step)
    const step: StatusCardStep = { id: event.step, label: event.message, status: 'done' }
    if (event.percent !== undefined) step.percent = event.percent
    // A step that reports again moves to the end: it is the one that runs now.
    if (index >= 0) steps.splice(index, 1)
    steps.push(step)
  }
  const last = steps.at(-1)
  if (last && input.standing === 'running') last.status = 'active'
  if (last && input.standing === 'failed') {
    last.status = 'error'
    if (input.error) last.detail = input.error
  }
  for (const step of steps) if (step.status !== 'active') delete step.percent
  if (input.standing !== 'failed') {
    steps.push(input.standing === 'done'
      ? { id: 'connected', label: input.resultMessage || 'Connected', status: 'done' }
      : { id: 'connected', label: 'Connected', status: 'pending' })
  }
  return {
    // One card per add: a new attempt starts its step times again.
    id: `ssh-add:${progress[0]?.requestId ?? 'pending'}`,
    title: `Adding ${input.target}`,
    icon: 'server',
    status: input.standing === 'running' ? 'active' : input.standing === 'failed' ? 'error' : 'done',
    steps,
  }
}
