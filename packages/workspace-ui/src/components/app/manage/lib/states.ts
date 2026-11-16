import type { AppCallOutcome, AppRunState, AppSignalDelivery, AppStepState, AppVersionState } from '@solus/contracts/apps'

/**
 * How a thing of the Manage page stands, as the one mark `StateIcon` draws
 * for it. A call, a run, a step, a version, and a delivery each have their
 * own states; a reader learns one set of marks for all of them.
 */
export type ManageState = 'ok' | 'failed' | 'running' | 'sleeping' | 'paused' | 'stopped' | 'idle' | 'warning'

export function callState(outcome: AppCallOutcome): ManageState {
  return outcome
}

/** A run that the owner terminated did not fail and did not finish: it has its own mark. */
const RUN_STATES = {
  running: 'running',
  sleeping: 'sleeping',
  succeeded: 'ok',
  failed: 'failed',
  terminated: 'stopped',
} satisfies { [State in AppRunState]: ManageState }

export function runState(state: AppRunState): ManageState {
  return RUN_STATES[state]
}

const STEP_STATES = {
  running: 'running',
  done: 'ok',
  failed: 'failed',
  sleeping: 'sleeping',
} satisfies { [State in AppStepState]: ManageState }

export function stepState(state: AppStepState): ManageState {
  return STEP_STATES[state]
}

/** A version that an other version replaced is not a fault: it is idle. */
const VERSION_STATES = {
  building: 'running',
  active: 'ok',
  superseded: 'idle',
  failed: 'failed',
} satisfies { [State in AppVersionState]: ManageState }

export function versionState(state: AppVersionState): ManageState {
  return VERSION_STATES[state]
}

/** A throttled action did not run, but nothing is broken: it is a warning, not a failure. */
const DELIVERY_STATES = {
  delivered: 'ok',
  failed: 'failed',
  throttled: 'warning',
} satisfies { [Status in AppSignalDelivery['status']]: ManageState }

export function deliveryState(status: AppSignalDelivery['status']): ManageState {
  return DELIVERY_STATES[status]
}
