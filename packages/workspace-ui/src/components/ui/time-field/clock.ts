import { Time } from '@internationalized/date'

/**
 * Every caller stores a clock time as a 24-hour `HH:MM` string — that is what a
 * cron trigger, a `datetime-local` value and a saved schedule all speak. The
 * segmented field speaks `Time`, and may show a 12-hour face with AM/PM, so the
 * conversion lives here and the display format stays a presentation choice.
 */

/** `HH:MM` (or `HH:MM:SS`) → `Time`; `undefined` when the text is not a clock. */
export function parseClock(value: string): Time | undefined {
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim())
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined
  return new Time(hour, minute)
}

/** `Time` → the zero-padded 24-hour `HH:MM` every caller persists. */
export function formatClock(time: Time): string {
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`
}
