/**
 * The elapsed readout on a running row, in the desktop and web session
 * sidebar and the mobile thread list alike. Tabular figures keep the digits from
 * shifting, but only zero-padding keeps the *string* the same width — without
 * it the row jumps every time the clock crosses `9s` into `10s`, which is the
 * one thing a column that sits in peripheral vision all day must not do.
 *
 * Seconds are spent only in the first minute. Past that the row is answering
 * "is this still going, and roughly how long" — a question `12m` answers as
 * well as `12m 07s` does, in four fewer characters of a column that has none
 * to spare. The hour form keeps its minutes because the jump from `1h` to `2h`
 * is otherwise an hour wide.
 */
export function formatElapsed(ms: number): string {
  // A missing start time gives NaN, which reads as no time at all.
  const totalSeconds = Math.max(0, Math.floor(ms / 1000)) || 0
  if (totalSeconds < 60) return `${totalSeconds}s`

  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m`

  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, '0')}m`
}
