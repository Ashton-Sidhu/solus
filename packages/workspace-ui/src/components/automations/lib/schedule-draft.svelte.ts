import { Cron } from 'croner'
import type { AutomationTrigger } from '@solus/contracts/types'
import {
  type BuilderTriggerKind,
  builderKindFor,
  cronHHMM,
  cronMonthDay,
  cronWeekday,
  dailyCron,
  weeklyCron,
  monthlyCron,
  intervalParts,
  INTERVAL_UNIT_MINUTES,
  toLocalInputValue,
} from './automation-format'

/** The next `count` fire instants of a draft trigger, for the builder's schedule
 *  preview. Returns null for an invalid cron expression (doubling as instant
 *  client-side validation), and [] for triggers with nothing to preview
 *  (manual, or a one-time instant that already passed). */
export function nextOccurrences(trigger: AutomationTrigger, count: number, from = new Date()): Date[] | null {
  switch (trigger.type) {
    case 'manual':
      return []
    case 'once': {
      const at = Date.parse(trigger.runAt)
      return Number.isFinite(at) && at > from.getTime() ? [new Date(at)] : []
    }
    case 'interval': {
      const ms = Math.max(1, Math.floor(trigger.everyMinutes)) * 60_000
      return Array.from({ length: count }, (_, i) => new Date(from.getTime() + (i + 1) * ms))
    }
    case 'cron': {
      try {
        return new Cron(trigger.expr).nextRuns(count, from)
      } catch {
        return null
      }
    }
  }
}

/** The editable schedule behind the detail view's Schedule block.
 *
 *  One field per preset, all live at once: flipping Daily → Weekly → Daily keeps
 *  the time you set instead of resetting it. `kind` decides which fields the
 *  rail shows and which ones `build()` reads. */
export class ScheduleDraft {
  kind = $state<BuilderTriggerKind>('manual')
  /** "HH:MM", 24h — shared by the daily / weekly / monthly presets. */
  time = $state('09:00')
  weekday = $state(1)
  monthDay = $state(1)
  intervalValue = $state(1)
  intervalUnit = $state<'minutes' | 'hours' | 'days'>('hours')
  cronExpr = $state('0 9 * * *')
  /** datetime-local value for the one-off "Once" preset. */
  onceLocal = $state(toLocalInputValue(undefined))
  /** Whether a recurring schedule stops on a date. */
  hasEnd = $state(false)
  /** datetime-local value for the schedule's end; a month out until one is picked. */
  endsLocal = $state(toLocalInputValue(new Date(Date.now() + 30 * 86_400_000).toISOString()))

  constructor(trigger?: AutomationTrigger) {
    if (!trigger) return
    this.kind = builderKindFor(trigger)
    if (trigger.type === 'cron') {
      this.time = cronHHMM(trigger.expr)
      this.weekday = cronWeekday(trigger.expr)
      this.monthDay = cronMonthDay(trigger.expr)
      this.cronExpr = trigger.expr
    } else if (trigger.type === 'interval') {
      const { value, unit } = intervalParts(trigger.everyMinutes)
      this.intervalValue = value
      this.intervalUnit = unit
    } else if (trigger.type === 'once') {
      this.onceLocal = toLocalInputValue(trigger.runAt)
    }
    if ('endsAt' in trigger && trigger.endsAt) {
      this.hasEnd = true
      this.endsLocal = toLocalInputValue(trigger.endsAt)
    }
  }

  /** Only a schedule that repeats has an end. */
  readonly repeats = $derived(this.kind !== 'manual' && this.kind !== 'once')

  /** The end is already behind us, so the schedule will not fire again. */
  readonly endPassed = $derived(this.repeats && this.hasEnd && Date.parse(this.endsLocal) <= Date.now())

  /** The raw-expression escape hatch holds something that will never fire.
   *  Flagged as you type, so a typo never reaches the scheduler silently. */
  readonly cronInvalid = $derived(
    this.kind === 'cron' &&
      this.cronExpr.trim() !== '' &&
      nextOccurrences({ type: 'cron', expr: this.cronExpr.trim() }, 1) === null,
  )

  /** Compile the live fields into a storable trigger, or the reason they don't
   *  make one yet. */
  build(): AutomationTrigger | { error: string } {
    const trigger = this.buildRepeat()
    if ('error' in trigger || !this.hasEnd || (trigger.type !== 'interval' && trigger.type !== 'cron')) return trigger
    const ms = Date.parse(this.endsLocal)
    if (!Number.isFinite(ms)) return { error: 'Pick a valid end date and time.' }
    return { ...trigger, endsAt: new Date(ms).toISOString() }
  }

  private buildRepeat(): AutomationTrigger | { error: string } {
    const [h, m] = this.time.split(':').map(Number)
    const hh = Number.isFinite(h) ? h : 9
    const mm = Number.isFinite(m) ? m : 0
    switch (this.kind) {
      case 'manual':
        return { type: 'manual' }
      case 'once': {
        const ms = Date.parse(this.onceLocal)
        if (!Number.isFinite(ms)) return { error: 'Pick a valid date and time.' }
        return { type: 'once', runAt: new Date(ms).toISOString() }
      }
      case 'interval': {
        const everyMinutes = Math.round(this.intervalValue) * INTERVAL_UNIT_MINUTES[this.intervalUnit]
        if (!Number.isFinite(everyMinutes) || everyMinutes < 1)
          return { error: 'Interval must be at least 1 minute.' }
        return { type: 'interval', everyMinutes }
      }
      case 'daily':
        return { type: 'cron', expr: dailyCron(hh, mm) }
      case 'weekly':
        return { type: 'cron', expr: weeklyCron(hh, mm, this.weekday) }
      case 'monthly':
        return { type: 'cron', expr: monthlyCron(hh, mm, this.monthDay) }
      case 'cron': {
        const expr = this.cronExpr.trim()
        if (!expr) return { error: 'Enter a cron expression.' }
        if (nextOccurrences({ type: 'cron', expr }, 1) === null)
          return { error: `Invalid cron expression: "${expr}".` }
        return { type: 'cron', expr }
      }
    }
  }
}
