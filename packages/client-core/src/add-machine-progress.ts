import type { AddMachineWay } from '@solus/contracts/add-machine'
import type { SshAddProgress } from '@solus/contracts/remote-machines'
import type { StatusCardState, StatusCardStep } from '@solus/contracts/types'
import { sshAddStatusCard, type SshAddStanding } from './ssh-progress'

/**
 * One add of the Add machine card as a setup card, the same card a run's setup
 * draws, on every client (docs/plans/add-machine-card.md). SSH reports its own
 * steps on `host.sshProgress`. A pairing is one host call, so its steps are
 * only what the client knows: it waits on the target, then it is connected.
 */

/** Where the add stands. `needs-auth`: SSH refused the key, and the card asks for a password. */
export type AddMachineStanding = SshAddStanding | 'needs-auth'

export interface AddMachineProgressInput {
  /** One card per attempt: a new attempt starts its step times again. */
  attemptId: string
  way: AddMachineWay
  /** The machine, as the card names it. */
  name: string
  /** `ssh`: the target, for the first step before the host reports one. */
  sshTarget?: string
  /** `ssh`: the steps the host reported for this attempt, oldest first. */
  sshSteps: readonly SshAddProgress[]
  standing: AddMachineStanding
  /** Why the add stopped, once it failed or needs a password. */
  error: string
}

export function addMachineStatusCard(input: AddMachineProgressInput): StatusCardState {
  const steps = input.way === 'ssh' ? sshSteps(input) : pairSteps(input)
  return {
    id: `add-machine:${input.attemptId}`,
    title: `${input.standing === 'done' ? 'Added' : 'Adding'} ${input.name}`,
    icon: 'server',
    status: input.standing === 'running' ? 'active' : input.standing === 'done' ? 'done' : 'error',
    steps,
  }
}

function sshSteps(input: AddMachineProgressInput): StatusCardStep[] {
  // SSH can stop before the host reports a step: the connect is the step it stopped on.
  const events = input.sshSteps.length > 0
    ? input.sshSteps
    : [{ requestId: input.attemptId, step: 'connect' as const, message: `Connecting to ${input.sshTarget ?? input.name}` }]
  const standing = input.standing === 'needs-auth' ? 'failed' : input.standing
  const { steps } = sshAddStatusCard(events, { target: input.name, standing, resultMessage: 'Connected', error: input.error })
  // A refused key is not the end: the step waits for a password.
  if (input.standing === 'needs-auth') {
    const last = steps.at(-1)
    if (last) last.status = 'warning'
  }
  return steps
}

function pairSteps(input: AddMachineProgressInput): StatusCardStep[] {
  const label = input.way === 'approve' ? `Waiting for approval on ${input.name}` : `Pairing with ${input.name}`
  const id = input.way === 'approve' ? 'approve' : 'pair'
  if (input.standing === 'running') {
    return [{ id, label, status: 'active' }, { id: 'connected', label: 'Connected', status: 'pending' }]
  }
  if (input.standing === 'done') {
    return [{ id, label, status: 'done' }, { id: 'connected', label: 'Connected', status: 'done' }]
  }
  const failed: StatusCardStep = { id, label, status: 'error' }
  if (input.error) failed.detail = input.error
  return [failed]
}
