import { Cron } from 'croner'
import { SOLUS_WORKTREE_DIR, type AutomationRun, type AutomationTrigger, type AutomationRunStatus } from '../../../../shared/types'

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

/** Clock time as "8:00 AM". Pinned to en-US rather than the system locale: these
 *  times are read inside hardcoded English sentences ("Daily at …", "Mondays at
 *  …"), and a locale that renders "8:00 a.m." makes the sentence read as two
 *  voices at once. */
export function clockTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function timeLabel(hh: number, mm: number): string {
  const d = new Date()
  d.setHours(hh, mm, 0, 0)
  return clockTime(d)
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
    const day = WEEKDAYS.find((w) => w.value === Number(f.dow))?.label
    // "Mondays at 8:00 AM" — the plural already says weekly, so "Weekly on
    // Monday" only adds a word.
    return day ? `${day}s at ${t}` : `Weekly at ${t}`
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
        : `Once on ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${clockTime(d)}`
    }
    case 'interval':
      return `Every ${intervalLabel(trigger.everyMinutes)}`
    case 'cron':
      return cronSummary(trigger.expr)
  }
}

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

/** Whole calendar days from today to `d` — 0 today, 1 tomorrow, -1 yesterday. */
function dayOffset(d: Date, nowMs: number): number {
  const now = new Date(nowMs)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return Math.round((startOfDay - startOfToday) / 86_400_000)
}

/** Absolute, human-friendly instant for the detail view's Status block, e.g.
 *  "Today at 10:28 PM", "Tomorrow at 9:00 AM", "Friday at 2:27 AM", "Mar 4 at …".
 *  Used where relativeTime reads too vaguely (next/last run timestamps).
 *  `nowMs` is injectable so callers on a ticker re-derive as time passes. */
export function absoluteTime(iso: string | undefined, nowMs = Date.now()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const time = clockTime(d)
  const dayDiff = dayOffset(d, nowMs)
  if (dayDiff === 0) return `Today at ${time}`
  if (dayDiff === 1) return `Tomorrow at ${time}`
  if (dayDiff === -1) return `Yesterday at ${time}`
  if (dayDiff > 1 && dayDiff < 7) return `${d.toLocaleDateString([], { weekday: 'long' })} at ${time}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`
}

/** The calendar day of an instant on its own — "Today", "Yesterday", "Friday",
 *  "Jul 21". For lines that pair a day with an outcome ("Yesterday · finished in
 *  23s"), where the clock time would crowd the sentence out. */
export function dayLabel(iso: string | undefined, nowMs = Date.now()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const dayDiff = dayOffset(d, nowMs)
  if (dayDiff === 0) return 'Today'
  if (dayDiff === 1) return 'Tomorrow'
  if (dayDiff === -1) return 'Yesterday'
  if (dayDiff < 0 && dayDiff > -7) return d.toLocaleDateString([], { weekday: 'long' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Time left until a future instant, as a compact two-unit countdown: "4h 12m",
 *  "12m", "2d 3h". Empty once the instant has passed — a countdown that has run
 *  out is not news, the next scheduled time is. */
export function countdown(iso: string | undefined, nowMs = Date.now()): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const mins = Math.floor((t - nowMs) / 60_000)
  if (mins < 0) return ''
  if (mins < 1) return 'under a minute'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
}

/** Compact calendar date a run started on, e.g. "Jun 25". Empty for a bad date. */
export function runDate(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Wall-clock milliseconds a finished run took, or null while it's still in
 *  flight (or its timestamps don't make sense). */
export function runDurationMs(run: { startedAt: string; finishedAt?: string }): number | null {
  if (!run.finishedAt) return null
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

/** Compact wall-clock duration of a finished run, e.g. "45s", "3m", "1h 2m".
 *  Empty while the run is still in flight (no finishedAt). */
export function runDuration(run: { startedAt: string; finishedAt?: string }): string {
  const ms = runDurationMs(run)
  if (ms === null) return ''
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem ? `${hrs}h ${rem}m` : `${hrs}h`
}

/** Relative time for both past (last run) and future (next run). `nowMs` is
 *  injectable so callers on a ticker re-derive as time passes. */
export function relativeTime(iso: string | undefined, nowMs = Date.now()): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const diff = t - nowMs
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
export interface IntervalParts {
  value: number
  unit: 'minutes' | 'hours' | 'days'
}

export function intervalParts(everyMinutes: number): IntervalParts {
  if (everyMinutes % 1440 === 0) return { value: everyMinutes / 1440, unit: 'days' }
  if (everyMinutes % 60 === 0) return { value: everyMinutes / 60, unit: 'hours' }
  return { value: everyMinutes, unit: 'minutes' }
}

export const INTERVAL_UNIT_MINUTES = {
  minutes: 1,
  hours: 60,
  days: 1440,
} satisfies Record<IntervalParts['unit'], number>

/** One bar of the detail view's health sparkline: how long that run took
 *  relative to the longest in the window, plus the two states it's coloured by. */
export type HealthBar = { id: string; heightPct: number; failed: boolean; latest: boolean }

export interface RunHealth {
  bars: HealthBar[]
  clean: number
  total: number
}

/** How many runs the sparkline looks back over — wide enough to show a rhythm,
 *  narrow enough that one bad run still reads as one bad run. */
const HEALTH_WINDOW = 17
/** A run that did what it was asked. `dispatched` counts: the chat thread it was
 *  handed to owns the outcome from there. */
const CLEAN_STATUSES: AutomationRunStatus[] = ['succeeded', 'dispatched']

/** The recent runs as a duration sparkline (oldest → newest) plus how many of
 *  them came back clean — the automation's reliability at a glance. `runs` is
 *  newest-first, the order the store keeps them in. */
export function runHealth(runs: AutomationRun[]): RunHealth {
  const recent = runs.slice(0, HEALTH_WINDOW).reverse()
  const longest = recent.reduce((max, r) => Math.max(max, runDurationMs(r) ?? 0), 0)
  return {
    bars: recent.map((r, i) => ({
      id: r.id,
      // Floored so a sub-second run still reads as a bar rather than a gap.
      heightPct: Math.max(18, longest > 0 ? Math.round(((runDurationMs(r) ?? 0) / longest) * 100) : 18),
      failed: r.status === 'failed',
      latest: i === recent.length - 1,
    })),
    clean: recent.filter((r) => CLEAN_STATUSES.includes(r.status)).length,
    total: recent.length,
  }
}

export interface RunStatusMeta {
  label: string
  tone: 'running' | 'success' | 'error' | 'cancelled'
}

export const RUN_STATUS_META = {
  running: { label: 'Running', tone: 'running' },
  succeeded: { label: 'Succeeded', tone: 'success' },
  failed: { label: 'Failed', tone: 'error' },
  cancelled: { label: 'Cancelled', tone: 'cancelled' },
  // In-session runs: handed to the chat thread, which owns the real outcome.
  dispatched: { label: 'Sent to chat', tone: 'success' },
} satisfies Record<AutomationRunStatus, RunStatusMeta>

/** The folder an automation runs in, as the trailing path segment — the list
 *  row's secondary label, and what the page's search matches against. */
export function folderLabel(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

/** Resolve the provider transcript directory for an automation run. Older run
 *  records only stored the branch, so retain the worktree manager's deterministic
 *  path convention as a compatibility fallback. */
export function automationRunCwd(run: AutomationRun, automationCwd: string, homePath?: string): string {
  if (run.worktreePath) return run.worktreePath
  if (!run.branch) return automationCwd

  const expandedCwd = automationCwd === '~'
    ? homePath ?? automationCwd
    : automationCwd.startsWith('~/') && homePath
      ? `${homePath}/${automationCwd.slice(2)}`
      : automationCwd
  return `${expandedCwd.replace(/\/$/, '')}/${SOLUS_WORKTREE_DIR}/${run.branch.replace(/\//g, '-')}`
}
