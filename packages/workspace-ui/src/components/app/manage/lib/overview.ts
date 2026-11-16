import type { AppMetrics, AppPermissions, AppRuntimeView, AppScheduleView, AppSummary, AppVersionView } from '@solus/contracts/apps'
import type { Attribution } from '@solus/contracts/user'
import { attributionLabel } from '@solus/contracts/user'
import { appTime } from '../../lib/app-view'
import { formatFileSize } from '../../../files/lib/non-text-file'

/** The Overview section (docs/plans/apps.md §9.2): the last 24 hours as bars, the status line, and the facts of its columns. */

const HOUR_MS = 60 * 60 * 1000

/** One hour of the chart: its calls split into the ones that failed and the ones that did not. */
export interface HourPoint {
  start: number
  calls: number
  failed: number
  succeeded: number
}

/** The hours as the chart stacks them. A host never counts more failed calls than calls, but the chart must not draw a negative bar if one does. */
export function hourPoints(hours: AppMetrics['hours']): HourPoint[] {
  return hours.map((hour) => {
    const failed = Math.min(hour.failed, hour.calls)
    return { start: hour.start, calls: hour.calls, failed, succeeded: hour.calls - failed }
  })
}

/** One bar of the last 24 hours: its height as a share of the busiest hour, and the share of it that failed, both 0 to 1. */
export interface HourBar {
  start: number
  calls: number
  failed: number
  height: number
  failedPart: number
}

/** The bars of the last 24 hours, the oldest first. The tallest bar is the busiest hour. */
export function hourBars(hours: AppMetrics['hours']): HourBar[] {
  const points = hourPoints(hours)
  const most = points.reduce((max, point) => Math.max(max, point.calls), 0)
  return points.map((point) => ({
    start: point.start,
    calls: point.calls,
    failed: point.failed,
    height: most === 0 ? 0 : point.calls / most,
    failedPart: point.calls === 0 ? 0 : point.failed / point.calls,
  }))
}

/** What a bar says on hover: "3 PM – 4 PM: 120 calls, 2 failed". */
export function hourBarLabel(bar: Pick<HourBar, 'start' | 'calls' | 'failed'>): string {
  const format = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric' })
  const calls = bar.calls === 1 ? '1 call' : `${bar.calls.toLocaleString()} calls`
  return `${format(bar.start)} – ${format(bar.start + HOUR_MS)}: ${calls}${bar.failed > 0 ? `, ${bar.failed.toLocaleString()} failed` : ''}`
}

/** The label under the oldest bar: "14:00", or "14:00 yesterday" when that hour is on the day before. */
export function hourSpanStartLabel(start: number, nowMs = Date.now()): string {
  const time = new Date(start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return new Date(start).toDateString() === new Date(nowMs).toDateString() ? time : `${time} yesterday`
}

/** The share of calls that failed: "0%", "4.2%"; an em dash with no call. */
export function failureRateText(calls: number, failed: number): string {
  if (calls === 0) return '—'
  const rate = (failed / calls) * 100
  return rate === 0 || rate >= 10 ? `${Math.round(rate)}%` : `${rate.toFixed(1)}%`
}

export type AppRunState = 'no-version' | 'building' | 'stopped' | 'running'

/** The state a list and the Overview name: stopped is the owner's choice, and it wins over what the versions say. */
export function appRunState(app: Pick<AppSummary, 'stopped' | 'activeVersion' | 'buildingVersion'>): AppRunState {
  if (app.buildingVersion !== null) return 'building'
  if (app.activeVersion === null) return 'no-version'
  return app.stopped ? 'stopped' : 'running'
}

const RUN_STATE_LABELS = {
  'no-version': 'No version',
  building: 'Building',
  stopped: 'Stopped',
  running: 'Running',
} satisfies { [State in AppRunState]: string }

export function appRunStateLabel(state: AppRunState): string {
  return RUN_STATE_LABELS[state]
}

/** The line under the state: why a stopped app does nothing, which version builds, or what the runner does now. */
export function appStateText(app: Pick<AppSummary, 'stopped' | 'activeVersion'>, building: { number: number } | null, runtime: AppRuntimeView | null): string {
  if (building) return `The host builds version ${building.number} now.`
  if (app.activeVersion === null) return 'Deploy a version to run the app.'
  if (app.stopped) return 'No operation runs and no schedule fires.'
  return runtime ? runtimeText(runtime) : 'Reading…'
}

/** What the runner does now, in short facts: "Idle until the next call", or "1 call in progress · 86 MB". A runner with no process is not a fault: it starts for the next call. */
export function runtimeText(runtime: AppRuntimeView): string {
  if (!runtime.running) return 'Idle until the next call'
  const work = runtime.inFlight === 0 ? 'No call in progress' : runtime.inFlight === 1 ? '1 call in progress' : `${runtime.inFlight} calls in progress`
  return runtime.rssBytes === null ? work : `${work} · ${formatFileSize(runtime.rssBytes)}`
}

/** What a schedule's row says at its edge: when it runs next, or that it does not run. */
export function scheduleNextText(schedule: Pick<AppScheduleView, 'enabled' | 'nextRunAt'>, nowMs = Date.now()): string {
  if (!schedule.enabled) return 'Paused'
  if (schedule.nextRunAt === null) return 'Not planned'
  return `Next ${appTime(schedule.nextRunAt, nowMs)}`
}

/** The line under a deploy: its message, who deployed it, and why it failed when it did. */
export function versionDetail(version: Pick<AppVersionView, 'message' | 'state' | 'error' | 'createdBy'>): string {
  const by = attributionLabel(version.createdBy)
  if (version.state === 'failed') return `Did not start: ${version.error ?? 'no reason was recorded'}`
  return version.message ? `${version.message} · ${by}` : `By ${by}`
}

/** The line after the state: the version that runs and the host. "version 14 · Studio". */
export function appVersionHostLine(app: Pick<AppSummary, 'activeVersion'>, hostLabel: string): string {
  return [app.activeVersion === null ? 'no version' : `version ${app.activeVersion}`, hostLabel].join(' · ')
}

/** The schedule that runs first, of the ones that run; null when none is planned. */
export function nextScheduleRun<Schedule extends Pick<AppScheduleView, 'enabled' | 'nextRunAt'>>(schedules: readonly Schedule[]): (Schedule & { nextRunAt: number }) | null {
  let next: (Schedule & { nextRunAt: number }) | null = null
  for (const schedule of schedules) {
    const at = schedule.nextRunAt
    if (!schedule.enabled || at === null) continue
    if (next === null || at < next.nextRunAt) next = { ...schedule, nextRunAt: at }
  }
  return next
}

/** Who made the app and in how many sessions: "Nov 3, 2026 by Ashton, in 4 sessions". The sessions are absent until the host answers. */
export function madeText(createdAt: number, createdBy: Attribution, sessionCount: number | undefined): string {
  const made = `${new Date(createdAt).toLocaleDateString([], { dateStyle: 'medium' })} by ${attributionLabel(createdBy)}`
  if (!sessionCount) return made
  return `${made}, in ${sessionCount === 1 ? '1 session' : `${sessionCount} sessions`}`
}

/** The host folders the app may read and write: "Reads reports · Writes exports", or "None". */
export function hostFoldersText(files: AppPermissions['files']): string {
  const listed = (paths: readonly string[]) => (paths.includes('*') ? 'every file' : paths.join(', '))
  const parts: string[] = []
  if (files.read.length > 0) parts.push(`Reads ${listed(files.read)}`)
  if (files.write.length > 0) parts.push(`Writes ${listed(files.write)}`)
  return parts.length === 0 ? 'None' : parts.join(' · ')
}
