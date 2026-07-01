import type { AutomationTrigger, AutomationRunStatus } from '../../../../shared/types'

// Pure formatting + trigger <-> builder-preset mapping for the Automations UI.
// Kept out of the .svelte files so the cron math and human summaries are easy to
// read and reuse across the list, the builder, and the run views.

/** The trigger kinds the builder form offers. `daily`/`weekly`/`monthly` are
 *  ergonomic presets that compile down to a `cron` AutomationTrigger; `cron` is
 *  the raw-expression escape hatch for power users. */
export type BuilderTriggerKind = 'manual' | 'once' | 'interval' | 'daily' | 'weekly' | 'monthly' | 'cron'

export const WEEKDAYS: { value: number; label: string; short: string }[] = [
  { value: 1, label: 'Monday', short: 'Mon' },
  { value: 2, label: 'Tuesday', short: 'Tue' },
  { value: 3, label: 'Wednesday', short: 'Wed' },
  { value: 4, label: 'Thursday', short: 'Thu' },
  { value: 5, label: 'Friday', short: 'Fri' },
  { value: 6, label: 'Saturday', short: 'Sat' },
  { value: 0, label: 'Sunday', short: 'Sun' },
]

export function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

// ── Preset → cron expression (5-field: min hour dom month dow) ──
export function dailyCron(hh: number, mm: number): string {
  return `${mm} ${hh} * * *`
}
export function weeklyCron(hh: number, mm: number, dow: number): string {
  return `${mm} ${hh} * * ${dow}`
}
export function monthlyCron(hh: number, mm: number, dom: number): string {
  return `${mm} ${hh} ${dom} * *`
}

/** Parse a simple `min hour dom month dow` expression into fields, or null if it
 *  isn't the plain 5-number/star shape the presets produce. */
function parseSimpleCron(expr: string): { mm: number; hh: number; dom: string; mon: string; dow: string } | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [mmS, hhS, dom, mon, dow] = parts
  const mm = Number(mmS)
  const hh = Number(hhS)
  if (!Number.isInteger(mm) || !Number.isInteger(hh)) return null
  return { mm, hh, dom, mon, dow }
}

/** Reverse-map a stored trigger to the builder kind so editing re-opens on the
 *  right preset tab (a daily cron shows as "Daily", not raw cron). */
export function builderKindFor(trigger: AutomationTrigger): BuilderTriggerKind {
  if (trigger.type !== 'cron') return trigger.type
  const f = parseSimpleCron(trigger.expr)
  if (!f) return 'cron'
  if (f.mon !== '*') return 'cron'
  const daily = f.dom === '*' && f.dow === '*'
  const weekly = f.dom === '*' && /^[0-6]$/.test(f.dow)
  const monthly = /^([12]?[0-9]|3[01])$/.test(f.dom) && f.dow === '*'
  if (daily) return 'daily'
  if (weekly) return 'weekly'
  if (monthly) return 'monthly'
  return 'cron'
}

/** Extract HH:MM from a cron trigger for pre-filling the builder time field. */
function cronTime(expr: string): { hh: number; mm: number } {
  const f = parseSimpleCron(expr)
  return f ? { hh: f.hh, mm: f.mm } : { hh: 9, mm: 0 }
}
export function cronWeekday(expr: string): number {
  const f = parseSimpleCron(expr)
  return f && /^[0-6]$/.test(f.dow) ? Number(f.dow) : 1
}
export function cronMonthDay(expr: string): number {
  const f = parseSimpleCron(expr)
  return f && /^\d+$/.test(f.dom) ? Number(f.dom) : 1
}

// ── Human-readable summaries ──

function timeLabel(hh: number, mm: number): string {
  const d = new Date()
  d.setHours(hh, mm, 0, 0)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

function intervalLabel(everyMinutes: number): string {
  if (everyMinutes % 1440 === 0) {
    const d = everyMinutes / 1440
    return d === 1 ? 'day' : `${d} days`
  }
  if (everyMinutes % 60 === 0) {
    const h = everyMinutes / 60
    return h === 1 ? 'hour' : `${h} hours`
  }
  return everyMinutes === 1 ? 'minute' : `${everyMinutes} minutes`
}

function cronSummary(expr: string): string {
  const f = parseSimpleCron(expr)
  if (!f || f.mon !== '*') return `Cron · ${expr}`
  const t = timeLabel(f.hh, f.mm)
  if (f.dom === '*' && f.dow === '*') return `Daily at ${t}`
  if (f.dom === '*' && /^[0-6]$/.test(f.dow)) {
    const day = WEEKDAYS.find((w) => w.value === Number(f.dow))?.label ?? 'week'
    return `Weekly on ${day} at ${t}`
  }
  if (/^\d+$/.test(f.dom) && f.dow === '*') return `Monthly on the ${ordinal(Number(f.dom))} at ${t}`
  return `Cron · ${expr}`
}

export function triggerSummary(trigger: AutomationTrigger): string {
  switch (trigger.type) {
    case 'manual':
      return 'Manual'
    case 'once': {
      const d = new Date(trigger.runAt)
      return Number.isNaN(d.getTime())
        ? 'Once'
        : `Once on ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    }
    case 'interval':
      return `Every ${intervalLabel(trigger.everyMinutes)}`
    case 'cron':
      return cronSummary(trigger.expr)
  }
}

/** Absolute, human-friendly instant for the detail view's Status block, e.g.
 *  "Today at 10:28 PM", "Tomorrow at 9:00 AM", "Friday at 2:27 AM", "Mar 4 at …".
 *  Used where relativeTime reads too vaguely (next/last run timestamps). */
export function absoluteTime(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const dayDiff = Math.round((startOfDay - startOfToday) / 86_400_000)
  if (dayDiff === 0) return `Today at ${time}`
  if (dayDiff === 1) return `Tomorrow at ${time}`
  if (dayDiff === -1) return `Yesterday at ${time}`
  if (dayDiff > 1 && dayDiff < 7) return `${d.toLocaleDateString([], { weekday: 'long' })} at ${time}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`
}

/** Compact calendar date a run started on, e.g. "Jun 25". Empty for a bad date. */
export function runDate(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Compact wall-clock duration of a finished run, e.g. "45s", "3m", "1h 2m".
 *  Empty while the run is still in flight (no finishedAt). */
export function runDuration(run: { startedAt: string; finishedAt?: string }): string {
  if (!run.finishedAt) return ''
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem ? `${hrs}h ${rem}m` : `${hrs}h`
}

/** Relative time for both past (last run) and future (next run). */
export function relativeTime(iso: string | undefined): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const diff = t - Date.now()
  const future = diff > 0
  const mins = Math.round(Math.abs(diff) / 60000)
  let body: string
  if (mins < 1) body = 'less than a minute'
  else if (mins < 60) body = `${mins} min`
  else if (mins < 1440) body = `${Math.round(mins / 60)} hr`
  else body = `${Math.round(mins / 1440)} day${Math.round(mins / 1440) === 1 ? '' : 's'}`
  return future ? `in ${body}` : `${body} ago`
}

/** A datetime-local input value (no timezone suffix) for an ISO instant. */
export function toLocalInputValue(iso: string | undefined): string {
  const d = iso ? new Date(iso) : new Date(Date.now() + 60 * 60 * 1000)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "HH:MM" (24h, zero-padded) from a cron trigger, for the builder time field. */
export function cronHHMM(expr: string): string {
  const { hh, mm } = cronTime(expr)
  return `${pad(hh)}:${pad(mm)}`
}

/** Split a minute count into the largest clean {value, unit} for the builder. */
export function intervalParts(everyMinutes: number): { value: number; unit: 'minutes' | 'hours' | 'days' } {
  if (everyMinutes % 1440 === 0) return { value: everyMinutes / 1440, unit: 'days' }
  if (everyMinutes % 60 === 0) return { value: everyMinutes / 60, unit: 'hours' }
  return { value: everyMinutes, unit: 'minutes' }
}

export const INTERVAL_UNIT_MINUTES: Record<'minutes' | 'hours' | 'days', number> = {
  minutes: 1,
  hours: 60,
  days: 1440,
}

export const RUN_STATUS_META: Record<
  AutomationRunStatus,
  { label: string; tone: 'running' | 'success' | 'error' | 'cancelled' }
> = {
  running: { label: 'Running', tone: 'running' },
  succeeded: { label: 'Succeeded', tone: 'success' },
  failed: { label: 'Failed', tone: 'error' },
  cancelled: { label: 'Cancelled', tone: 'cancelled' },
}
