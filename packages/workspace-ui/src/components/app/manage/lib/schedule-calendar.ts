import type { AppScheduleLane, AppScheduleSpan, AppScheduleTrigger, AppScheduleView } from '@solus/contracts/apps'

/**
 * The calendar of the Schedules section (docs/plans/apps.md §9.2): a week of
 * days or a day of hours, one lane for each schedule. The client makes the
 * edges of the spans in its own time zone, and the host counts the runs in
 * each span. This module turns one span of one lane into what its cell says.
 */

export type CalendarView = 'week' | 'day'

/** The edges of the spans of the calendar that holds `anchor`: eight edges for a week from Monday, twenty-five for a day. */
export function calendarEdges(view: CalendarView, anchor: number): number[] {
  const day = new Date(anchor)
  day.setHours(0, 0, 0, 0)
  if (view === 'day') return Array.from({ length: 25 }, (_, hour) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour).getTime())
  // Monday is the first day: getDay() is 0 for Sunday.
  const monday = day.getDate() - ((day.getDay() + 6) % 7)
  return Array.from({ length: 8 }, (_, index) => new Date(day.getFullYear(), day.getMonth(), monday + index).getTime())
}

/** Whether an answer of the host is for these edges. */
export function sameEdges(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((edge, index) => edge === b[index])
}

/** The same calendar one week or one day before (`-1`) or after (`1`). */
export function shiftAnchor(view: CalendarView, anchor: number, direction: 1 | -1): number {
  const date = new Date(anchor)
  date.setDate(date.getDate() + direction * (view === 'week' ? 7 : 1))
  return date.getTime()
}

/** "Nov 9 – 15", "Nov 30 – Dec 6", or "Sun, Nov 15" for a day. */
export function calendarTitle(view: CalendarView, edges: readonly number[]): string {
  const first = new Date(edges[0])
  if (view === 'day') return first.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  const last = new Date(edges[edges.length - 1] - 1)
  const start = first.toLocaleDateString([], { month: 'short', day: 'numeric' })
  const end = last.getMonth() === first.getMonth() ? String(last.getDate()) : last.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return `${start} – ${end}`
}

/** One column head: the weekday "Mon" and the date "9", or the hour "09" in a day. */
export interface CalendarColumn {
  start: number
  end: number
  label: string
  figure: string
  isNow: boolean
}

export function calendarColumns(view: CalendarView, edges: readonly number[], nowMs: number): CalendarColumn[] {
  return edges.slice(1).map((end, index) => {
    const start = edges[index]
    const date = new Date(start)
    const isNow = start <= nowMs && nowMs < end
    if (view === 'day') return { start, end, label: '', figure: String(date.getHours()).padStart(2, '0'), isNow }
    return { start, end, label: date.toLocaleDateString([], { weekday: 'short' }), figure: String(date.getDate()), isNow }
  })
}

/** "09:00": a time of day in the client's own clock. */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * What one cell of a lane says.
 * `time`: one run, at its time, with its mark. `count`: more than one run;
 * `isShort` when fewer ran than the trigger planned (the host was off for a
 * part of it). `missed`: the trigger planned runs and none ran. `next`: the
 * next run is in this span. `later`: the next run is after the calendar, in
 * its last cell. `paused`: a span of a paused schedule after its last run.
 */
export type CalendarCell =
  | { kind: 'empty' }
  | { kind: 'time'; at: number; outcome: 'ok' | 'failed' | 'running' }
  | { kind: 'count'; runs: number; failed: number; isShort: boolean; isNow: boolean }
  | { kind: 'missed'; planned: number }
  | { kind: 'next'; at: number }
  | { kind: 'later'; at: number }
  | { kind: 'paused' }

/** A span counts as short of runs when fewer than this share of its planned runs ran. */
const SHORT_SHARE = 0.75

export function calendarCell(
  span: AppScheduleSpan,
  column: Pick<CalendarColumn, 'start' | 'end'>,
  lane: Pick<AppScheduleLane, 'upcoming'>,
  schedule: Pick<AppScheduleView, 'enabled' | 'lastRunAt'>,
  nowMs: number,
): CalendarCell {
  const runs = span.ok + span.failed + span.running
  const isPast = column.end <= nowMs
  const isNow = column.start <= nowMs && nowMs < column.end
  if (runs === 1 && span.planned <= 1 && span.lastRunAt !== null && span.lastOutcome !== null) return { kind: 'time', at: span.lastRunAt, outcome: span.lastOutcome }
  if (runs > 0) {
    // The share of the span that is behind now: a whole span in the past, part of the span now.
    const elapsed = isNow ? (nowMs - column.start) / (column.end - column.start) : 1
    const expected = Math.max(Math.round(span.planned * elapsed), 1)
    const isShort = !isNow && span.planned > 1 && runs / expected < SHORT_SHARE
    return { kind: 'count', runs, failed: span.failed, isShort, isNow }
  }
  const next = lane.upcoming.find((at) => at >= column.start && at < column.end)
  // A schedule that runs more than once in a span has no single next time to name there.
  if (next !== undefined) return span.planned <= 1 ? { kind: 'next', at: next } : { kind: 'empty' }
  // A paused schedule did not run after its last run: those spans are paused, not missed.
  if (!schedule.enabled && (!isPast || schedule.lastRunAt === null || column.end > schedule.lastRunAt)) return { kind: 'paused' }
  if (isPast && span.planned > 0) return { kind: 'missed', planned: span.planned }
  return { kind: 'empty' }
}

/**
 * One piece of a lane: a cell over one column, or one paused span over the
 * columns it covers. `since` names the column where the pause shows first,
 * when an earlier column is in the calendar; `hasUnit` marks the first count
 * of the lane, which says "runs".
 */
export interface LanePiece {
  start: number
  columns: number
  cell: CalendarCell
  since: string | null
  hasUnit: boolean
}

export function calendarLane(
  lane: AppScheduleLane | undefined,
  columns: readonly CalendarColumn[],
  schedule: Pick<AppScheduleView, 'enabled' | 'lastRunAt'>,
  view: CalendarView,
  nowMs: number,
): LanePiece[] {
  const cells = columns.map((column, index): CalendarCell => {
    const span = lane?.spans[index]
    return span && lane ? calendarCell(span, column, lane, schedule, nowMs) : { kind: 'empty' }
  })
  // The next run after the calendar shows in its last cell, when that cell is free.
  const last = columns.at(-1)
  const next = lane?.upcoming[0]
  if (schedule.enabled && last && next !== undefined && next >= last.end && cells.at(-1)?.kind === 'empty') cells[cells.length - 1] = { kind: 'later', at: next }

  const pieces: LanePiece[] = []
  let hasCounted = false
  cells.forEach((cell, index) => {
    const previous = pieces.at(-1)
    if (cell.kind === 'paused' && previous?.cell.kind === 'paused') {
      previous.columns += 1
      return
    }
    const since = cell.kind === 'paused' && index > 0 ? (view === 'week' ? columns[index].label : `${columns[index].figure}:00`) : null
    const hasUnit = cell.kind === 'count' && !hasCounted
    if (cell.kind === 'count') hasCounted = true
    pieces.push({ start: columns[index].start, columns: 1, cell, since, hasUnit })
  })
  return pieces
}

/** "Mon 09:00" for the next run in the coming week, "Nov 23 09:00" after it. */
export function laterText(at: number, nowMs: number): string {
  const date = new Date(at)
  const day = at - nowMs < 6 * 24 * 60 * 60_000 ? date.toLocaleDateString([], { weekday: 'short' }) : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return `${day} ${clockTime(at)}`
}

/** What a cell says to a screen reader and in its tooltip. */
export function calendarCellLabel(cell: CalendarCell, since: string | null = null): string {
  switch (cell.kind) {
    case 'time':
      return `One run at ${clockTime(cell.at)}, ${cell.outcome === 'ok' ? 'ended well' : cell.outcome === 'failed' ? 'failed' : 'in progress'}`
    case 'count':
      return `${cell.runs === 1 ? '1 run' : `${cell.runs} runs`}${cell.failed > 0 ? `, ${cell.failed} failed` : ''}${cell.isShort ? ', fewer than the trigger planned: the host was off for a part of the day' : ''}`
    case 'missed':
      return `No run. The trigger planned ${cell.planned === 1 ? 'one' : cell.planned}. The host was off, the app was stopped, or the schedule was paused.`
    case 'next':
      return `The next run, at ${clockTime(cell.at)}`
    case 'later':
      return `The next run, after this calendar: ${new Date(cell.at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
    case 'paused':
      return since ? `Paused since ${since}` : 'Paused'
    case 'empty':
      return 'No run'
  }
}

// ─── The trigger, as parts ───

export interface TriggerPart {
  value: string
  label: string
  /** `*`: every value, drawn quiet. */
  isEvery: boolean
}

const CRON_LABELS = ['minute', 'hour', 'day', 'month', 'weekday'] as const

/**
 * The parts of a trigger, large: the five fields of a cron expression, or
 * the period of an interval. A six-field expression has seconds first; they
 * are left out, as a schedule does not run more than once a minute.
 */
export function triggerParts(trigger: AppScheduleTrigger): TriggerPart[] {
  if (trigger.type === 'interval') {
    const minutes = trigger.everyMinutes
    const [value, label] = minutes % 1440 === 0 ? [minutes / 1440, minutes === 1440 ? 'day' : 'days'] : minutes % 60 === 0 ? [minutes / 60, minutes === 60 ? 'hour' : 'hours'] : [minutes, minutes === 1 ? 'minute' : 'minutes']
    return [{ value: String(value), label: String(label), isEvery: false }]
  }
  const fields = trigger.expr.trim().split(/\s+/)
  const five = fields.length === 6 ? fields.slice(1) : fields.slice(0, 5)
  return five.map((value, index) => ({ value, label: CRON_LABELS[index] ?? '', isEvery: value === '*' }))
}

/** "Every Monday at 9:00 AM, host time": the plain words of the trigger and its clock. */
export function triggerClockText(summary: string, trigger: AppScheduleTrigger): string {
  if (trigger.type === 'interval') return summary
  return `${summary}, ${trigger.timezone ? trigger.timezone : 'host time'}`
}

/** "Mon, Nov 16" and "09:00": one row of the next runs. */
export function upcomingRow(at: number) {
  return { day: new Date(at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }), time: clockTime(at) }
}
