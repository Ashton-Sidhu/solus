import type { AppCallView, AppScheduleView } from '@solus/contracts/apps'
import { RUN_GRAPH_WINDOW } from '../../../../contexts/automations/run-graph-window'
import { absoluteTime } from '../../../automations/lib/automation-format'
import { appTime, callOutcomeLabel } from '../../lib/app-view'
import { callDurationText } from './activity'

/**
 * The Schedules section (docs/plans/apps.md §8.1, §9.2): what the selected
 * schedule says of its next run, its last run, and its recent runs. The
 * calendar is `schedule-calendar.ts`.
 */

/** When the schedule runs next. A schedule that cannot fire shows no time: a time there is a lie. */
export function scheduleNextRunText(schedule: AppScheduleView, appStopped: boolean, nowMs: number): string {
  if (!schedule.enabled) return 'Paused'
  if (appStopped) return 'When the app starts'
  if (schedule.nextRunAt === null) return 'Not planned'
  if (schedule.nextRunAt <= nowMs) return 'Due now'
  return `${appTime(schedule.nextRunAt, nowMs)} · ${absoluteTime(new Date(schedule.nextRunAt).toISOString(), nowMs)}`
}

/** How the last run ended, in one sentence. A failed run does not try again (plan §8), so the sentence says what to do. */
export function scheduleLastRunLine(schedule: Pick<AppScheduleView, 'lastRunAt' | 'lastOutcome' | 'lastError'>, nowMs: number): string {
  if (schedule.lastRunAt === null || schedule.lastOutcome === null) return 'No run yet.'
  const when = absoluteTime(new Date(schedule.lastRunAt).toISOString(), nowMs)
  if (schedule.lastOutcome === 'ok') return `The last run ended well, ${when}.`
  const reason = schedule.lastError?.split('\n')[0].trim()
  return `The last run failed, ${when}${reason ? `: ${reason.replace(/\.$/, '')}` : ''}. A failed run does not try again: repair the cause, then press Run now.`
}

/** The newest runs of one schedule, the newest first, from the calls of all schedules. */
export function scheduleRuns(calls: readonly AppCallView[], name: string, window = RUN_GRAPH_WINDOW): AppCallView[] {
  const runs: AppCallView[] = []
  for (const call of calls) {
    if (call.caller.kind !== 'schedule' || call.caller.name !== name) continue
    runs.push(call)
    if (runs.length === window) break
  }
  return runs
}

/** One line of the history: what the run did, then how long it took. A failed run's error takes the line. */
export function scheduleRunSummary(run: AppCallView): string {
  if (run.outcome === 'failed' && run.error) return run.error.split('\n')[0]
  return run.outcome === 'running' ? 'Running' : `${callOutcomeLabel(run.outcome)} · ${callDurationText(run)}`
}

export function scheduleRunTime(run: AppCallView, nowMs: number): string {
  return absoluteTime(new Date(run.startedAt).toISOString(), nowMs)
}
