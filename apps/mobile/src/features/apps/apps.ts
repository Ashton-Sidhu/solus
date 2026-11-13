import type {
  AppCallView,
  AppCaller,
  AppCallerKind,
  AppJsonSchema,
  AppOperation,
  AppRuntimeView,
  AppScheduleTrigger,
  AppScheduleView,
  AppState,
  AppSummary,
  AppVersionView,
  AppWebhookView,
} from '@solus/contracts/apps'
import { attributionLabel } from '@solus/contracts/user'
import type { AppCallValue } from '@solus/client-core/app-calls'
import { z } from 'zod'
import { relativeTime } from '../../lib/time'
import type { RowLine } from '../webhooks/webhook-rows'

/**
 * The words and the order of the phone's app screens (docs/plans/apps.md §9):
 * the Apps list, the app, and what its Manage screens say of schedules,
 * versions, webhooks, and calls. An app is the owner's own program on a host;
 * the phone shows it, runs its UI, and gives the owner its controls.
 */

export type AppListState =
  | { kind: 'loading' }
  | { kind: 'loaded'; apps: AppSummary[] }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }

export const UNSUPPORTED_NOTE = 'This host does not support apps. Update Solus on it.'
export const EMPTY_NOTE = 'No apps on this host. Ask an agent to make one.'
/** A source change needs a wide screen; the Versions section says where it is. */
export const SOURCE_CHANGE_NOTE = 'The source change of a revision or a version shows on desktop and on the web.'

/** The list in name order; the same names keep a stable order by id. */
export function sortApps(apps: readonly AppSummary[]): AppSummary[] {
  return [...apps].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** The names of the apps by id, for a surface that names an app it only has the id of. */
export function appNames(apps: readonly AppSummary[]): ReadonlyMap<string, string> {
  return new Map(apps.map((entry) => [entry.id, entry.name]))
}

/** A count with its noun: `1 call`, `3 calls`. */
export function countText(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/** How long something took: milliseconds, then seconds, then minutes. */
export function durationText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`
}

/** The size of a file or of a result, in binary units. */
export function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`
}

/** How long ago, as the list rows say it. */
export function agoText(at: number, now: number): string {
  const age = relativeTime(new Date(at).toISOString(), now)
  return age === '<1m' ? 'now' : `${age} ago`
}

/** How long until a time in the future. A time that passed is due now. */
export function untilText(at: number, now: number): string {
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

/** What an app does now, in one word. A build in progress comes first: it is what changes next. */
export function appStateLabel(app: Pick<AppSummary, 'activeVersion' | 'stopped' | 'buildingVersion'>): string {
  if (app.buildingVersion !== null) return 'Building'
  if (app.activeVersion === null) return 'No version'
  return app.stopped ? 'Stopped' : 'Running'
}

/** The runner of an app, in one line. A runner stops when it is idle and starts for the next call. */
export function runtimeText(runtime: AppRuntimeView, now: number): string {
  if (!runtime.running) return 'Off. It starts for the next call.'
  const facts = [runtime.startedAt === null ? 'On' : `Started ${agoText(runtime.startedAt, now)}`]
  facts.push(runtime.inFlight === 0 ? 'idle' : `${runtime.inFlight} in progress`)
  if (runtime.rssBytes !== null) facts.push(`${bytesText(runtime.rssBytes)} of memory`)
  return facts.join(' · ')
}

/** The failed calls of the last 24 hours, or null when no call failed. */
export function failedCallsText(app: Pick<AppSummary, 'calls24h' | 'failed24h'>): string | null {
  if (!Number.isFinite(app.calls24h) || !Number.isFinite(app.failed24h)) return null
  return app.failed24h > 0 ? `${app.failed24h} of ${countText(app.calls24h, 'call')} failed in 24 h` : null
}

/** One row of the Apps list. */
export interface AppListItem {
  readonly title: string
  /** The version that runs; null when no version is active, which the first line says. */
  readonly trailing: string | null
  readonly lines: readonly RowLine[]
}

/**
 * What the Apps list says of one app: its name, the version that runs, its
 * state and its last call, the failed calls of 24 hours when there are any,
 * and how many problems need the owner. The Manage screen names each problem.
 */
export function appListItem(app: AppSummary, now: number): AppListItem {
  const lines: RowLine[] = [{ text: `${appStateLabel(app)} · ${lastCallText(app.lastCallAt, now)}` }]
  const failed = failedCallsText(app)
  if (failed) lines.push({ text: failed, tone: 'danger' })
  const problems = appProblemCount(app)
  if (problems > 0) lines.push({ text: countText(problems, 'problem'), tone: 'danger' })
  return { title: app.name, trailing: app.activeVersion === null ? null : versionLabel(app.activeVersion), lines }
}

/**
 * How many problems the owner must act on. The app screen draws none of them
 * over the app: its Manage button has a badge, and the Manage screen lists
 * them. Stopped is the owner's own choice, so it is not a problem.
 */
export function appProblemCount(app: AppSummary): number {
  return app.attention.filter((attention) => attention.kind !== 'stopped').length
}

/** The label of the app screen's Manage button. Android lists the button by its label, so the label carries the count. */
export function manageAppLabel(problemCount: number): string {
  if (problemCount === 0) return 'Manage app'
  return `Manage app, ${countText(problemCount, 'problem')}`
}

/**
 * What the app screen shows under its header. An app with no active version
 * has nothing to run, so it shows why the deploy failed, or that a save waits
 * for a deploy. An app with no UI shows its operations. Stopped is not here:
 * a stopped app still opens.
 */
export type AppBody =
  | { kind: 'no-version'; error: string | null; waitsForDeploy: boolean }
  | { kind: 'operations'; operations: readonly AppOperation[] }
  | { kind: 'frame' }

export function appBody(state: AppState): AppBody {
  if (state.app.activeVersion === null || !state.descriptor) {
    return {
      kind: 'no-version',
      error: state.app.attention.find((attention) => attention.kind === 'version-failed')?.detail ?? null,
      waitsForDeploy: state.app.hasUndeployedRevision,
    }
  }
  return state.app.hasUi ? { kind: 'frame' } : { kind: 'operations', operations: state.descriptor.operations }
}

export function operationKindLabel(kind: AppOperation['kind']): string {
  return kind === 'query' ? 'Query' : 'Mutation'
}

/** A JSON Schema or the value of a call as text a person reads. */
export function jsonText(value: AppJsonSchema | AppCallValue): string {
  return JSON.stringify(value, null, 2)
}

/** What a UI sends with a call: an object of arguments. */
const operationInputSchema = z.record(z.string(), z.json())

/**
 * The input of one run of an operation from the Operations section. A UI
 * sends an object of arguments, so the form takes only a JSON object; empty
 * text is the empty object.
 */
export function parseOperationInput(text: string): { ok: true; argumentsJson: string } | { ok: false; message: string } {
  if (text.trim() === '') return { ok: true, argumentsJson: '{}' }
  let input: ReturnType<typeof operationInputSchema.safeParse>
  try {
    input = operationInputSchema.safeParse(JSON.parse(text))
  } catch {
    return { ok: false, message: 'The input is not JSON.' }
  }
  if (!input.success) return { ok: false, message: 'The input must be a JSON object.' }
  return { ok: true, argumentsJson: JSON.stringify(input.data) }
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
    case 'building': return 'Building'
    case 'active': return 'Active'
    case 'superseded': return 'Earlier'
    case 'failed': return 'Failed'
  }
}

/** Only a version that ran before can run again; a failed one never became active, and one that builds is not a version yet. */
export function canMakeActive(version: Pick<AppVersionView, 'state'>): boolean {
  return version.state === 'superseded'
}

/** The start of a revision's commit, as a person names it. */
export function shortCommit(commit: string): string {
  return commit.slice(0, 7)
}

/**
 * The lines of one version: its message, when and by whom and from which
 * revision, how long the build took, why it failed, and what it may use.
 */
export function versionLines(version: AppVersionView, now: number): RowLine[] {
  const facts = [agoText(version.createdAt, now), attributionLabel(version.createdBy), `revision ${shortCommit(version.revision)}`]
  if (version.buildMs !== null) facts.push(`built in ${durationText(version.buildMs)}`)
  const lines: RowLine[] = [{ text: version.message || 'No message' }, { text: facts.join(' · ') }]
  if (version.state === 'building') lines.push({ text: 'The host builds this version now.' })
  if (version.state === 'failed' && version.error) lines.push({ text: version.error, tone: 'danger' })
  if (version.permissionsNotice) lines.push({ text: version.permissionsNotice })
  return lines
}

/** A question the owner answers before a change runs. */
export interface Confirmation {
  readonly title: string
  readonly message: string
}

/** The question before an earlier version runs again. A rollback does not rewind data (decision 8). */
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

/**
 * Who started a call, in words. A webhook is named when the app's webhooks
 * are read. A workflow caller with no step is one execution of the workflow's
 * function; one with a step is that step's own call of an operation.
 */
export function callerText(caller: AppCaller, webhooks: readonly AppWebhookView[] = []): string {
  switch (caller.kind) {
    case 'ui': return 'The app UI'
    case 'agent': return 'An agent'
    case 'schedule': return `Schedule ${caller.name}`
    case 'webhook': {
      const name = webhooks.find((webhook) => webhook.webhookId === caller.webhookId)?.name
      return name ? `Webhook ${name}` : 'A webhook'
    }
    case 'workflow': return caller.step === '' ? `Run of ${caller.workflow}` : `Step ${caller.step} of ${caller.workflow}`
    case 'model': return 'A model call'
  }
}

/** One kind of caller, as a filter and a file's record name it. */
export function callerKindLabel(kind: AppCallerKind): string {
  switch (kind) {
    case 'ui': return 'App UI'
    case 'agent': return 'Agent'
    case 'schedule': return 'Schedule'
    case 'webhook': return 'Webhook'
    case 'workflow': return 'Workflow'
    case 'model': return 'Model call'
  }
}

export function callOutcomeLabel(outcome: AppCallView['outcome']): string {
  switch (outcome) {
    case 'running': return 'Running'
    case 'ok': return 'Completed'
    case 'failed': return 'Failed'
  }
}

/** The lines of one call in the call log: who called, which version ran, and how long it took, then how it ended. */
export function callLines(call: AppCallView, webhooks: readonly AppWebhookView[] = []): RowLine[] {
  const facts = [callerText(call.caller, webhooks), `v${call.version}`]
  if (call.durationMs !== null) facts.push(durationText(call.durationMs))
  const lines: RowLine[] = [{ text: facts.join(' · ') }]
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
