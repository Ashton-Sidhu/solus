// The window every Insights answer is asked in.
//
// One range, two forms. A relative range ("last 24 hours") is the working
// default: it stays true as the clock moves, so a page left open keeps
// describing now. An absolute range pins both edges, which is what an
// investigation needs — the incident happened between two instants, and a
// window that slides away from it is useless.
//
// The range is a value, not a query: it resolves to a pair of epoch
// milliseconds, and every generated query, the histogram, and the NL compile
// instruction read that same pair. Pure and non-reactive.

import { formatDayClock } from './format'

export interface RelativeRange {
  kind: 'relative'
  /** How far back from now, in milliseconds. */
  ms: number
}

export interface AbsoluteRange {
  kind: 'absolute'
  /** Inclusive lower bound on `started_at`, epoch ms. */
  from: number
  /** Exclusive upper bound on `started_at`, epoch ms. */
  to: number
}

export type TimeRange = RelativeRange | AbsoluteRange

/** A range with both edges fixed to instants — what a query and a chart read. */
export interface ResolvedRange {
  from: number
  to: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Milliseconds the explore surface looks back by default. */
export const DEFAULT_WINDOW_MS = DAY

export const DEFAULT_TIME_RANGE: TimeRange = { kind: 'relative', ms: DEFAULT_WINDOW_MS }

/** The relative choices offered in the picker, shortest first. */
export const RELATIVE_CHOICES: Array<{ ms: number; label: string }> = [
  { ms: 15 * MINUTE, label: 'Last 15 minutes' },
  { ms: HOUR, label: 'Last hour' },
  { ms: 6 * HOUR, label: 'Last 6 hours' },
  { ms: DAY, label: 'Last 24 hours' },
  { ms: 7 * DAY, label: 'Last 7 days' },
  { ms: 30 * DAY, label: 'Last 30 days' },
]

export function resolveRange(range: TimeRange, now: number): ResolvedRange {
  if (range.kind === 'absolute') return { from: range.from, to: range.to }
  return { from: now - range.ms, to: now }
}

/** The picker's own label, and the histogram's heading. */
export function rangeLabel(range: TimeRange): string {
  if (range.kind === 'relative') {
    const choice = RELATIVE_CHOICES.find((candidate) => candidate.ms === range.ms)
    return choice ? choice.label : `Last ${formatSpan(range.ms)}`
  }
  return `${formatDayClock(range.from)} → ${formatDayClock(range.to)}`
}

/** The histogram's heading reads as a sentence, so the two forms differ. What
 *  is counted is the answer's own word — turns, tool calls, permission waits. */
export function rangeHeading(range: TimeRange, counted: string): string {
  return range.kind === 'relative'
    ? `${counted} over the ${rangeLabel(range).toLowerCase()}`
    : `${counted} from ${rangeLabel(range)}`
}

function formatSpan(ms: number): string {
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} minutes`
  if (ms < DAY) return `${Math.round(ms / HOUR)} hours`
  return `${Math.round(ms / DAY)} days`
}

/**
 * The `where` fragment a generated query constrains `started_at` with.
 *
 * A relative range compiles to SQLite's own clock rather than a resolved
 * literal, so re-running the same statement an hour later still answers "the
 * last 24 hours". An absolute range compiles to its two literals, because
 * pinned edges are the whole point of choosing them.
 */
export function rangeCondition(range: TimeRange, column = 'started_at'): string {
  if (range.kind === 'relative') {
    return `${column} > (strftime('%s','now') * 1000 - ${Math.round(range.ms)})`
  }
  return `${column} >= ${Math.round(range.from)} and ${column} < ${Math.round(range.to)}`
}

/** What the NL compile is told about the window the user is looking at. The
 *  compiled SQL is always shown, so this constraint is visible, not hidden. */
export function rangeInstruction(range: TimeRange): string {
  return (
    'Unless the question names its own time period, constrain started_at to the '
    + `window the user is viewing: ${rangeCondition(range)}.`
  )
}

/** Local `YYYY-MM-DDTHH:MM`, the value `DateTimePicker` reads and emits. */
export function toLocalInput(epochMs: number): string {
  const at = new Date(epochMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + `T${pad(at.getHours())}:${pad(at.getMinutes())}`
  )
}

/** Parses the picker's local string back to epoch ms; null when incomplete. */
export function fromLocalInput(value: string): number | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/)
  if (!match) return null
  const [, year, month, day, hour, minute] = match
  const at = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute))
  return Number.isNaN(at.getTime()) ? null : at.getTime()
}

/** An absolute range is only applicable while its edges are ordered — an
 *  inverted window returns nothing and reads as "there is no data". */
export function isApplicableAbsolute(from: number | null, to: number | null): boolean {
  return from != null && to != null && to > from
}

export function sameRange(a: TimeRange, b: TimeRange): boolean {
  if (a.kind === 'relative' && b.kind === 'relative') return a.ms === b.ms
  if (a.kind === 'absolute' && b.kind === 'absolute') return a.from === b.from && a.to === b.to
  return false
}

/** Every field a persisted range may claim to carry, before any of it is
 *  believed. Local storage is user-writable and outlives releases. */
interface StoredRange {
  kind?: unknown
  ms?: unknown
  from?: unknown
  to?: unknown
}

/** Rehydrates a persisted range, rejecting anything that is not one. */
export function parseStoredRange(raw: string | null): TimeRange | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!(parsed instanceof Object)) return null
  // SAFETY: every field of StoredRange is `unknown` and is validated below, so
  // the assertion grants no more trust than the JSON value already carries.
  const candidate = parsed as StoredRange
  if (candidate.kind === 'relative') {
    if (!Number.isFinite(candidate.ms)) return null
    const ms = Number(candidate.ms)
    return ms > 0 ? { kind: 'relative', ms } : null
  }
  if (candidate.kind === 'absolute') {
    if (!Number.isFinite(candidate.from) || !Number.isFinite(candidate.to)) return null
    const from = Number(candidate.from)
    const to = Number(candidate.to)
    return isApplicableAbsolute(from, to) ? { kind: 'absolute', from, to } : null
  }
  return null
}
