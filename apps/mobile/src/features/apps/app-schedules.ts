import type { AppCallView, AppScheduleView } from '@solus/contracts/apps'
import { agoText, callOutcomeLabel, durationText, untilText } from './apps'

/**
 * Schedules (docs/plans/apps.md §8.1, §9.2): the mark of the state, the
 * name, the recent runs, and the age of the last run. The same rules as the
 * desktop and web Schedules section.
 */

/** How many runs a schedule's bars show: the automations' run graph window. */
export const SCHEDULE_RUN_WINDOW = 17

/**
 * What the mark of a schedule says. `failing`: the last run failed, and a
 * failed run does not try again (plan §8). `stopped`: the schedule is on, but
 * the app is stopped, so it does not fire.
 */
export type ScheduleTone = 'running' | 'scheduled' | 'failing' | 'paused' | 'stopped'

/** `runs` is the newest first. */
export function scheduleTone(schedule: Pick<AppScheduleView, 'enabled' | 'lastOutcome'>, appStopped: boolean, runs: readonly AppCallView[]): ScheduleTone {
  if (runs[0]?.outcome === 'running') return 'running'
  if (!schedule.enabled) return 'paused'
  if (appStopped) return 'stopped'
  return schedule.lastOutcome === 'failed' ? 'failing' : 'scheduled'
}

export function scheduleToneLabel(tone: ScheduleTone): string {
  switch (tone) {
    case 'running': return 'Running'
    case 'scheduled': return 'Active'
    case 'failing': return 'Last run failed'
    case 'paused': return 'Paused'
    case 'stopped': return 'Waits for the app to start'
  }
}

/** "3:42 PM", or "Fri 3:42 PM" on another day. */
function clockText(at: number, now: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return date.toDateString() === new Date(now).toDateString() ? time : `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/** When the schedule runs next. A schedule that cannot fire shows no time: a time there is a lie. */
export function scheduleNextRunText(schedule: AppScheduleView, appStopped: boolean, now: number): string {
  if (!schedule.enabled) return 'Paused'
  if (appStopped) return 'When the app starts'
  if (schedule.nextRunAt === null) return 'Not planned'
  if (schedule.nextRunAt <= now) return 'Due now'
  return `${untilText(schedule.nextRunAt, now)} · ${clockText(schedule.nextRunAt, now)}`
}

export function scheduleLastRunText(schedule: AppScheduleView, now: number): string {
  if (schedule.lastRunAt === null || schedule.lastOutcome === null) return 'Never'
  return `${agoText(schedule.lastRunAt, now)} · ${schedule.lastOutcome === 'ok' ? 'Completed' : 'Failed'}`
}

/** The newest runs of one schedule, the newest first, from the calls of all schedules. */
export function scheduleRuns(calls: readonly AppCallView[], name: string, window = SCHEDULE_RUN_WINDOW): AppCallView[] {
  const runs: AppCallView[] = []
  for (const call of calls) {
    if (call.caller.kind !== 'schedule' || call.caller.name !== name) continue
    runs.push(call)
    if (runs.length === window) break
  }
  return runs
}

/** One bar of the run graph: its height the run's time against the longest. Its outcome marks a failed run. */
export interface ScheduleRunBar {
  readonly id: string
  readonly heightPct: number
  readonly outcome: AppCallView['outcome']
}

/** The bars, the oldest first. A short run is floored so it still reads as a bar, not a gap. */
export function scheduleRunBars(runs: readonly AppCallView[]): ScheduleRunBar[] {
  const oldestFirst = [...runs].reverse()
  const longest = oldestFirst.reduce((max, run) => Math.max(max, run.durationMs ?? 0), 0)
  return oldestFirst.map((run) => ({
    id: run.id,
    heightPct: Math.max(18, longest > 0 ? Math.round(((run.durationMs ?? 0) / longest) * 100) : 18),
    outcome: run.outcome,
  }))
}

/** One line of the history: how the run ended and how long it took. A failed run's error takes the line. */
export function scheduleRunSummary(run: AppCallView): string {
  if (run.outcome === 'failed' && run.error) return run.error.split('\n')[0]
  return run.durationMs === null ? callOutcomeLabel(run.outcome) : `${callOutcomeLabel(run.outcome)} · ${durationText(run.durationMs)}`
}

export function scheduleRunTime(run: AppCallView, now: number): string {
  return clockText(run.startedAt, now)
}
