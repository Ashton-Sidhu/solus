import type { AppDeployEvent, AppChangeLogEntry } from '@solus/client-core/app-versions'
import type { AppModelCallState, AppModelStep } from '@solus/contracts/app-models'
import type {
  AppCallOutcome,
  AppRunState,
  AppSignalDelivery,
  AppStepState,
  AppSummary,
  AppVersionState,
  AppWebhookView,
} from '@solus/contracts/apps'
import type { SessionRecordStatus } from '@solus/contracts/types'
import type { ScheduleTone } from './app-schedules'

/**
 * How a thing of the Manage screens stands, as the one mark `AppStateMark`
 * draws for it (docs/plans/apps.md §9.2). A call, a run, a step, a version, a
 * delivery, a schedule, and a webhook each have their own states; a reader
 * learns one set of marks for all of them. The desktop and the web use the
 * same set.
 */
export type AppItemState = 'ok' | 'failed' | 'running' | 'sleeping' | 'paused' | 'stopped' | 'idle' | 'warning'

/** The mark at the start of a row. With a `label` it is read aloud; without one the text of the row says the state. */
export interface AppRowMark {
  readonly state: AppItemState
  readonly label?: string
}

export function callState(outcome: AppCallOutcome): AppItemState {
  return outcome
}

/** A run that the owner terminated did not fail and did not finish: it has its own mark. */
const RUN_STATES = {
  running: 'running',
  sleeping: 'sleeping',
  succeeded: 'ok',
  failed: 'failed',
  terminated: 'stopped',
} satisfies { [State in AppRunState]: AppItemState }

export function runState(state: AppRunState): AppItemState {
  return RUN_STATES[state]
}

const STEP_STATES = {
  running: 'running',
  done: 'ok',
  failed: 'failed',
  sleeping: 'sleeping',
} satisfies { [State in AppStepState]: AppItemState }

export function stepState(state: AppStepState): AppItemState {
  return STEP_STATES[state]
}

/** A call that the owner cancelled did not fail; a call in the queue did not start. */
const MODEL_CALL_STATES = {
  queued: 'idle',
  running: 'running',
  done: 'ok',
  failed: 'failed',
  cancelled: 'stopped',
} satisfies { [State in AppModelCallState]: AppItemState }

export function modelCallState(state: AppModelCallState): AppItemState {
  return MODEL_CALL_STATES[state]
}

export function modelStepState(state: AppModelStep['state']): AppItemState {
  return state === 'done' ? 'ok' : state
}

/** A version that an other version replaced is not a fault: it is idle. */
const VERSION_STATES = {
  building: 'running',
  active: 'ok',
  superseded: 'idle',
  failed: 'failed',
} satisfies { [State in AppVersionState]: AppItemState }

export function versionState(state: AppVersionState): AppItemState {
  return VERSION_STATES[state]
}

/** The app itself. A build in progress comes first, as in `appStateLabel`. */
export function appItemState(app: Pick<AppSummary, 'activeVersion' | 'stopped' | 'buildingVersion'>): AppItemState {
  if (app.buildingVersion !== null) return 'running'
  if (app.activeVersion === null) return 'idle'
  return app.stopped ? 'stopped' : 'ok'
}

/** One save of the change log: the save that runs, or how the newest version built from it stands. */
export function changeLogState(entry: Pick<AppChangeLogEntry, 'position' | 'versions'>): AppItemState {
  if (entry.position === 'live') return 'ok'
  const newest = entry.versions[0]
  return newest ? versionState(newest.state) : 'idle'
}

/** One line of the deploy history. The line that put the live version in place comes first; a rollback asks for a look. */
export function deployEventState(event: Pick<AppDeployEvent, 'kind' | 'isLive'>): AppItemState {
  if (event.isLive) return 'ok'
  switch (event.kind) {
    case 'failed': return 'failed'
    case 'building': return 'running'
    case 'rollback': return 'warning'
    case 'deploy':
    case 'roll-forward': return 'idle'
  }
}

const SCHEDULE_STATES = {
  running: 'running',
  scheduled: 'ok',
  failing: 'failed',
  paused: 'paused',
  stopped: 'stopped',
} satisfies { [Tone in ScheduleTone]: AppItemState }

export function scheduleState(tone: ScheduleTone): AppItemState {
  return SCHEDULE_STATES[tone]
}

/** A webhook the host could not make receives nothing. One with a problem or with no URL needs the owner. */
export function webhookState(webhook: Pick<AppWebhookView, 'webhookId' | 'enabled' | 'url' | 'problem'>): AppItemState {
  if (webhook.webhookId === null) return 'failed'
  if (webhook.problem) return 'warning'
  if (!webhook.enabled) return 'paused'
  return webhook.url === null ? 'warning' : 'ok'
}

/** A throttled action did not run, but nothing is broken: it is a warning, not a failure. */
const DELIVERY_STATES = {
  delivered: 'ok',
  failed: 'failed',
  throttled: 'warning',
} satisfies { [Status in AppSignalDelivery['status']]: AppItemState }

/** One occurrence of a signal: the worst end of its actions. An occurrence that no action was on for is idle. */
export function occurrenceState(deliveries: readonly Pick<AppSignalDelivery, 'status'>[]): AppItemState {
  const states = deliveries.map((delivery) => DELIVERY_STATES[delivery.status])
  if (states.includes('failed')) return 'failed'
  if (states.includes('warning')) return 'warning'
  return states.length === 0 ? 'idle' : 'ok'
}

/** The run of a linked session. A session the host keeps no record of has no state. */
export function sessionState(status: SessionRecordStatus | null): AppItemState {
  switch (status) {
    case 'running': return 'running'
    case 'idle': return 'ok'
    case 'interrupted': return 'stopped'
    case null: return 'idle'
  }
}
