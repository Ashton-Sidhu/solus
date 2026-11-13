import type {
  AppCallView,
  AppCaller,
  AppOperation,
  AppScheduleTrigger,
  AppScheduleView,
  AppState,
  AppSummary,
  AppVersionView,
  AppWebhookView,
} from '@solus/contracts/apps'
import { attributionLabel } from '@solus/contracts/user'
import { relativeTime } from '../../lib/time'
import type { RowLine } from '../webhooks/webhook-rows'

/**
 * The words and the order of the phone's app screens (docs/plans/apps.md §9):
 * the Apps list, the app, and its sheet. An app is the owner's own program on
 * a host; the phone shows it, runs its UI, and gives the owner its controls.
 */

export type AppListState =
  | { kind: 'loading' }
  | { kind: 'loaded'; apps: AppSummary[] }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }

export const UNSUPPORTED_NOTE = 'This host does not support apps. Update Solus on it.'
export const EMPTY_NOTE = 'No apps on this host. Ask an agent to make one.'
/** The version source diff needs a wide screen; the sheet says where it is. */
export const VERSION_DIFF_NOTE = 'The source changes of a version show on desktop and web.'

/** The list in name order; the same names keep a stable order by id. */
export function sortApps(apps: readonly AppSummary[]): AppSummary[] {
  return [...apps].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** The names of the apps by id, for a surface that names an app it only has the id of. */
export function appNames(apps: readonly AppSummary[]): ReadonlyMap<string, string> {
  return new Map(apps.map((entry) => [entry.id, entry.name]))
}

/** How long ago, as the list rows say it. */
function agoText(at: number, now: number): string {
  const age = relativeTime(new Date(at).toISOString(), now)
  return age === '<1m' ? 'now' : `${age} ago`
}

/** How long until a time in the future. A time that passed is due now. */
function untilText(at: number, now: number): string {
  const minutes = Math.floor((at - now) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `in ${hours}h` : `in ${Math.floor(hours / 24)}d`
}

export function versionLabel(activeVersion: number | null): string {
  return activeVersion === null ? 'No version' : `v${activeVersion}`
}

export function lastCallText(lastCallAt: number | null, now: number): string {
  return lastCallAt === null ? 'No calls yet' : `Last call ${agoText(lastCallAt, now)}`
}

/** One row of the Apps list. */
export interface AppListItem {
  readonly title: string
  /** The version that runs. */
  readonly trailing: string
  readonly lines: readonly RowLine[]
}

/**
 * What the Apps list says of one app: its name, the version that runs, the
 * last call, and each thing that needs the owner. Stopped is the owner's own
 * choice, so it is not drawn as a fault.
 */
export function appListItem(app: AppSummary, now: number): AppListItem {
  return {
    title: app.name,
    trailing: versionLabel(app.activeVersion),
    lines: [
      { text: lastCallText(app.lastCallAt, now) },
      ...app.attention.map((attention): RowLine => ({ text: attention.detail, tone: attention.kind === 'stopped' ? 'muted' : 'danger' })),
    ],
  }
}

/**
 * What the app screen shows under its header. An app with no active version
 * has nothing to run, so it shows why the deploy failed. An app with no UI
 * shows its operations. Stopped is not here: a stopped app still opens.
 */
export type AppBody =
  | { kind: 'no-version'; error: string | null }
  | { kind: 'operations'; operations: readonly AppOperation[] }
  | { kind: 'frame' }

export function appBody(state: AppState): AppBody {
  if (state.app.activeVersion === null || !state.descriptor) {
    return { kind: 'no-version', error: state.app.attention.find((attention) => attention.kind === 'version-failed')?.detail ?? null }
  }
  return state.app.hasUi ? { kind: 'frame' } : { kind: 'operations', operations: state.descriptor.operations }
}

export function operationKindLabel(kind: AppOperation['kind']): string {
  return kind === 'query' ? 'Query' : 'Mutation'
}

// ─── Schedules ───

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function intervalText(everyMinutes: number): string {
  if (everyMinutes % 1440 === 0) return everyMinutes === 1440 ? 'Every day' : `Every ${everyMinutes / 1440} days`
  if (everyMinutes % 60 === 0) return everyMinutes === 60 ? 'Every hour' : `Every ${everyMinutes / 60} hours`
  return everyMinutes === 1 ? 'Every minute' : `Every ${everyMinutes} minutes`
}

/** A cron expression of a daily, weekday, or weekly time in words; any other expression as it is written. */
function cronText(expr: string): string {
  const fields = expr.trim().split(/\s+/)
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  if (fields.length !== 5 || !/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour) || dayOfMonth !== '*' || month !== '*') return `Cron ${expr}`
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
  if (dayOfWeek === '*') return `Every day at ${time}`
  if (dayOfWeek === '1-5') return `Weekdays at ${time}`
  // Cron counts Sunday as 0 and as 7.
  const day = /^[0-7]$/.test(dayOfWeek) ? WEEKDAY_NAMES[Number(dayOfWeek) % 7] : undefined
  return day ? `${day}s at ${time}` : `Cron ${expr}`
}

/** When a schedule runs, in words. A cron time is in the schedule's time zone, so the zone shows with it. */
export function triggerText(trigger: AppScheduleTrigger): string {
  if (trigger.type === 'interval') return intervalText(trigger.everyMinutes)
  const text = cronText(trigger.expr)
  return trigger.timezone ? `${text} (${trigger.timezone})` : text
}

/** The lines of one schedule: when it runs and what, its next run or that it is paused, and its last run. */
export function scheduleLines(schedule: AppScheduleView, now: number): RowLine[] {
  const lines: RowLine[] = [{ text: `${triggerText(schedule.trigger)} · runs ${schedule.run}` }]
  if (!schedule.enabled) lines.push({ text: 'Paused' })
  else if (schedule.nextRunAt !== null) lines.push({ text: `Next run ${untilText(schedule.nextRunAt, now)}` })
  if (schedule.lastOutcome === null || schedule.lastRunAt === null) {
    lines.push({ text: 'No run yet' })
  } else if (schedule.lastOutcome === 'ok') {
    lines.push({ text: `Last run completed ${agoText(schedule.lastRunAt, now)}` })
  } else {
    lines.push({ text: `Last run failed ${agoText(schedule.lastRunAt, now)}`, tone: 'danger' })
    if (schedule.lastError) lines.push({ text: schedule.lastError, tone: 'danger' })
  }
  return lines
}

// ─── Versions ───

export function versionStateLabel(state: AppVersionView['state']): string {
  switch (state) {
    case 'active': return 'Active'
    case 'superseded': return 'Earlier'
    case 'failed': return 'Failed'
  }
}

/** Only a version that ran before can run again; a failed one never became active. */
export function canMakeActive(version: Pick<AppVersionView, 'state'>): boolean {
  return version.state === 'superseded'
}

export function versionLines(version: AppVersionView, now: number): RowLine[] {
  const lines: RowLine[] = [
    { text: version.message || 'No message' },
    { text: `${agoText(version.createdAt, now)} · ${attributionLabel(version.createdBy)}` },
  ]
  if (version.state === 'failed' && version.error) lines.push({ text: version.error, tone: 'danger' })
  return lines
}

/** A question the owner answers before a change runs. */
export interface Confirmation {
  readonly title: string
  readonly message: string
}

/** The question before an earlier version runs again. A rollback does not rewind data (decision 6). */
export function makeActiveConfirmation(version: number): Confirmation {
  return {
    title: `Make v${version} active?`,
    message: `The app runs version ${version} from now. Its data is not rewound: what later versions wrote stays as it is.`,
  }
}

/** The question before an app is deleted: everything that goes with it (§4.3). */
export function deleteConfirmation(name: string): Confirmation {
  return {
    title: `Delete ${name}?`,
    message: 'Its data, its repository, its schedules, its secrets, and its webhooks are deleted with it. You cannot undo this.',
  }
}

// ─── Webhooks ───

export function webhookLines(webhook: AppWebhookView): RowLine[] {
  const lines: RowLine[] = [{ text: `Runs ${webhook.run}` }]
  if (webhook.problem) lines.push({ text: webhook.problem, tone: 'danger' })
  else if (!webhook.enabled) lines.push({ text: 'Paused' })
  else if (webhook.url === null) lines.push({ text: 'No URL. Link this host to Solus Cloud, or set its public URL.', tone: 'danger' })
  return lines
}

// ─── Calls ───

/** Who started a call, in words. A webhook is named when the app's webhooks are read. */
export function callerText(caller: AppCaller, webhooks: readonly AppWebhookView[] = []): string {
  switch (caller.kind) {
    case 'ui': return 'The app UI'
    case 'agent': return 'An agent'
    case 'schedule': return `Schedule ${caller.name}`
    case 'webhook': {
      const name = webhooks.find((webhook) => webhook.webhookId === caller.webhookId)?.name
      return name ? `Webhook ${name}` : 'A webhook'
    }
  }
}

export function callOutcomeLabel(outcome: AppCallView['outcome']): string {
  switch (outcome) {
    case 'running': return 'Running'
    case 'ok': return 'Completed'
    case 'failed': return 'Failed'
  }
}

/** The lines of one call in the call log: who called and which version ran, then how it ended. */
export function callLines(call: AppCallView, webhooks: readonly AppWebhookView[] = []): RowLine[] {
  const lines: RowLine[] = [{ text: `${callerText(call.caller, webhooks)} · v${call.version}` }]
  if (call.outcome === 'failed') lines.push({ text: call.error ?? 'Failed', tone: 'danger' })
  else lines.push({ text: callOutcomeLabel(call.outcome) })
  return lines
}

/** When a call started, for the trailing text of its row. */
export function callAgeText(call: Pick<AppCallView, 'startedAt'>, now: number): string {
  return relativeTime(new Date(call.startedAt).toISOString(), now)
}

/** When a session was linked, for the line under its title. */
export function linkedText(linkedAt: number, now: number): string {
  return `Linked ${agoText(linkedAt, now)}`
}
