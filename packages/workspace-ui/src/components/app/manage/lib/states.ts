import type { AppCallOutcome, AppRunState, AppRuntimeView, AppSignalDelivery, AppStepState, AppSummary, AppVersionState } from '@solus/contracts/apps'
import { appRunState } from './overview'

/**
 * How a thing of the Manage page stands, as the one mark `StateIcon` draws
 * for it. An app, a call, a run, a step, a version, and a delivery each have
 * their own states; they map to the session marks, so a reader learns one set
 * of marks for sessions and apps. `starting` is a version that builds or an
 * app that starts; `offline` is an app whose host does not answer.
 */
export type ManageState = 'ok' | 'failed' | 'running' | 'starting' | 'sleeping' | 'paused' | 'stopped' | 'idle' | 'warning' | 'offline'

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
  building: 'starting',
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

/**
 * The mark of an app: the session mark of what its backend does now. A host
 * that does not answer cannot say that the app runs, so it wins. A runner with
 * no process is idle, not a fault: it starts for the next call. Stopped and no
 * version are idle too; the tooltip says which.
 */
export function appState(
  app: Pick<AppSummary, 'stopped' | 'activeVersion' | 'buildingVersion'>,
  runtime: Pick<AppRuntimeView, 'running'> | null,
  isHostUnreachable: boolean,
): ManageState {
  if (isHostUnreachable) return 'offline'
  const state = appRunState(app)
  if (state === 'building') return 'starting'
  if (state === 'running' && runtime?.running) return 'running'
  return 'idle'
}
