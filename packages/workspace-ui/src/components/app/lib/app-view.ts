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
  /** The app has no UI: its operations are what it is. */
  | { kind: 'operations'; state: AppState }
  | { kind: 'frame'; state: AppState; ui: AppUi }

export const APP_HOST_GONE_TEXT = 'The host of this app is not connected.'
export const APP_MISSING_TEXT = 'This host has no app with this name.'
export const APP_NO_VERSION_TEXT = 'No version of this app is active. Ask an agent to deploy it again.'

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
  if (!state) return facts.stateError ? { kind: 'error', message: facts.stateError } : { kind: 'loading' }
  if (!app.hasUi) return { kind: 'operations', state }
  if (facts.ui === undefined) return facts.uiError ? { kind: 'error', message: facts.uiError } : { kind: 'loading' }
  return facts.ui ? { kind: 'frame', state, ui: facts.ui } : { kind: 'operations', state }
}

/**
 * One thing the app's owner must act on. The app surface draws none of them
 * over the app: the menu button has a dot, and the Problems section of the
 * menu lists them, each with the section where the owner acts.
 */
export interface AppProblem {
  kind: Exclude<AppAttention['kind'], 'stopped'>
  /** One sentence, as the host says it. */
  detail: string
  /** `error`: a part of the app does not work. `warning`: the app waits for a value and works without it. */
  tone: 'error' | 'warning'
  /** The section of the menu where the owner acts on it. */
  section: AppMenuSection
  /** The label of the button that opens that section. */
  action: string
}

const PROBLEM_FIXES = {
  'version-failed': { tone: 'error', section: 'versions', action: 'Open Versions' },
  'schedule-failed': { tone: 'error', section: 'schedules', action: 'Open Schedules' },
  'secret-missing': { tone: 'warning', section: 'secrets', action: 'Set in Secrets' },
} as const

/** The problems of one app. `stopped` is the owner's own choice and has its own bar with a Start button. */
export function appProblems(app: AppSummary): AppProblem[] {
  return app.attention.flatMap((item) => (item.kind === 'stopped' ? [] : [{ kind: item.kind, detail: item.detail, ...PROBLEM_FIXES[item.kind] }]))
}

/** The dot on the menu button: an error when one problem is an error, else a warning; null with no problem. */
export function problemsTone(problems: readonly AppProblem[]): AppProblem['tone'] | null {
  if (problems.length === 0) return null
  return problems.some((problem) => problem.tone === 'error') ? 'error' : 'warning'
}

export function problemsLabel(count: number): string {
  return count === 1 ? '1 problem' : `${count} problems`
}

export function versionLabel(version: number | null): string {
  return version === null ? 'No version' : `v${version}`
}

const VERSION_STATE_LABELS = {
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

/** What a schedule row says of its next run. */
export function scheduleNextRunText(schedule: AppScheduleView, appStopped: boolean, nowMs = Date.now()): string {
  if (!schedule.enabled) return 'Paused'
  if (appStopped) return 'The app is stopped'
  return schedule.nextRunAt === null ? 'No next run' : `Next run ${appTime(schedule.nextRunAt, nowMs)}`
}

/** What a schedule row says of its last run; null when it never ran. */
export function scheduleLastRunText(schedule: AppScheduleView, nowMs = Date.now()): string | null {
  if (schedule.lastRunAt === null || schedule.lastOutcome === null) return null
  return `${schedule.lastOutcome === 'ok' ? 'Last run OK' : 'Last run failed'} ${appTime(schedule.lastRunAt, nowMs)}`
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

/** The sections of the app menu, in the order the menu lists them. */
export const APP_MENU_SECTIONS = [
  { id: 'problems', label: 'Problems' },
  { id: 'versions', label: 'Versions' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'secrets', label: 'Secrets' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'calls', label: 'Calls' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'source', label: 'Source' },
] as const

export type AppMenuSection = (typeof APP_MENU_SECTIONS)[number]['id']

/**
 * The sections a menu lists now. Problems is there while the app has one, and
 * while it is the open section: the last problem that goes away must not take
 * the section from under its reader.
 */
export function appMenuSections(problemCount: number, openSection: AppMenuSection | null = null) {
  return APP_MENU_SECTIONS.filter((section) => section.id !== 'problems' || problemCount > 0 || openSection === 'problems')
}

export const APP_SOURCE_TEXT = 'Ask an agent to change this app: it calls checkout_app.'
export const APP_ROLLBACK_NOTE = 'An earlier version runs again. The data of the app is not rewound.'
