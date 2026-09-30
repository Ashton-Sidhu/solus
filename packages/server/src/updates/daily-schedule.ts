/**
 * Wall-clock times in a named time zone, without a date library. A daily job
 * "at 15:00 in New York" moves with daylight saving time, so the UTC instant is
 * found from the zone's offset on that day.
 */

/** What a clock on the wall in the zone reads. `month` counts from 1. */
interface ZonedWallClock { year: number; month: number; day: number; hour: number; minute: number; second: number }

function zonedParts(at: number, timeZone: string): ZonedWallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(at))
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((entry) => entry.type === type)?.value)
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute'), second: part('second') }
}

/** How far the zone's wall clock is ahead of UTC at `at`. */
function zoneOffsetMs(at: number, timeZone: string): number {
  const wall = zonedParts(at, timeZone)
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(at / 1000) * 1000
}

/** `hour`:00 on one calendar day in the zone. A day past the month's end rolls over, as `Date.UTC` does. */
function atZonedHour(year: number, month: number, day: number, hour: number, timeZone: string): number {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour)
  const estimate = wallAsUtc - zoneOffsetMs(wallAsUtc, timeZone)
  return wallAsUtc - zoneOffsetMs(estimate, timeZone)
}

/** The most recent `hour`:00 in the zone at or before `now`. */
export function previousDailyRunAt(now: number, hour: number, timeZone: string): number {
  const today = zonedParts(now, timeZone)
  const run = atZonedHour(today.year, today.month, today.day, hour, timeZone)
  return run <= now ? run : atZonedHour(today.year, today.month, today.day - 1, hour, timeZone)
}

/** The first `hour`:00 in the zone after `now`. */
export function nextDailyRunAt(now: number, hour: number, timeZone: string): number {
  const today = zonedParts(now, timeZone)
  const run = atZonedHour(today.year, today.month, today.day, hour, timeZone)
  return run > now ? run : atZonedHour(today.year, today.month, today.day + 1, hour, timeZone)
}
