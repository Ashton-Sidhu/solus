import type {
  AppAttention,
  AppCallView,
  AppCaller,
  AppScheduleView,
  AppState,
  AppSummary,
  AppUi,
  AppVersionState,
  AppWebhookView,
} from '@solus/contracts/apps'
import type { AppHostStatus } from '../../../contexts/apps/apps.store.svelte'
import type { AppManageSection } from '../../../contexts/workspace/routing/route-registry'
import { relativeTime, triggerSummary } from '../../automations/lib/automation-format'

/**
 * What the app surface says of one app (docs/plans/apps.md §9). Pure, so the
 * rules are tested without a host.
 */

/** What the surface knows when it decides what to draw. */
export interface AppSurfaceFacts {
  /** The client still holds a connection to the app's host. */
  hostPresent: boolean
  hostStatus: AppHostStatus | null
  app: AppSummary | undefined
  state: AppState | undefined
  stateError: string | null
  /** The UI of the active version: null when it has none, undefined until it is read. */
  ui: AppUi | null | undefined
  uiError: string | null
}

export type AppSurfacePhase =
  | { kind: 'host-gone' }
  | { kind: 'loading' }
  /** A read failed; Retry reads again. */
  | { kind: 'error'; message: string }
  /** No deploy made a version that runs. */
  | { kind: 'no-version'; detail: string }
  /** The app has no UI: its Manage page is what the owner sees of it. */
  | { kind: 'no-ui' }
  | { kind: 'frame'; state: AppState; ui: AppUi }

export const APP_HOST_GONE_TEXT = 'The host of this app is not connected.'
export const APP_MISSING_TEXT = 'This host has no app with this name.'
export const APP_NO_VERSION_TEXT = 'No version of this app is active. Deploy a revision in Versions on the Manage page.'
export const APP_STOPPED_TEXT = 'Start the app. While it is stopped, no operation runs, no schedule fires, and no run continues.'
export const APP_NO_UI_TEXT = 'An agent, a schedule, a webhook, or a workflow calls its operations. The Manage page shows what it does.'

/** Why no version runs: the failed version's error, as the host says it. */
export function failedVersionDetail(app: AppSummary): string {
  return app.attention.find((item) => item.kind === 'version-failed')?.detail ?? APP_NO_VERSION_TEXT
}

export function appSurfacePhase(facts: AppSurfaceFacts): AppSurfacePhase {
  if (!facts.hostPresent) return { kind: 'host-gone' }
  const { app, state } = facts
  if (!app) {
    if (facts.hostStatus === 'ready') return { kind: 'error', message: APP_MISSING_TEXT }
    if (facts.hostStatus === 'unavailable') return { kind: 'error', message: 'This host did not answer with its apps.' }
    return { kind: 'loading' }
  }
  if (app.activeVersion === null) return { kind: 'no-version', detail: failedVersionDetail(app) }
  if (!app.hasUi) return { kind: 'no-ui' }
  if (!state) return facts.stateError ? { kind: 'error', message: facts.stateError } : { kind: 'loading' }
  if (facts.ui === undefined) return facts.uiError ? { kind: 'error', message: facts.uiError } : { kind: 'loading' }
  return facts.ui ? { kind: 'frame', state, ui: facts.ui } : { kind: 'no-ui' }
}

/** The two views of the app surface (§9.1): the app's own UI, and its Manage page. */
export type AppSurfaceView = 'app' | 'manage'

/**
 * The view the surface shows. A route that names no view opens the app, and
 * an app with no UI opens on its Manage page: it has nothing else to show.
 */
export function appSurfaceView(requested: 'manage' | undefined, app: Pick<AppSummary, 'hasUi'> | undefined): AppSurfaceView {
  if (requested === 'manage') return 'manage'
  return app && !app.hasUi ? 'manage' : 'app'
}

/**
 * Whether the surface knows the app well enough to show a view of it. Before
 * that, the host is gone, the list still loads, or the host has no such app:
 * one state takes all of the surface, under both views.
 */
export function showsAppViews(phase: AppSurfacePhase, app: AppSummary | undefined): app is AppSummary {
  return app !== undefined && phase.kind !== 'host-gone'
}

/**
 * One thing the app's owner must act on. The app surface draws none of them
 * over the app: the Manage switch has a dot, and the Overview section of the
 * Manage page lists them, each with the section where the owner acts.
 */
export interface AppProblem {
  kind: Exclude<AppAttention['kind'], 'stopped'>
  /** One sentence, as the host says it. */
  detail: string
  /** `error`: a part of the app does not work. `warning`: the app works, and a value or an older run waits for the owner. */
  tone: 'error' | 'warning'
  /** The section of the Manage page where the owner acts on it. */
  section: AppManageSection
  /** The label of the button that opens that section. */
  action: string
  /** `workflow-failed` and `workflow-stale`: the run that failed. */
  runId?: string
}

const PROBLEM_FIXES = {
  'version-failed': { tone: 'error', section: 'versions', action: 'Open Versions' },
  'schedule-failed': { tone: 'error', section: 'schedules', action: 'Open Schedules' },
  'workflow-failed': { tone: 'error', section: 'workflows', action: 'Open Workflows' },
  'workflow-stale': { tone: 'warning', section: 'workflows', action: 'Open Workflows' },
  'secret-missing': { tone: 'warning', section: 'secrets', action: 'Set in Secrets' },
} as const satisfies { [Kind in AppProblem['kind']]: Pick<AppProblem, 'tone' | 'section' | 'action'> }

/** The problems of one app. `stopped` is the owner's own choice and has its own bar with a Start button. */
export function appProblems(app: Pick<AppSummary, 'attention'>): AppProblem[] {
  return app.attention.flatMap((item) => {
    if (item.kind === 'stopped') return []
    const problem: AppProblem = { kind: item.kind, detail: item.detail, ...PROBLEM_FIXES[item.kind] }
    if (item.runId) problem.runId = item.runId
    return [problem]
  })
}

/** The dot on the Manage switch: red when one problem is an error, amber when the only problems are warnings; null with no problem. */
export function problemsTone(problems: readonly AppProblem[]): AppProblem['tone'] | null {
  if (problems.length === 0) return null
  return problems.some((problem) => problem.tone === 'error') ? 'error' : 'warning'
}

export function problemsLabel(count: number): string {
  return count === 1 ? '1 problem' : `${count} problems`
}

/** The tooltip of the header's Manage button: what a press does, its key, and the problems. */
export function manageToggleHint(input: { isManage: boolean; shortcut: string; problemCount: number }): string {
  const action = input.isManage ? 'Back to the app' : 'Manage'
  const key = input.shortcut ? ` (${input.shortcut})` : ''
  const problems = input.problemCount > 0 ? ` · ${problemsLabel(input.problemCount)}` : ''
  return `${action}${key}${problems}`
}

export function versionLabel(version: number | null): string {
  return version === null ? 'No version' : `v${version}`
}

const VERSION_STATE_LABELS = {
  building: 'Building',
  active: 'Active',
  superseded: 'Not active',
  failed: 'Failed',
} satisfies { [State in AppVersionState]: string }

export function versionStateLabel(state: AppVersionState): string {
  return VERSION_STATE_LABELS[state]
}

/** When something happened or will happen, from epoch milliseconds: "5 min ago", "in 2 hr". */
export function appTime(at: number | null, nowMs = Date.now()): string {
  return at === null ? '' : relativeTime(new Date(at).toISOString(), nowMs)
}

/** "Every 15 min", "Weekdays at 9:00 AM": the automations' own words for a trigger. */
export function scheduleTriggerText(schedule: Pick<AppScheduleView, 'trigger'>): string {
  return triggerSummary(schedule.trigger)
}

/** Who started a call, in words. A webhook goes by its declared name when the list has it. */
export function callerText(caller: AppCaller, webhooks: readonly AppWebhookView[] = []): string {
  switch (caller.kind) {
    case 'ui':
      return 'The UI'
    case 'agent':
      return 'An agent'
    case 'schedule':
      return `Schedule ${caller.name}`
    case 'webhook': {
      const name = webhooks.find((webhook) => webhook.webhookId === caller.webhookId)?.name
      return name ? `Webhook ${name}` : 'A webhook'
    }
    case 'workflow':
      // An empty step: the row is one execution of the workflow's function, not a call of a step.
      return caller.step ? `Step ${caller.step} of ${caller.workflow}` : `Run of ${caller.workflow}`
    case 'model':
      return 'A model call'
  }
}

const CALL_OUTCOME_LABELS = {
  running: 'Running',
  ok: 'OK',
  failed: 'Failed',
} satisfies { [Outcome in AppCallView['outcome']]: string }

export function callOutcomeLabel(outcome: AppCallView['outcome']): string {
  return CALL_OUTCOME_LABELS[outcome]
}

/** What a webhook row says of the mutation it runs. */
export function webhookRunText(webhook: Pick<AppWebhookView, 'run'>): string {
  return `Runs ${webhook.run}`
}

/** What the person confirms before a delete: everything that goes with the app. */
export function appDeleteConfirmText(name: string): string {
  return `Delete the app "${name}"? Its data, its repository, its schedules, its secrets, and its webhooks are deleted. You cannot get them back.`
}

export const APP_SOURCE_TEXT = 'Ask an agent to change this app: it calls checkout_app, save_app, and deploy_app.'
