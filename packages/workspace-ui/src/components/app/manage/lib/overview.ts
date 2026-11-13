import type { AppMetrics, AppRuntimeView, AppSummary } from '@solus/contracts/apps'
import { formatFileSize } from '../../../files/lib/non-text-file'

/** The Overview section (docs/plans/apps.md §9.2): the last 24 hours as bars, and what the header of the page says. */

export interface HourBar {
  start: number
  calls: number
  failed: number
  /** The height of the bar and of its failed part, in percent of the tallest hour. */
  heightPercent: number
  failedPercent: number
}

/** One bar for each hour, the oldest first. The tallest hour is all of the height; an hour with a call is never invisible. */
export function hourBars(hours: AppMetrics['hours']): HourBar[] {
  const most = hours.reduce((max, hour) => Math.max(max, hour.calls), 0)
  return hours.map((hour) => {
    const heightPercent = most === 0 || hour.calls === 0 ? 0 : Math.max((hour.calls / most) * 100, 4)
    const failedPercent = hour.calls === 0 ? 0 : (Math.min(hour.failed, hour.calls) / hour.calls) * heightPercent
    return { ...hour, heightPercent, failedPercent }
  })
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

/** What the runner does now. A runner with no process is not a fault: it starts for the next call. */
export function runtimeText(runtime: AppRuntimeView): string {
  if (!runtime.running) return 'The runner is idle. It starts for the next call.'
  const work = runtime.inFlight === 0 ? 'no call in progress' : runtime.inFlight === 1 ? '1 call or run in progress' : `${runtime.inFlight} calls or runs in progress`
  return `The runner has a process: ${work}${runtime.rssBytes === null ? '' : `, ${formatFileSize(runtime.rssBytes)} of memory`}.`
}
